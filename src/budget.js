import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { probe } from './probe.js';
import { decodeFrames } from './decode.js';
import {
  getGraySampler, changeScore, createScoreScratch, BLOCK_PX, SAMPLE_W, SAMPLE_H,
} from './score.js';
import { sanitizeVideoName } from './naming.js';
import { resolveCommonOptions } from './prepare.js';
import { ManifestSpool, readSheets } from './manifest.js';
import { SegmentSheetWriter } from './segment-writer.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * 预算模式的默认值。预算以「平均帧率」表示：总帧数 = round(预算 × 区间时长)，
 * 每张图最多 framesPerSheet 帧，图片数由总帧数向上取整得到。
 */
export const BUDGET_DEFAULTS = Object.freeze({
  budgetFps: 15,
  minFps: 1,
  maxFps: 30,
  adaptWindow: 1,
});

/**
 * 预算模式的核心思路：
 *
 * 1. 第一遍解码，按 maxFps 的基准网格记录每个槽「变化最大的一帧」及其得分，
 *    同时统计每个分析窗口的候选槽；这一遍不保留像素，只留数值数组。
 * 2. 把总帧数当作预算，在「每窗口帧数有上下限」的约束下按活动度做平滑分配：
 *    权重取窗口平均活动度的平方根，压缩尖峰片段的影响，再用二分求出全局缩放系数，
 *    使中等变化的片段不会被尖峰片段挤到下限（见 allocateBudget）。
 * 3. 第二遍解码，按第一遍记录的帧号抓取选中的帧，按区段顺序流式拼图。
 *
 * 第一遍与第二遍的槽/帧对应关系由同一份解码时间戳决定，正常输入下完全一致；
 * 第二遍额外保留「槽内第一帧」作为兜底，避免个别 VFR 边界导致空帧。
 */

/**
 * showinfo 的 pts_time 只保留毫秒精度。当源帧率与基准网格同频（例如 30fps 源、30fps 基准）时，
 * 0.1s 这类边界会被打印成 0.099999，floor 后落到前一槽，造成「有的槽两帧、有的槽空」。
 * 给 pts 加半个毫秒的余量即可抵消这种边界抖动；这只影响预算模式的基准槽划分，
 * 第二遍抓帧用同一套映射，两遍结果保持一致。
 */
const PTS_BOUNDARY_EPSILON = 0.0005;

/** 预算模式的基准槽号：与自适应模式相同，额外补偿 pts 的毫秒精度抖动。 */
function baseSlotIndex(pts, maxFps) {
  return Math.max(0, Math.floor((pts + PTS_BOUNDARY_EPSILON) * maxFps + 1e-9));
}

/**
 * 窗口活动度的时间平滑参数。
 *
 * 上升用约 1.2 秒的时间常数，保证画面开始变化时帧率能及时跟上；
 * 下降用约 3.5 秒的时间常数，让变化结束后帧率缓慢回落，而不是突然掉帧。
 * 最后再对最近三个窗口做 [2,1,1] 的前向加权，抹平剩余折角。
 */
const ACTIVITY_ATTACK_SECONDS = 1.2;
const ACTIVITY_RELEASE_SECONDS = 3.5;
const ACTIVITY_TRAILING_WEIGHTS = Object.freeze([2, 1, 1]);

/**
 * 对窗口活动度做时间平滑：上升快、下降慢。
 *
 * 单窗口的活动度抖动（例如短暂停顿、鼠标划过）不会立刻把帧率拉低，
 * 高活动结束后帧率也会在几个窗口内逐渐衰减，避免相邻窗口之间突然跳变。
 *
 * @param {number[]} activities 原始窗口活动度
 * @param {number[]} durations 每个窗口的时长（秒）
 * @returns {number[]} 平滑后的窗口活动度
 */
