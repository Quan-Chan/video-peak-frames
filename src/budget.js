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
 * 2. 把总帧数当作预算，在「每窗口帧数有上下限」的约束下做全局最优分配：
 *    每个窗口的候选帧按得分降序排列，边际收益递减，用最大堆每次取全局最大的
 *    下一帧边际收益，即可得到「选中帧得分总和最大」的解（见 allocateBudget）。
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
 * 按分析窗口聚合候选槽，并把每个窗口的候选槽按 peakScore 降序排列。
 * slots 与 scores 一一对应；分配只需要分数，取帧时需要槽号。
 */
function buildWindows(records, totalSlots, windowSlots, slotSec, segmentDuration) {
  const windowCount = Math.max(1, Math.ceil(totalSlots / windowSlots));
  const windows = new Array(windowCount);
  for (let index = 0; index < windowCount; index++) {
    const start = index * windowSlots * slotSec;
    const end = Math.min(segmentDuration, (index + 1) * windowSlots * slotSec);
    windows[index] = { duration: Math.max(0, end - start), slots: [], scores: [] };
  }

  for (let slot = 0; slot < totalSlots; slot++) {
    if (records.frameIndex[slot] < 0) continue;
    const windowIndex = Math.min(windowCount - 1, Math.floor(slot / windowSlots));
    windows[windowIndex].slots.push(slot);
    windows[windowIndex].scores.push(records.peakScore[slot]);
  }

  for (const window of windows) {
    const order = window.slots.map((_, index) => index);
    order.sort((a, b) => (window.scores[b] - window.scores[a]) || (window.slots[a] - window.slots[b]));
    window.slots = order.map((index) => window.slots[index]);
    window.scores = order.map((index) => window.scores[index]);
  }
  return windows;
}

/** 二叉小顶堆；compare 返回负值时 a 的优先级更高。用于取全局最大边际收益。 */
class PriorityQueue {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[index], items[parent]) >= 0) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[left], items[smallest]) < 0) smallest = left;
        if (right < items.length && this.compare(items[right], items[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * 固定总帧数的最优分配。
 *
 * 每个窗口的候选帧已按得分降序排列，所以「多拿一帧」的边际收益单调递减；
 * 先给每个窗口放满下限，再用最大堆每次取全局最大的边际收益，直到总帧数用完。
 * 该贪心对可分离凹目标是最优的：若把一帧从低边际窗口挪到高边际窗口，总得分只增不减。
 *
 * @param {object} options
 * @param {Array<{duration:number, scores:number[]}>} options.windows 每个窗口的候选得分（降序）
 * @param {number} options.totalFrames 预算总帧数（整数）
 * @param {number} options.minFps 每窗口下限帧率
 * @param {number} options.maxFps 每窗口上限帧率
 * @returns {{counts:number[], lower:number[], upper:number[]}}
 *   每个窗口应取的帧数，以及窗口帧数上下限。
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
    const candidates = window.scores.length;
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

  const counts = lower.slice();
  const queue = new PriorityQueue((a, b) => {
    if (a.score !== b.score) return b.score - a.score; // 边际得分高的先分
    if (a.ratio !== b.ratio) return a.ratio - b.ratio; // 同分时优先补给当前帧率更低的窗口
    return a.window - b.window; // 再按窗口顺序，保证结果确定
  });

  /** 把窗口「下一帧」的边际收益放进堆（已经达到上限的窗口不再参与）。 */
  const pushNext = (index) => {
    if (counts[index] >= upper[index]) return;
    queue.push({
      window: index,
      score: windows[index].scores[counts[index]],
      ratio: counts[index] / windows[index].duration,
    });
  };
  for (let index = 0; index < windows.length; index++) pushNext(index);

  let remaining = totalFrames - lowerTotal;
  while (remaining > 0) {
    const item = queue.pop();
    if (!item) throw new Error('预算分配失败：剩余帧数无法分配');
    counts[item.window]++;
    remaining--;
    pushNext(item.window);
  }

  return { counts, lower, upper };
}

/**
 * 把选中的基准槽翻译成连续区段。
 *
 * 第一段从区间起点开始，之后每段从自身帧所在槽开始，最后一段覆盖到区间终点，
 * 因此所有区段首尾相接、覆盖整个区间；段长就是「这帧要显示多久」。
 */
function planSegments({ records, slots, slotSec, segmentDuration, windows, counts, windowSlots }) {
  return slots.map((baseSlot, index) => {
    const start = index === 0 ? 0 : baseSlot * slotSec;
    const end = index + 1 < slots.length ? slots[index + 1] * slotSec : segmentDuration;
    const windowIndex = Math.min(windows.length - 1, Math.floor(baseSlot / windowSlots));
    return {
      slot: index,
      baseSlot,
      start,
      end,
      empty: false,
      reason: null,
      pts: records.pts[baseSlot],
      frameIndex: records.frameIndex[baseSlot],
      score: Number(records.pickedScore[baseSlot].toFixed(3)),
      globalMAD: Number(records.globalMAD[baseSlot].toFixed(3)),
      candidates: records.candidates[baseSlot],
      pickedBy: records.pickedBy[baseSlot] === 0 ? 'peak' : 'mid-slot',
      buffer: null,
      window: windowIndex,
      windowFps: windows[windowIndex].duration > 0
        ? counts[windowIndex] / windows[windowIndex].duration
        : 0,
    };
  });
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

/** 预算模式入口：两遍解码 + 最优分配 + 流式拼图。 */
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
  const { counts } = allocateBudget({ windows, totalFrames, minFps, maxFps });

  // 每个窗口取分数最高的 counts[w] 个槽，再按时间排序，形成全局帧序列。
  const selectedSlots = [];
  for (let index = 0; index < windows.length; index++) {
    for (let rank = 0; rank < counts[index]; rank++) selectedSlots.push(windows[index].slots[rank]);
  }
  selectedSlots.sort((a, b) => a - b);

  const segments = planSegments({
    records, slots: selectedSlots, slotSec, segmentDuration,
    windows, counts, windowSlots,
  });
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
        allocator: 'marginal-gain-optimal',
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
