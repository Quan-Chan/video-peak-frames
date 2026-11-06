import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { probe } from './probe.js';
import { decodeFrames } from './decode.js';
import { getGraySampler, changeScore, createScoreScratch, BLOCK_PX, SAMPLE_W, SAMPLE_H } from './score.js';
import { slotIndexOf } from './slots.js';
import { SegmentSheetWriter } from './segment-writer.js';
import { sanitizeVideoName } from './naming.js';
import { resolveCommonOptions } from './prepare.js';
import { ManifestSpool, readSheets } from './manifest.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 自适应模式的默认值；CLI 与直接调用共用。 */
export const ADAPTIVE_DEFAULTS = Object.freeze({
  minFps: 2,
  adaptLow: 1,
  adaptHigh: 40,
});

/** 窗口内候选帧缓冲的内存估算上限，防止大格子/高帧率/大窗口撑爆内存。 */
const MAX_WINDOW_BUFFER_MB = 256;

/**
 * 活动度 -> 目标帧率。线性映射到 [minFps, maxFps]，
 * 低于 adaptLow 取下限，高于 adaptHigh 取上限。
 */
export function activityToFps(activity, { minFps, maxFps, adaptLow, adaptHigh }) {
  const span = adaptHigh - adaptLow;
  if (!(span > 0)) return activity >= adaptHigh ? maxFps : minFps;
  const t = Math.min(1, Math.max(0, (activity - adaptLow) / span));
  return minFps + (maxFps - minFps) * t;
}

/**
 * 一个窗口内要抽多少帧：按活动度映射出的帧率乘以窗口时长，再夹到上下限；
 * 同时不超过窗口内实际有帧的基准槽数，也不对低帧率源硬凑帧。
 */
export function windowFrameCount({
  activity, duration, candidateSlots, sourceFps,
  minFps, maxFps, adaptLow, adaptHigh,
}) {
  if (candidateSlots <= 0) return 0;
  const fps = activityToFps(activity, { minFps, maxFps, adaptLow, adaptHigh });
  const lower = Math.max(1, Math.ceil(minFps * duration));
  const upper = Math.max(lower, Math.floor(maxFps * duration));
  let count = Math.min(upper, Math.max(lower, Math.round(fps * duration)));
  if (sourceFps > 0) count = Math.min(count, Math.max(1, Math.round(duration * sourceFps)));
  return Math.max(1, Math.min(count, candidateSlots));
}

/**
 * 把一个窗口切成 count 个连续区段，每段取段内活动度最高的候选帧。
 * candidates 按窗口内局部槽号索引；段内没有候选时输出空帧格（VFR 空洞）。
 * 区段首尾相接，覆盖窗口的 [windowStart, windowEnd)。
 */
export function splitWindowSegments({
  windowIndex, windowFps, windowStart, windowEnd, slotSec, windowSlots, candidates, count,
}) {
  if (count <= 0) {
    return [{
      start: windowStart, end: windowEnd, empty: true, reason: 'no-frame',
      pts: null, frameIndex: null, score: null, globalMAD: null,
      candidates: 0, pickedBy: null, buffer: null,
      window: windowIndex, windowFps,
    }];
  }

  const segments = [];
  for (let s = 0; s < count; s++) {
    const from = Math.floor((s * windowSlots) / count);
    const to = Math.floor(((s + 1) * windowSlots) / count);
    let picked = null;
    for (let i = from; i < to; i++) {
      const candidate = candidates[i];
      if (candidate && (!picked || candidate.activityScore > picked.activityScore)) picked = candidate;
    }
    const start = Math.min(windowStart + from * slotSec, windowEnd);
    const end = Math.min(windowStart + to * slotSec, windowEnd);
    if (picked) {
      segments.push({
        start, end, empty: false, reason: null,
        pts: picked.pts, frameIndex: picked.frameIndex,
        score: picked.score, globalMAD: picked.globalMAD,
        candidates: picked.candidates, pickedBy: picked.pickedBy,
        buffer: picked.buffer,
        window: windowIndex, windowFps,
      });
    } else {
      segments.push({
        start, end, empty: true, reason: 'no-frame',
        pts: null, frameIndex: null, score: null, globalMAD: null,
        candidates: 0, pickedBy: null, buffer: null,
        window: windowIndex, windowFps,
      });
    }
  }
  return segments;
}