export function smoothWindowActivity(activities, durations) {
  const envelope = new Array(activities.length);
  for (let index = 0; index < activities.length; index++) {
    if (index === 0) {
      envelope[index] = activities[index];
      continue;
    }
    const previous = envelope[index - 1];
    const rising = activities[index] > previous;
    const timeConstant = rising ? ACTIVITY_ATTACK_SECONDS : ACTIVITY_RELEASE_SECONDS;
    const alpha = 1 - Math.exp(-durations[index] / timeConstant);
    envelope[index] = previous + alpha * (activities[index] - previous);
  }

  // 前向低通：当前窗口带上前两个窗口的余温，进一步减少折角；不使用未来窗口，避免动作提前。
  return envelope.map((value, index) => {
    let sum = 0;
    let weightSum = 0;
    for (let offset = 0; offset < ACTIVITY_TRAILING_WEIGHTS.length; offset++) {
      const source = index - offset;
      if (source < 0) continue;
      sum += envelope[source] * ACTIVITY_TRAILING_WEIGHTS[offset];
      weightSum += ACTIVITY_TRAILING_WEIGHTS[offset];
    }
    return sum / weightSum;
  });
}

/** 创建第一遍扫描用的槽记录；内存只与「时长 × maxFps」有关，与源帧数无关。 */
function createSlotRecords(totalSlots) {
  return {
    // 槽内最高分，既用于分配，也用于选出槽内最佳帧。
    peakScore: new Float32Array(totalSlots),
    // 实际取用的帧得分：默认等于 peakScore；开启 noiseFloor 后可能退回槽中附近一帧。
    pickedScore: new Float32Array(totalSlots),
    globalMAD: new Float32Array(totalSlots),
    pts: new Float64Array(totalSlots),
    frameIndex: new Int32Array(totalSlots).fill(-1),
    candidates: new Uint16Array(totalSlots),
    // 0=peak，1=mid-slot（与固定/自适应模式的 pickedBy 取值含义一致）。
    pickedBy: new Uint8Array(totalSlots),
  };
}

/**
 * 第一遍：逐帧解码、打分，把每个基准槽的最佳帧信息写进定长数组。
 * 不保留任何像素缓冲，因此内存与视频时长成线性但系数很小。
 */
async function scanSlotRecords({
  input, cellWidth, cellHeight, startSec, endSec,
  maxFps, totalSlots, sourceFps, noiseFloor, blockPx,
}) {
  const records = createSlotRecords(totalSlots);
  const sampler = getGraySampler(cellWidth, cellHeight);
  const scoreScratch = createScoreScratch(blockPx);
  const grayBuffers = [new Uint8Array(SAMPLE_W * SAMPLE_H), new Uint8Array(SAMPLE_W * SAMPLE_H)];
  let grayIndex = 0;
  let previousGray = null;
  let ptsBase = null;
  let decoded = 0;

  let currentSlot = -1;
  let slotBest = null;
  let slotMid = null;
  let slotCount = 0;

  /** 结算当前槽：记录最高分帧与「变化地板」回退帧。 */
  const closeSlot = () => {
    if (currentSlot < 0 || currentSlot >= totalSlots || slotCount === 0) return;
    const hasPeak = slotBest && slotBest.score > noiseFloor;
    const picked = hasPeak ? slotBest : (slotMid ?? slotBest);
    records.peakScore[currentSlot] = slotBest ? slotBest.score : 0;
    records.pickedScore[currentSlot] = picked.score;
    records.globalMAD[currentSlot] = picked.globalMAD;
    records.pts[currentSlot] = picked.pts;
    records.frameIndex[currentSlot] = picked.frameIndex;
    records.candidates[currentSlot] = slotCount;
    records.pickedBy[currentSlot] = hasPeak ? 0 : 1;
  };

  for await (const frame of decodeFrames({
    input, cellWidth, cellHeight, start: startSec, end: endSec,
  })) {
    decoded++;
    const index = frame.index;
    // showinfo 的 pts_time 可能是绝对时间也可能是片段相对时间，以第一帧为基准归零。
    if (frame.pts != null && ptsBase === null) ptsBase = frame.pts;
    const pts = frame.pts == null
      ? (sourceFps > 0 ? index / sourceFps : index / maxFps)
      : frame.pts - ptsBase;
    const slotIndex = baseSlotIndex(pts, maxFps);

    if (slotIndex !== currentSlot) {
      closeSlot();
      currentSlot = slotIndex;
      slotBest = null;
      slotMid = null;
      slotCount = 0;
    }

    // 区间之外的尾部帧不参与打分；时间戳单调，后续也不会再回到区间内。
    if (slotIndex < 0 || slotIndex >= totalSlots) continue;

    const currentGray = grayBuffers[grayIndex];
    sampler(frame.buffer, currentGray);
    const change = changeScore(currentGray, previousGray, blockPx, scoreScratch);
    previousGray = currentGray;
    grayIndex ^= 1;

    // 扫描阶段只留数值，不留像素；缓冲区随下一帧自然回收。
    const candidate = {
      pts,
      frameIndex: index,
      score: change.score,
      globalMAD: change.globalMAD,
    };
    if (!slotBest || candidate.score > slotBest.score) slotBest = candidate;
    if (slotCount % 2 === 0) slotMid = candidate;
    slotCount++;
  }

  closeSlot();
  return { records, decoded };
}

