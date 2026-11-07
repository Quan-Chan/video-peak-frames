import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { probe, sourceNotices } from './probe.js';
import { decodeFrames } from './decode.js';
import { getGraySampler, changeScore, createScoreScratch, BLOCK_PX, SAMPLE_W, SAMPLE_H } from './score.js';
import { slotLayout, slotIndexOf } from './slots.js';
import { composeSheet } from './compose.js';
import { sanitizeVideoName, buildFileName } from './naming.js';
import { resolveCommonOptions, outputSupportsAlpha } from './prepare.js';
import { ManifestSpool, readSheets } from './manifest.js';
import { runAdaptive } from './adaptive.js';
import { runBudget } from './budget.js';

export { buildFileName } from './naming.js';

// 版本号只有 package.json 一个来源，manifest 与发布物不会对不上。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * 单张图的写队列（固定网格模式）。
 *
 * 一张图的帧全部确定后立即合成，不再等全片解码完；帧缓冲在合成完成后释放。
 * 内存峰值因此只与「同时在写的图数」有关，与视频时长无关。
 * 拼图交给 sharp 的线程池执行，解码与打分在 JS 线程继续跑，两者重叠。
 * 队列按顺序结算，manifest 的 sheets 顺序与文件序号保持一致。
 * 结算后的 manifest 条目直接交给 ManifestSpool 流式写盘，不在内存里攒整份 manifest。
 */
class SheetWriter {
  constructor(options) {
    this.plan = options.plan;
    this.results = options.results;
    this.perSheet = options.perSheet;
    this.totalSheets = options.totalSheets;
    this.maxInflight = options.maxInflight ?? 2;
    this.manifest = options.manifest;

    this.startSec = options.startSec;
    this.videoName = options.videoName;
    this.quality = options.quality;
    this.layout = options.layout;
    this.ext = options.ext;
    this.cellWidth = options.cellWidth;
    this.cellHeight = options.cellHeight;
    this.format = options.format;
    this.annotate = options.annotate;
    this.gap = options.gap;
    this.stampPos = options.stampPos;
    this.stampDir = options.stampDir;
    this.outDir = options.outDir;
    this.dryRun = options.dryRun;
    this.quiet = options.quiet;
    this.outputAlpha = options.outputAlpha ?? false;

    this.queue = [];
    this.enqueued = 0;
    this.filledSlots = 0;
    this.emptySlots = 0;
    this.emptyNoFrame = 0;
    this.emptyBeyond = 0;
  }

  /** 第 sheetIndex 张图的 4 个槽：已选帧从 results 取，其余按空槽物化。 */
  buildCells(sheetIndex) {
    const { plan, results, perSheet } = this;
    const cells = [];
    for (let i = sheetIndex * perSheet; i < (sheetIndex + 1) * perSheet; i++) {
      const picked = results.get(i);
      const start = plan.startOf(i);
      const end = plan.endOf(i);
      cells.push(picked
        ? {
          slot: i, start, end, empty: false, reason: null,
          pts: picked.pts, frameIndex: picked.frameIndex,
          score: picked.score, globalMAD: picked.globalMAD,
          candidates: picked.candidates, pickedBy: picked.pickedBy,
          channels: picked.channels ?? 3, buffer: picked.buffer,
        }
        : {
          slot: i, start, end, empty: true, reason: plan.emptyReason(i),
          pts: null, frameIndex: null, score: null, globalMAD: null,
          candidates: 0, pickedBy: null, buffer: null,
        });
    }
    return cells;
  }

  /** 入队第 sheetIndex 张图。队列满时先结算最早的一张。 */
  async write(sheetIndex) {
    const cells = this.buildCells(sheetIndex);
    const absStart = this.startSec + cells[0].start;
    const absEnd = this.startSec + cells[cells.length - 1].end;
    const file = buildFileName({
      videoName: this.videoName,
      startSec: absStart,
      endSec: absEnd,
      quality: this.quality,
      layout: this.layout,
      index: sheetIndex + 1,
      ext: this.ext,
    });

    // 图上时间码用原片绝对时间，便于对照视频播放器。
    const cellForCompose = cells.map((cell) => ({
      ...cell,
      stampTime: cell.empty ? this.startSec + cell.start : this.startSec + (cell.pts ?? cell.start),
    }));

    let done;
    if (this.dryRun) {
      done = Promise.resolve(null);
    } else {
      done = composeSheet({
        cells: cellForCompose,
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
        layout: this.layout,
        outFile: path.join(this.outDir, file),
        format: this.format,
        quality: this.quality,
        annotate: this.annotate,
        gap: this.gap,
        stampPos: this.stampPos,
        stampDir: this.stampDir,
        outputAlpha: this.outputAlpha,
      });
    }
    // 失败在 shift 里重新抛出；这里先挂一个空处理，避免队列中其余图触发未捕获拒绝。
    done.catch(() => {});

    this.queue.push({
      index: sheetIndex + 1,
      name: file,
      file: this.dryRun ? null : file,
      span: [absStart, absEnd],
      from: sheetIndex * this.perSheet,
      to: (sheetIndex + 1) * this.perSheet,
      cells,
      composed: cellForCompose,
      done,
    });
    if (this.queue.length > this.maxInflight) await this.shift();
  }