function validateAdaptiveOptions({ minFps, maxFps, adaptLow, adaptHigh, cellWidth, cellHeight }) {
  const int = (value, name, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} 应为 ${min}-${max} 的整数，收到：${value}`);
    }
  };
  int(minFps, '--min-fps', 1, 240);
  int(maxFps, '--max-fps', 1, 240);
  if (minFps > maxFps) throw new Error('--min-fps 不能大于 --max-fps');
  if (!Number.isFinite(adaptLow) || !Number.isFinite(adaptHigh) || adaptLow < 0 || adaptHigh <= adaptLow) {
    throw new Error('--adapt-low / --adapt-high 需满足 0 <= low < high');
  }

  // 统计窗口固定为 1 秒：槽率由 --max-fps 决定，窗口槽数就是 maxFps。
  const windowSlots = Math.max(1, maxFps);
  const bufferMB = (windowSlots * 2 * cellWidth * cellHeight * 3) / (1024 * 1024);
  if (bufferMB > MAX_WINDOW_BUFFER_MB) {
    throw new Error(
      `自适应模式需要缓存约 ${bufferMB.toFixed(0)}MB 的窗口帧缓冲（--max-fps ${maxFps}、` +
      `单格 ${cellWidth}x${cellHeight}），超过 ${MAX_WINDOW_BUFFER_MB}MB 上限。` +
      '请调小 --max-fps 或 --cell'
    );
  }
  return windowSlots;
}

export async function runAdaptive(options) {
  const {
    input, outDir,
    cellWidth, cellHeight, layout, format, quality,
    annotate = true, gap = 4,
    stampPos = 'tl', stampDir = 'h-lr',
    slotsPerSecond = 20,
    minFps = ADAPTIVE_DEFAULTS.minFps,
    maxFps = null,
    adaptLow = ADAPTIVE_DEFAULTS.adaptLow,
    adaptHigh = ADAPTIVE_DEFAULTS.adaptHigh,
    noiseFloor = 0, blockPx = BLOCK_PX,
    dryRun = false, quiet = false,
  } = options;

  const { ext, layoutCells, perSheet, startSec, endSec } = resolveCommonOptions(options);
  const upperFps = Math.round(maxFps ?? slotsPerSecond);
  const windowSlotsPerWindow = validateAdaptiveOptions({
    minFps, maxFps: upperFps, adaptLow, adaptHigh, cellWidth, cellHeight,
  });

  const info = await probe(input);
  const segmentDuration = endSec != null ? endSec - startSec : Math.max(info.duration - startSec, 0);
  const slotSec = 1 / upperFps;
  const totalBaseSlots = Math.max(1, Math.ceil(segmentDuration / slotSec - 1e-9));
  const totalWindows = Math.max(1, Math.ceil(totalBaseSlots / windowSlotsPerWindow));
  const sourceFps = info.avgFrameRate > 0 ? info.avgFrameRate : info.rFrameRate;

  await mkdir(outDir, { recursive: true });
  const manifest = new ManifestSpool({ outDir });
  const manifestPath = manifest.manifestPath;

  const graySampler = getGraySampler(cellWidth, cellHeight);
  const scoreScratch = createScoreScratch(blockPx);
  const grayBuffers = [new Uint8Array(SAMPLE_W * SAMPLE_H), new Uint8Array(SAMPLE_W * SAMPLE_H)];
  let grayIndex = 0;
  let previousGray = null;

  let currentSlot = -1;
  let slotBest = null;
  let slotMid = null;
  let slotCount = 0;
  let decoded = 0;
  let ptsBase = null;

  let windowIndex = 0;
  let windowFps = 0;
  let windowCandidates = new Array(windowSlotsPerWindow).fill(null);
  let windowCandidateSlots = 0;
  let windowActivitySum = 0;
  let flushedWindows = 0;
  let cellIndex = 0;

  const windowStartOf = (index) => index * windowSlotsPerWindow * slotSec;
  const windowEndOf = (index) => Math.min(segmentDuration, (index + 1) * windowSlotsPerWindow * slotSec);

  let writer = null;
  try {
    writer = new SegmentSheetWriter({
      perSheet,
      startSec, videoName: sanitizeVideoName(input),
      quality, layout, ext,
      cellWidth, cellHeight, format: ext,
      annotate, gap, stampPos, stampDir,
      outDir, dryRun, quiet, manifest,
    });

    /** 把当前槽的候选结果放进窗口缓冲。 */
    const storeSlot = () => {
      if (currentSlot < 0 || slotCount === 0) return;
      const local = currentSlot - windowIndex * windowSlotsPerWindow;
      if (local < 0 || local >= windowCandidates.length) return;
      const hasPeak = slotBest && slotBest.score > noiseFloor;
      const picked = hasPeak ? slotBest : (slotMid ?? slotBest);
      windowCandidates[local] = {
        slotIndex: currentSlot,
        activityScore: slotBest?.score ?? 0,
        score: Number((slotBest?.score ?? 0).toFixed(3)),
        globalMAD: Number((slotBest?.globalMAD ?? 0).toFixed(3)),
        candidates: slotCount,
        pickedBy: hasPeak ? 'peak' : 'mid-slot',
        pts: picked.pts,
        frameIndex: picked.frameIndex,
        buffer: dryRun ? null : picked.buffer,
      };
      windowCandidateSlots++;
      windowActivitySum += slotBest?.score ?? 0;
    };

    /** 结算当前窗口：按活动度决定帧数，切区段，交给出图队列。 */
    const flushWindow = async () => {
      const start = windowStartOf(windowIndex);
      const end = windowEndOf(windowIndex);
      const duration = Math.max(0, end - start);
      const activity = windowCandidateSlots > 0 ? windowActivitySum / windowCandidateSlots : 0;
      windowFps = 0;

      if (duration > 0) {
        const effectiveSlots = Math.max(1, Math.ceil(duration / slotSec - 1e-9));
        const count = windowFrameCount({
          activity, duration,
          candidateSlots: windowCandidateSlots,
          sourceFps, minFps, maxFps: upperFps, adaptLow, adaptHigh,
        });
        // 实际落到的帧率（可能被源帧率/候选数封顶），写入 manifest 便于核对。
        windowFps = count / duration;
        const segments = splitWindowSegments({
          windowIndex, windowFps,
          windowStart: start, windowEnd: end,
          slotSec, windowSlots: effectiveSlots,
          candidates: windowCandidates, count,
        });
        for (const segment of segments) {
          segment.slot = cellIndex++;
          await writer.addCell(segment);
        }
      }

      flushedWindows++;
      windowCandidates.fill(null);
      windowCandidateSlots = 0;
      windowActivitySum = 0;
    };

    for await (const frame of decodeFrames({
      input, cellWidth, cellHeight, start: startSec, end: endSec,
    })) {
      decoded++;
      const index = frame.index;
      if (frame.pts != null && ptsBase === null) ptsBase = frame.pts;
      const pts = frame.pts == null
        ? (info.avgFrameRate ? index / info.avgFrameRate : index / upperFps)
        : frame.pts - ptsBase;
      const slotIndex = slotIndexOf(pts, upperFps);

      if (slotIndex !== currentSlot) {
        storeSlot();
        if (slotIndex < totalBaseSlots) {
          const targetWindow = Math.floor(slotIndex / windowSlotsPerWindow);
          while (windowIndex < targetWindow) {
            await flushWindow();
            windowIndex++;
          }
        }
        currentSlot = slotIndex;
        slotBest = null;
        slotMid = null;
        slotCount = 0;
      }

      if (slotIndex >= totalBaseSlots) continue;

      const currentGray = grayBuffers[grayIndex];
      graySampler(frame.buffer, currentGray);
      const change = changeScore(currentGray, previousGray, blockPx, scoreScratch);
      previousGray = currentGray;
      grayIndex ^= 1;

      const score = change.score;
      const candidate = {
        buffer: frame.buffer, pts, frameIndex: index,
        score, globalMAD: change.globalMAD, index: slotCount,
      };
      if (!slotBest || score > slotBest.score) slotBest = candidate;
      if (slotCount % 2 === 0) slotMid = candidate;
      slotCount++;
    }

    storeSlot();
    while (windowIndex < totalWindows) {
      await flushWindow();
      windowIndex++;
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
        mode: 'adaptive',
        slotsPerSecond: upperFps,
        minFps, maxFps: upperFps, framesPerSheet: perSheet,
        slotSeconds: slotSec,
        baseSlotSeconds: slotSec,
        windowSeconds: 1, adaptLow, adaptHigh,
        adaptMetric: 'window-mean-local-peak',
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
        slots: cellIndex,
        sheets: writer.sheets,
        windows: flushedWindows,
        avgFps: segmentDuration > 0 ? Number((cellIndex / segmentDuration).toFixed(3)) : 0,
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