/**
 * 按分析窗口聚合候选槽。
 *
 * entries 按槽号（时间）升序保存每个候选槽的得分，后面在每个窗口内均匀铺帧时使用；
 * activity 是窗口平均活动度，先用于时间平滑，再用于预算分配。
 */
function buildWindows(records, totalSlots, windowSlots, slotSec, segmentDuration) {
  const windowCount = Math.max(1, Math.ceil(totalSlots / windowSlots));
  const windows = new Array(windowCount);
  for (let index = 0; index < windowCount; index++) {
    const start = index * windowSlots * slotSec;
    const end = Math.min(segmentDuration, (index + 1) * windowSlots * slotSec);
    windows[index] = {
      start,
      end,
      duration: Math.max(0, end - start),
      entries: [],
      activity: 0,
      candidateCount: 0,
    };
  }

  for (let slot = 0; slot < totalSlots; slot++) {
    if (records.frameIndex[slot] < 0) continue;
    const windowIndex = Math.min(windowCount - 1, Math.floor(slot / windowSlots));
    windows[windowIndex].entries.push({ slot, score: records.peakScore[slot] });
  }

  for (const window of windows) {
    window.candidateCount = window.entries.length;
    window.activity = window.candidateCount
      ? window.entries.reduce((sum, entry) => sum + entry.score, 0) / window.candidateCount
      : 0;
  }
  return windows;
}

/**
 * 固定总帧数的平滑分配。
 *
 * 权重取窗口平均活动度的平方根：先压缩尖峰片段的影响，再按权重做比例分配，
 * 让「变化稍大」的窗口也能拿到与变化相称的帧数，而不是被尖峰窗口挤到下限。
 * 目标等价于最大化 Σ sqrt(activity_i) · log(F_i)，连续最优解满足
 * F_i = clamp(λ · sqrt(activity_i), L_i, U_i)；对 λ 二分即可得到唯一解。
 *
 * @param {object} options
 * @param {Array<{duration:number, activity?:number, candidateCount?:number, scores?:number[]}>} options.windows
 *   每个窗口的候选数、平均活动度（scores 只用于兼容单元测试中的候选数）
 * @param {number} options.totalFrames 预算总帧数（整数）
 * @param {number} options.minFps 每窗口下限帧率
 * @param {number} options.maxFps 每窗口上限帧率
 * @returns {{counts:number[], lower:number[], upper:number[], lambda:number}}
 *   每个窗口应取的帧数、窗口帧数上下限与求得的缩放系数
 */
