import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probe } from './probe.js';
import { decodeFrames } from './decode.js';
import { toGray, changeScore, BLOCK_PX, SAMPLE_W, SAMPLE_H } from './score.js';
import { planSlots, slotIndexOf } from './slots.js';
import { composeSheet, parseLayout } from './compose.js';

const EXT = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' };

function sanitizeVideoName(input) {
  const base = path.basename(input, path.extname(input));
  const safe = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || 'video';
}

function fmtSec(value) {
  return Number(value).toFixed(2);
}

/** 文件名统一携带元信息：视频名 / 时间区间 / 质量 / 排版 / 序号。 */
export function buildFileName({ videoName, startSec, endSec, quality, layout, index, ext }) {
  return `${videoName}__t${fmtSec(startSec)}s-${fmtSec(endSec)}s__q${quality}__${layout}__${String(index).padStart(5, '0')}.${ext}`;
}

export async function run(options) {
  const {
    input, outDir,
    cellWidth, cellHeight, layout, format, quality,
    annotate = true, gap = 4,
    stampPos = 'tl', stampDir = 'h-lr',
    start = 0, end = null,
    slotsPerSecond = 20, framesPerSheet = null,
    noiseFloor = 0, blockPx = BLOCK_PX,
    dryRun = false, quiet = false,
  } = options;

  const ext = EXT[format] ?? 'jpg';
  const { cells: layoutCells, cols, rows } = parseLayout(layout);
  const perSheet = framesPerSheet ?? layoutCells;
  if (perSheet < 1) throw new Error('--frames-per-sheet 至少为 1');
  if (perSheet > layoutCells) {
    throw new Error(
      `排版 ${layout}（${cols} 列 × ${rows} 行）只有 ${layoutCells} 格，` +
      `容纳不下 --frames-per-sheet ${perSheet} 张图片。请换更大的排版或降低每图帧数`
    );
  }

  const startSec = Number(start) || 0;
  const endSec = end == null ? null : Number(end);
  if (startSec < 0) throw new Error('--start 不能为负数');
  if (endSec != null && endSec <= startSec) throw new Error('--end 必须大于 --start');

  const info = await probe(input, { start: startSec, end: endSec });
  const segmentDuration = endSec != null ? endSec - startSec : Math.max(info.duration - startSec, 0);

  // 槽数只由用户给定的区间决定，末帧不得顶出额外的槽。
  const plan = planSlots({
    duration: segmentDuration, lastPts: null, slotsPerSecond, framesPerSheet: perSheet,
  });
  const { slots } = plan;

  let previousGray = null;
  let currentSlot = -1;
  let best = null;
  let mid = null;
  let candidateCount = 0;
  let decoded = 0;
  let ptsBase = null;

  const closeSlot = () => {
    if (currentSlot < 0 || currentSlot >= slots.length || candidateCount === 0) return;
    const slot = slots[currentSlot];
    slot.candidates = candidateCount;
    const hasPeak = best && best.score > noiseFloor;
    // 默认 noiseFloor=0：严格取槽内变化最大的一帧。
    // 显式调高后，整槽都低于地板（近似静止）才退化为取槽中附近一帧。
    const picked = hasPeak ? best : (mid ?? best);
    slot.empty = false;
    slot.reason = null;
    slot.pts = picked.pts;
    slot.frameIndex = picked.frameIndex;
    slot.score = Number((best?.score ?? 0).toFixed(3));
    slot.globalMAD = Number((best?.globalMAD ?? 0).toFixed(3));
    slot.pickedBy = hasPeak ? 'peak' : 'mid-slot';
    slot.buffer = picked.buffer;
  };

  for await (const frame of decodeFrames({
    input, cellWidth, cellHeight, start: startSec, end: endSec,
  })) {
    decoded++;
    const index = frame.index;
    // showinfo 的 pts_time 可能是绝对时间也可能是片段相对时间，
    // 以第一帧为基准归零，槽号总是从片段起点算起。
    if (frame.pts != null && ptsBase === null) ptsBase = frame.pts;
    const pts = frame.pts == null
      ? (info.avgFrameRate ? index / info.avgFrameRate : index / slotsPerSecond)
      : frame.pts - ptsBase;
    const slotIndex = slotIndexOf(pts, slotsPerSecond);

    if (slotIndex !== currentSlot) {
      closeSlot();
      // 中间跳过的槽保持 empty=true，即「分不到帧的位置加入空帧」。
      currentSlot = slotIndex;
      best = null;
      mid = null;
      candidateCount = 0;
    }

    const gray = toGray(frame.buffer, cellWidth, cellHeight);
    const change = changeScore(gray, previousGray, blockPx);
    previousGray = gray;

    if (slotIndex >= slots.length) continue;

    const score = change.score;
    const candidate = {
      buffer: frame.buffer, pts, frameIndex: index,
      score, globalMAD: change.globalMAD, index: candidateCount,
    };
    if (!best || score > best.score) best = candidate;
    if (candidateCount % 2 === 0) mid = candidate;
    candidateCount++;
  }
  closeSlot();

  await mkdir(outDir, { recursive: true });
  const videoName = sanitizeVideoName(input);
  const sheets = [];

  for (let j = 0; j < plan.sheets; j++) {
    const cells = slots.slice(j * perSheet, (j + 1) * perSheet);
    const absStart = startSec + cells[0].start;
    const absEnd = startSec + cells[cells.length - 1].end;
    const file = buildFileName({
      videoName,
      startSec: absStart, endSec: absEnd,
      quality, layout, index: j + 1, ext,
    });

    // 图上时间码用原片绝对时间，便于对照视频播放器。
    const cellForCompose = cells.map((cell) => ({
      ...cell,
      stampTime: cell.empty ? startSec + cell.start : startSec + (cell.pts ?? cell.start),
    }));

    let size = null;
    if (!dryRun) {
      size = await composeSheet({
        cells: cellForCompose, cellWidth, cellHeight, layout,
        outFile: path.join(outDir, file),
        format: format === 'jpeg' ? 'jpg' : format,
        quality, annotate, gap, stampPos, stampDir,
      });
    }

    sheets.push({
      index: j + 1,
      file: dryRun ? null : file,
      span: [Number(absStart.toFixed(4)), Number(absEnd.toFixed(4))],
      ...(size ? { width: size.width, height: size.height } : {}),
      cells: cellForCompose.map((cell) => ({
        slot: cell.slot,
        start: Number((startSec + cell.start).toFixed(4)),
        empty: cell.empty,
        reason: cell.empty ? cell.reason : null,
        pts: cell.empty ? null : Number((startSec + cell.pts).toFixed(6)),
        frameIndex: cell.empty ? null : cell.frameIndex,
        score: cell.empty ? null : cell.score,
        globalMAD: cell.empty ? null : cell.globalMAD,
        candidates: cell.candidates,
        pickedBy: cell.empty ? null : cell.pickedBy,
      })),
    });
    cells.forEach((cell) => { cell.buffer = null; });
    if (!quiet) {
      const filled = cells.filter((cell) => !cell.empty).length;
      console.log(`[${j + 1}/${plan.sheets}] ${file}  有效帧 ${filled}/${perSheet}`);
    }
  }

  const emptySlots = slots.filter((slot) => slot.empty);
  const manifest = {
    tool: 'video-peak-frames',
    version: '0.2.0',
    input: path.resolve(input),
    generatedAt: new Date().toISOString(),
    range: { start: startSec, end: endSec ?? startSec + segmentDuration },
    fileNamePattern: `${videoName}__t<起s>-<止s>__q<质量>__<排版>__<序号>.${ext}`,
    params: {
      slotsPerSecond, framesPerSheet: perSheet,
      slotSeconds: plan.slotSec,
      layout, layoutCells: layoutCells, cell: [cellWidth, cellHeight],
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
      slots: plan.total,
      sheets: plan.sheets,
      filledSlots: slots.length - emptySlots.length,
      emptySlots: emptySlots.length,
      emptyReasons: {
        'no-frame': emptySlots.filter((s) => s.reason === 'no-frame').length,
        'beyond-duration': emptySlots.filter((s) => s.reason === 'beyond-duration').length,
      },
    },
    sheets,
  };

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}