  /** 结算最早入队的一张图：写 manifest 片段、累计摘要、释放帧缓冲。 */
  async shift() {
    const job = this.queue.shift();
    const size = await job.done;

    const entry = {
      index: job.index,
      file: job.file,
      span: [Number(job.span[0].toFixed(4)), Number(job.span[1].toFixed(4))],
    };
    if (size) {
      entry.width = size.width;
      entry.height = size.height;
    }
    entry.cells = job.composed.map((cell) => ({
      slot: cell.slot,
      start: Number((this.startSec + cell.start).toFixed(4)),
      empty: cell.empty,
      reason: cell.empty ? cell.reason : null,
      pts: cell.empty ? null : Number((this.startSec + cell.pts).toFixed(6)),
      frameIndex: cell.empty ? null : cell.frameIndex,
      score: cell.empty ? null : cell.score,
      globalMAD: cell.empty ? null : cell.globalMAD,
      candidates: cell.candidates,
      pickedBy: cell.empty ? null : cell.pickedBy,
    }));

    await this.manifest.addSheet(entry);

    for (const cell of job.cells) {
      if (cell.empty) {
        this.emptySlots++;
        if (cell.reason === 'no-frame') this.emptyNoFrame++;
        else this.emptyBeyond++;
      } else {
        this.filledSlots++;
      }
    }
    for (let i = job.from; i < job.to; i++) this.results.delete(i);
    for (const cell of job.cells) cell.buffer = null;
    for (const cell of job.composed) cell.buffer = null;

    if (!this.quiet) {
      const filled = job.cells.filter((cell) => !cell.empty).length;
      console.log(`[${job.index}/${this.totalSheets}] ${job.name}  有效帧 ${filled}/${this.perSheet}`);
    }
  }

  async drain() {
    while (this.queue.length) await this.shift();
  }
}