export function allocateBudget({ windows, totalFrames, minFps, maxFps }) {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) {
    throw new Error(`总帧数应为非负整数，收到：${totalFrames}`);
  }

  const lower = new Array(windows.length);
  const upper = new Array(windows.length);
  let lowerTotal = 0;
  let upperTotal = 0;
  let durationTotal = 0;

  for (let index = 0; index < windows.length; index++) {
    const window = windows[index];
    const candidates = window.candidateCount ?? window.scores?.length ?? 0;
    durationTotal += window.duration;
    // 用 floor 而不是 ceil：不足一个完整窗口的尾段不应被硬凑出一帧。
    const low = Math.min(candidates, Math.max(0, Math.floor(minFps * window.duration + 1e-9)));
    const high = Math.min(candidates, Math.max(low, Math.floor(maxFps * window.duration + 1e-9)));
    lower[index] = low;
    upper[index] = high;
    lowerTotal += low;
    upperTotal += high;
  }

  if (totalFrames > upperTotal) {
    const reachableFps = durationTotal > 0 ? upperTotal / durationTotal : 0;
    throw new Error(
      `预算 ${totalFrames} 帧超过可达上限 ${upperTotal} 帧（平均 ${reachableFps.toFixed(2)} fps）。` +
      '请降低 --budget-fps、提高 --max-fps 或缩短截取区间'
    );
  }
  if (totalFrames < lowerTotal) {
    const requiredFps = durationTotal > 0 ? lowerTotal / durationTotal : 0;
    throw new Error(
      `预算 ${totalFrames} 帧低于分配下限 ${lowerTotal} 帧（平均 ${requiredFps.toFixed(2)} fps）。` +
      '请提高 --budget-fps 或降低 --min-fps'
    );
  }

  // 窗口活动度 -> 分配权重；平方根压缩尖峰，避免少数剧烈变化窗口吃掉全部预算。
  // 指数 0.5 是平滑程度的核心：越小越照顾中等变化片段，越大越接近按原始活动度比例分配。
  const ACTIVITY_WEIGHT_EXPONENT = 0.5;
  const weights = windows.map((window) => {
    const activity = window.activity ?? (window.scores.length
      ? window.scores.reduce((sum, score) => sum + score, 0) / window.scores.length
      : 0);
    return activity > 0 ? Math.pow(activity, ACTIVITY_WEIGHT_EXPONENT) : 0;
  });
  // 全片完全静止时权重全为 0，退化为按窗口时长等权分配。
  const flat = weights.every((weight) => weight === 0);
  const effectiveWeights = flat
    ? windows.map((window) => (window.duration > 0 ? 1 : 0))
    : weights;

  /** λ 对应的实数配额总和；λ 增大时总和单调不减。 */
  const quotaAt = (lambda) => windows.reduce((sum, window, index) => (
    sum + Math.min(upper[index], Math.max(lower[index], lambda * effectiveWeights[index]))
  ), 0);

  let lambda = 0;
  if (quotaAt(0) < totalFrames) {
    let high = 1;
    while (quotaAt(high) < totalFrames && high < 1e12) high *= 2;
    let low = 0;
    for (let step = 0; step < 80; step++) {
      const middle = (low + high) / 2;
      if (quotaAt(middle) < totalFrames) low = middle;
      else high = middle;
    }
    lambda = high;
  }

  const quotas = windows.map((window, index) => Math.min(
    upper[index],
    Math.max(lower[index], lambda * effectiveWeights[index]),
  ));

  // 实数配额向下取整，再按小数部分从大到小补足，保证总帧数精确等于预算。
  const counts = quotas.map((quota) => Math.floor(quota + 1e-9));
  let remaining = totalFrames - counts.reduce((sum, count) => sum + count, 0);
  if (remaining > 0) {
    const order = quotas
      .map((quota, index) => ({ index, fraction: quota - Math.floor(quota) }))
      .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));
    for (const item of order) {
      if (remaining <= 0) break;
      if (counts[item.index] < upper[item.index]) {
        counts[item.index]++;
        remaining--;
      }
    }
  }
  if (remaining !== 0) throw new Error('预算分配失败：整数取整后仍有余量');

  return { counts, lower, upper, lambda };
}

/**
 * 把每个窗口分到的帧均匀铺到窗口内，再拼成连续区段。
 *
 * 窗口按帧数切成等长子段，每段取段内得分最高的候选帧；这样窗口内的实际播放帧率
 * 就是分到的帧数，不会出现「几帧挤在开头、后半段停住」的突发感。
 * 区段首尾相接覆盖整个区间；没有候选帧的窗口留下空洞，由前一段延伸过去。
 */
function planSegments({ records, windows, counts, segmentDuration }) {
  const segments = [];

  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    const window = windows[windowIndex];
    const count = counts[windowIndex];
    if (count <= 0) continue;
    const candidates = window.entries;

    for (let part = 0; part < count; part++) {
      const from = Math.floor((part * candidates.length) / count);
      const to = Math.floor(((part + 1) * candidates.length) / count);
      let picked = candidates[from];
      for (let index = from + 1; index < to; index++) {
        if (candidates[index].score > picked.score) picked = candidates[index];
      }
      segments.push({
        slot: segments.length,
        baseSlot: picked.slot,
        start: window.start + (window.duration * part) / count,
        end: window.start + (window.duration * (part + 1)) / count,
        empty: false,
        reason: null,
        pts: records.pts[picked.slot],
        frameIndex: records.frameIndex[picked.slot],
        score: Number(records.pickedScore[picked.slot].toFixed(3)),
        globalMAD: Number(records.globalMAD[picked.slot].toFixed(3)),
        candidates: records.candidates[picked.slot],
        pickedBy: records.pickedBy[picked.slot] === 0 ? 'peak' : 'mid-slot',
        buffer: null,
        window: windowIndex,
        windowFps: window.duration > 0 ? count / window.duration : 0,
      });
    }
  }

  // 没有候选帧的窗口会留下时间空洞：让前一段延伸过去，保持区段首尾相接。
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor + 1e-9) segment.start = cursor;
    cursor = segment.end;
  }
  if (segments.length) {
    segments[0].start = 0;
    if (segmentDuration > cursor) segments[segments.length - 1].end = segmentDuration;
  }
  return segments;
}