export async function run(options) {
  if (options.budget) return runBudget(options);
  if (options.adaptive) return runAdaptive(options);

  const {
    input, outDir,
    cellWidth, cellHeight, layout, format, quality,
    annotate = true, gap = 4,
    stampPos = 'tl', stampDir = 'h-lr',
    slotsPerSecond = 20,
    noiseFloor = 0, blockPx = BLOCK_PX,
    dryRun = false, quiet = false,
  } = options;

  const { ext, layoutCells, perSheet, startSec, endSec } = resolveCommonOptions(options);

  const info = await probe(input);
  // 输出 JPG 不支持透明，保持黑色合成为兜底；PNG/WebP 保留源帧的透明通道。
  const preserveAlpha = info.hasAlpha && outputSupportsAlpha(ext);
  const frameChannels = preserveAlpha ? 4 : 3;
  for (const notice of sourceNotices(info, { preserveAlpha })) console.error(`[警告] ${notice}`);
  const segmentDuration = endSec != null ? endSec - startSec : Math.max(info.duration - startSec, 0);

  // 槽数只由用户给定的区间决定，末帧不得顶出额外的槽。
  // 槽网格只保留几何信息，具体槽对象按图惰性物化，超长视频不会先建出整张表。
  const plan = slotLayout({
    duration: segmentDuration, lastPts: null, slotsPerSecond, framesPerSheet: perSheet,
  });

  await mkdir(outDir, { recursive: true });
  const manifest = new ManifestSpool({ outDir });
  const manifestPath = manifest.manifestPath;

  const graySampler = getGraySampler(cellWidth, cellHeight, frameChannels);
  const scoreScratch = createScoreScratch(blockPx);
  const grayBuffers = [new Uint8Array(SAMPLE_W * SAMPLE_H), new Uint8Array(SAMPLE_W * SAMPLE_H)];
  let grayIndex = 0;
  let previousGray = null;

  // 当前图窗口内、已选帧的槽结果；图结算后即删，大小与片长无关。
  const results = new Map();
  let currentSlot = -1;
  let closedThrough = -1;
  let best = null;
  let mid = null;
  let candidateCount = 0;
  let decoded = 0;
  let ptsBase = null;

  try {
    const writer = new SheetWriter({
      plan, results, perSheet, totalSheets: plan.sheets,
      startSec, videoName: sanitizeVideoName(input),
      quality, layout, ext,
      cellWidth, cellHeight, format: ext,
      annotate, gap, stampPos, stampDir,
      outDir, dryRun, quiet, manifest, outputAlpha: preserveAlpha,
    });

    const flushReady = async () => {
      while (writer.enqueued < plan.sheets && (writer.enqueued + 1) * perSheet - 1 <= closedThrough) {
        await writer.write(writer.enqueued);
        writer.enqueued++;
      }
    };

    const closeSlot = () => {
      if (currentSlot < 0 || currentSlot >= plan.total || candidateCount === 0) return;
      const hasPeak = best && best.score > noiseFloor;
      // 默认 noiseFloor=0：严格取槽内变化最大的一帧。
      // 显式调高后，整槽都低于地板（近似静止）才退化为取槽中附近一帧。
      const picked = hasPeak ? best : (mid ?? best);
      results.set(currentSlot, {
        pts: picked.pts,
        frameIndex: picked.frameIndex,
        score: Number((best?.score ?? 0).toFixed(3)),
        globalMAD: Number((best?.globalMAD ?? 0).toFixed(3)),
        candidates: candidateCount,
        pickedBy: hasPeak ? 'peak' : 'mid-slot',
        channels: picked.channels ?? 3,
        // --dry-run 只要数值，不保留像素，避免大视频白占内存。
        buffer: dryRun ? null : picked.buffer,
      });
    };

    for await (const frame of decodeFrames({
      input, cellWidth, cellHeight, start: startSec, end: endSec,
      hasAlpha: info.hasAlpha, preserveAlpha,
    })) {
      decoded++;
      const index = frame.index;
      // showinfo 的 pts_time 可能是绝对时间也可能是片段相对时间，
      // 以第一帧为基准归零，槽号总是从片段起点算起。
      if (frame.pts != null && ptsBase === null) ptsBase = frame.pts;
      const pts = frame.pts == null
        ? (info.avgFrameRate ? index / info.avgFrameRate : index / slotsPerSecond)
        : frame.pts - ptsBase;
      const slotIndex = slotIndexOf(pts, slotsPerSecond, info.slotToleranceSeconds);

      if (slotIndex !== currentSlot) {
        closeSlot();
        // 换槽后，序号小于新槽的槽都不会再有帧，可以交出已完整的那几张图。
        closedThrough = Math.min(slotIndex - 1, plan.total - 1);
        currentSlot = slotIndex;
        best = null;
        mid = null;
        candidateCount = 0;
        if (closedThrough >= 0) await flushReady();
      }

      // 区间之外的尾部帧不参与打分（时间戳单调递增，不会再有槽内帧）。
      if (slotIndex >= plan.total) continue;

      const currentGray = grayBuffers[grayIndex];
      graySampler(frame.buffer, currentGray);
      const change = changeScore(currentGray, previousGray, blockPx, scoreScratch);
      previousGray = currentGray;
      grayIndex ^= 1;

      const score = change.score;
      const candidate = {
        buffer: frame.buffer, pts, frameIndex: index, channels: frame.channels,
        score, globalMAD: change.globalMAD, index: candidateCount,
      };
      if (!best || score > best.score) best = candidate;
      if (candidateCount % 2 === 0) mid = candidate;
      candidateCount++;
    }
    closeSlot();
    closedThrough = plan.total - 1;
    await flushReady();
    await writer.drain();

    const meta = {
      tool: 'video-peak-frames',
      version: pkg.version,
      input: path.resolve(input),
      generatedAt: new Date().toISOString(),
      range: { start: startSec, end: endSec ?? startSec + segmentDuration },
      fileNamePattern: `${sanitizeVideoName(input)}__t<起s>-<止s>__q<质量>__<排版>__<序号>.${ext}`,
      params: {
        slotsPerSecond, framesPerSheet: perSheet,
        slotSeconds: plan.slotSec,
        layout, layoutCells, cell: [cellWidth, cellHeight],
        format: ext, quality, preserveAlpha,
        annotate, stampPos, stampDir,
        metric: 'local-peak', blockPx, sample: [SAMPLE_W, SAMPLE_H], noiseFloor,
      },
      source: {
        width: info.width, height: info.height,
        duration: info.duration,
        segmentDuration: Number(segmentDuration.toFixed(4)),
        rFrameRate: Number(info.rFrameRate.toFixed(4)),
        avgFrameRate: Number(info.avgFrameRate.toFixed(4)),
        codec: info.codec,
        formatName: info.formatName,
        animated: info.animated,
        frameCount: info.frameCount,
        durationSource: info.durationSource,
        hasAlpha: info.hasAlpha,
        decodedFrames: decoded,
        ptsFrameCount: decoded,
        ptsSource: 'showinfo',
      },
      summary: {
        slots: plan.total,
        sheets: plan.sheets,
        filledSlots: writer.filledSlots,
        emptySlots: writer.emptySlots,
        emptyReasons: {
          'no-frame': writer.emptyNoFrame,
          'beyond-duration': writer.emptyBeyond,
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
      // 兼容原有调用方：需要完整 sheets 时按需读磁盘，流水线自身不常驻。
      get sheets() {
        return readSheets(manifestPath);
      },
    };
  } catch (error) {
    await manifest.abort();
    throw error;
  }
}