/** 预算模式参数校验；报错文案与 CLI 保持一致。 */
function validateBudgetOptions({ budgetFps, minFps, maxFps, adaptWindow }) {
  const int = (value, name, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} 应为 ${min}-${max} 的整数，收到：${value}`);
    }
  };
  int(budgetFps, '--budget-fps', 1, 240);
  int(minFps, '--min-fps', 1, 240);
  int(maxFps, '--max-fps', 1, 240);
  if (minFps > maxFps) throw new Error('--min-fps 不能大于 --max-fps');
  if (budgetFps < minFps) throw new Error('--budget-fps 不能小于 --min-fps');
  if (budgetFps > maxFps) throw new Error('--budget-fps 不能大于 --max-fps');
  if (!Number.isFinite(adaptWindow) || adaptWindow <= 0 || adaptWindow > 10) {
    throw new Error(`--adapt-window 应为 0-10 之间的正数，收到：${adaptWindow}`);
  }
}

/**
 * 第二遍解码：按第一遍记录的帧号抓取选中的帧，并按区段顺序交给写队列。
 *
 * 每段只保留一帧像素；当解码越过某段的槽且没有等到目标帧号时，退回该槽第一帧，
 * 保证区段不会因为个别时间戳差异变成空帧。选择阶段与抓取阶段都用「第一帧 pts 归零」
 * 的同一套时间基准，正常情况下目标帧号一定命中。
 */
async function captureSegments({
  input, cellWidth, cellHeight, startSec, endSec,
  maxFps, sourceFps, segments, writer,
}) {
  let next = 0;
  let ptsBase = null;

  /** 结算第 index 段：优先用目标帧，其次用槽内第一帧，两者都没有才记空帧。 */
  const settle = async (index) => {
    const segment = segments[index];
    const buffer = segment.buffer ?? segment.fallbackBuffer ?? null;
    segment.buffer = buffer;
    segment.fallbackBuffer = null;
    segment.empty = !buffer;
    segment.reason = buffer ? null : 'no-frame';
    await writer.addCell(segment);
  };

  for await (const frame of decodeFrames({
    input, cellWidth, cellHeight, start: startSec, end: endSec,
  })) {
    if (frame.pts != null && ptsBase === null) ptsBase = frame.pts;
    const pts = frame.pts == null
      ? (sourceFps > 0 ? frame.index / sourceFps : frame.index / maxFps)
      : frame.pts - ptsBase;
    const slot = baseSlotIndex(pts, maxFps);

    // 解码越过某段的槽后，该段不会再有候选帧，先结算掉。
    while (next < segments.length && slot > segments[next].baseSlot) {
      await settle(next);
      next++;
    }
    if (next >= segments.length) continue;

    const segment = segments[next];
    // 命中目标帧号就定稿；先到的同槽帧暂存为兜底，目标帧到达后释放。
    if (slot === segment.baseSlot && !segment.buffer) {
      if (frame.index === segment.frameIndex) {
        segment.buffer = frame.buffer;
        segment.fallbackBuffer = null;
      } else if (!segment.fallbackBuffer) {
        segment.fallbackBuffer = frame.buffer;
      }
    }
  }

  while (next < segments.length) {
    await settle(next);
    next++;
  }
}

/** 预算模式入口：两遍解码 + 平滑分配 + 流式拼图。 */
export async function runBudget(options) {
  const {
    input, outDir,
    cellWidth, cellHeight, layout, format, quality,
    annotate = true, gap = 4,
    stampPos = 'tl', stampDir = 'h-lr',
    budgetFps = BUDGET_DEFAULTS.budgetFps,
    minFps = BUDGET_DEFAULTS.minFps,
    maxFps = BUDGET_DEFAULTS.maxFps,
    adaptWindow = BUDGET_DEFAULTS.adaptWindow,
    noiseFloor = 0, blockPx = BLOCK_PX,
    dryRun = false, quiet = false,
  } = options;

  validateBudgetOptions({ budgetFps, minFps, maxFps, adaptWindow });
  const { ext, layoutCells, perSheet, startSec, endSec } = resolveCommonOptions(options);

  const info = await probe(input);
  const segmentDuration = endSec != null ? endSec - startSec : Math.max(info.duration - startSec, 0);
  if (!(segmentDuration > 0)) throw new Error('截取区间为空，无法抽帧');

  const slotSec = 1 / maxFps;
  const totalSlots = Math.max(1, Math.ceil(segmentDuration / slotSec - 1e-9));
  const windowSlots = Math.max(1, Math.round(adaptWindow * maxFps));
  const sourceFps = info.avgFrameRate > 0 ? info.avgFrameRate : info.rFrameRate;
  const totalFrames = Math.max(1, Math.round(budgetFps * segmentDuration));

  // 第一遍：只扫描活动度，不保留像素。
  const { records, decoded } = await scanSlotRecords({
    input, cellWidth, cellHeight, startSec, endSec,
    maxFps, totalSlots, sourceFps, noiseFloor, blockPx,
  });
  const windows = buildWindows(records, totalSlots, windowSlots, slotSec, segmentDuration);

  // 先对窗口活动度做时间平滑，再按平滑结果分配，避免相邻窗口帧率突变。
  const smoothedActivities = smoothWindowActivity(
    windows.map((window) => window.activity),
    windows.map((window) => window.duration),
  );
  for (let index = 0; index < windows.length; index++) {
    windows[index].activity = smoothedActivities[index];
  }

  const { counts } = allocateBudget({ windows, totalFrames, minFps, maxFps });
  const segments = planSegments({ records, windows, counts, segmentDuration });
  const plannedSheets = Math.ceil(segments.length / perSheet);

  if (!quiet) {
    console.log(
      `[预算] 分配完成：${segments.length} 帧 / ${plannedSheets} 张图，` +
      `平均 ${(segments.length / segmentDuration).toFixed(2)} fps（预算 ${budgetFps} fps）`
    );
  }

  await mkdir(outDir, { recursive: true });
  const manifest = new ManifestSpool({ outDir });
  const manifestPath = manifest.manifestPath;

  const writer = new SegmentSheetWriter({
    perSheet,
    startSec, videoName: sanitizeVideoName(input),
    quality, layout, ext,
    cellWidth, cellHeight, format: ext,
    annotate, gap, stampPos, stampDir,
    outDir, dryRun, quiet, manifest,
  });

  try {
    if (dryRun) {
      for (const segment of segments) await writer.addCell(segment);
    } else {
      await captureSegments({
        input, cellWidth, cellHeight, startSec, endSec,
        maxFps, sourceFps, segments, writer,
      });
    }
    await writer.finish();

    const meta = {
      tool: 'video-peak-frames',
      version: pkg.version,
      input: path.resolve(input),
      generatedAt: new Date().toISOString(),
      range: { start: startSec, end: endSec ?? startSec + segmentDuration },
      fileNamePattern: `${sanitizeVideoName(input)}__t<起s>-<止s>__q<质量>__<排版>__<序号>.${ext}`,
      params: {
        mode: 'budget',
        budgetFps,
        budgetFrames: totalFrames,
        minFps, maxFps,
        framesPerSheet: perSheet,
        slotSeconds: slotSec,
        baseSlotSeconds: slotSec,
        baseSlotFps: maxFps,
        adaptWindow, windowSlots,
        allocator: 'smoothed-sqrt-activity-proportional',
        activityWeightExponent: 0.5,
        activityAttackSeconds: ACTIVITY_ATTACK_SECONDS,
        activityReleaseSeconds: ACTIVITY_RELEASE_SECONDS,
        activityTrailingWeights: ACTIVITY_TRAILING_WEIGHTS,
        layout, layoutCells, cell: [cellWidth, cellHeight],
        format: ext, quality,
        annotate, stampPos, stampDir,
        metric: 'local-peak', blockPx, sample: [SAMPLE_W, SAMPLE_H], noiseFloor,
      },
      source: {
        width: info.width, height: info.height,
        duration: info.duration,
        segmentDuration: Number(segmentDuration.toFixed(4)),
        rFrameRate: Number(info.rFrameRate.toFixed(4)),
        avgFrameRate: Number(info.avgFrameRate.toFixed(4)),
        decodedFrames: decoded,
        ptsFrameCount: decoded,
        ptsSource: 'showinfo',
      },
      summary: {
        slots: segments.length,
        sheets: writer.sheets,
        windows: windows.length,
        avgFps: segmentDuration > 0 ? Number((segments.length / segmentDuration).toFixed(3)) : 0,
        filledSlots: writer.filledSlots,
        emptySlots: writer.emptySlots,
        emptyReasons: {
          'no-frame': writer.emptyNoFrame,
          'beyond-duration': 0,
        },
      },
    };

    await manifest.finish(meta);

    return {
      tool: meta.tool,
      version: meta.version,
      input: meta.input,
      generatedAt: meta.generatedAt,
      range: meta.range,
      fileNamePattern: meta.fileNamePattern,
      params: meta.params,
      source: meta.source,
      summary: meta.summary,
      get sheets() {
        return readSheets(manifestPath);
      },
    };
  } catch (error) {
    await manifest.abort();
    throw error;
  }
}
