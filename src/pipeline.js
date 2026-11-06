import { mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { probe } from './probe.js';
import { decodeFrames } from './decode.js';
import { getGraySampler, changeScore, createScoreScratch, BLOCK_PX, SAMPLE_W, SAMPLE_H } from './score.js';
import { slotLayout, slotIndexOf } from './slots.js';
import { composeSheet, parseLayout, capacityError } from './compose.js';

// 版本号只有 package.json 一个来源，manifest 与发布物不会对不上。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

/** 写入一块数据，等待落盘（或失败），同时处理背压。 */
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/** 按 JSON.stringify(..., null, 2) 的数组项缩进，供流式写出 sheets。 */
function indentEntry(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

/**
 * 单张图的写队列。
 *
 * 一张图的帧全部确定后立即合成，不再等全片解码完；帧缓冲在合成完成后释放。
 * 内存峰值因此只与「同时在写的图数」有关，与视频时长无关。
 * 拼图交给 sharp 的线程池执行，解码与打分在 JS 线程继续跑，两者重叠。
 * 队列按顺序结算，manifest 的 sheets 顺序与文件序号保持一致。
 * 结算后的 manifest 条目直接写入 spool 文件，不在内存里攒整份 manifest。
 */
class SheetWriter {
  constructor(options) {
    this.plan = options.plan;
    this.results = options.results;
    this.perSheet = options.perSheet;
    this.totalSheets = options.totalSheets;
    this.maxInflight = options.maxInflight ?? 2;

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

    this.spool = createWriteStream(options.spoolPath, { flags: 'w' });
    this.spoolError = null;
    // 写回调能拿到错误；这里再记一份，流被销毁后的同步 throw 也能还原成原始原因。
    this.spool.on('error', (error) => { this.spoolError = error; });
    this.spoolFirst = true;
    // 攒到约 1MB 再写，避免几万张图各自触发一次异步写回调。
    this.spoolPending = [];
    this.spoolPendingBytes = 0;

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
          buffer: picked.buffer,
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

  async appendSpool(chunk) {
    this.spoolPending.push(chunk);
    this.spoolPendingBytes += chunk.length;
    if (this.spoolPendingBytes >= 1024 * 1024) await this.flushSpool();
  }

  async flushSpool() {
    if (!this.spoolPending.length) return;
    const chunk = this.spoolPending.join('');
    this.spoolPending = [];
    this.spoolPendingBytes = 0;
    try {
      await writeChunk(this.spool, chunk);
    } catch (error) {
      throw this.spoolError ?? error;
    }
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

    const chunk = (this.spoolFirst ? '' : ',\n') + indentEntry(JSON.stringify(entry, null, 2));
    this.spoolFirst = false;
    await this.appendSpool(chunk);

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

  /** 等 sheets 片段全部落盘。 */
  async finish() {
    await this.flushSpool();
    try {
      await new Promise((resolve, reject) => {
        this.spool.end((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      throw this.spoolError ?? error;
    }
  }

  abort() {
    this.spool.destroy();
  }
}

/**
 * 把 manifest 写成与 JSON.stringify(..., null, 2) 完全一致的排版：
 * 先写除 sheets 外的头部，再把 spool 里的逐张图条目拼进来，最后收尾。
 * 这样超长视频的 manifest 不需要在内存里攒成一个大对象或大字符串。
 */
async function writeManifestFile({ meta, spoolPath, manifestPath, tmpPath }) {
  const headText = JSON.stringify(meta, null, 2);
  const head = headText.slice(0, -2) + ',\n  "sheets": [\n';

  const out = createWriteStream(tmpPath, { flags: 'w' });
  out.on('error', () => {});
  await writeChunk(out, head);

  let buffered = [];
  let bufferedBytes = 0;
  for await (const chunk of createReadStream(spoolPath)) {
    buffered.push(chunk);
    bufferedBytes += chunk.length;
    if (bufferedBytes >= 1024 * 1024) {
      await writeChunk(out, Buffer.concat(buffered, bufferedBytes));
      buffered = [];
      bufferedBytes = 0;
    }
  }
  if (buffered.length) await writeChunk(out, Buffer.concat(buffered, bufferedBytes));
  await writeChunk(out, '\n  ]\n}');
  await new Promise((resolve, reject) => {
    out.end((error) => (error ? reject(error) : resolve()));
  });

  await rename(tmpPath, manifestPath);
  // 临时片段清理失败不影响结果，manifest.json 已经就位。
  await rm(spoolPath, { force: true }).catch(() => {});
}

/** 需要完整 sheets 的调用方（测试、工具）按需从磁盘读，避免流水线常驻整份 manifest。 */
function readSheets(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8')).sheets;
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
  const { cells: layoutCells } = parseLayout(layout);
  const perSheet = framesPerSheet ?? layoutCells;
  if (perSheet < 1) throw new Error('--frames-per-sheet 至少为 1');
  if (perSheet > layoutCells) throw new Error(capacityError(layout, perSheet, `--frames-per-sheet ${perSheet} 张图片`));

  const startSec = Number(start) || 0;
  const endSec = end == null ? null : Number(end);
  if (startSec < 0) throw new Error('--start 不能为负数');
  if (endSec != null && endSec <= startSec) throw new Error('--end 必须大于 --start');

  const info = await probe(input);
  const segmentDuration = endSec != null ? endSec - startSec : Math.max(info.duration - startSec, 0);

  // 槽数只由用户给定的区间决定，末帧不得顶出额外的槽。
  // 槽网格只保留几何信息，具体槽对象按图惰性物化，超长视频不会先建出整张表。
  const plan = slotLayout({
    duration: segmentDuration, lastPts: null, slotsPerSecond, framesPerSheet: perSheet,
  });

  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  const tmpManifestPath = path.join(outDir, '.manifest.json.tmp');
  const spoolPath = path.join(outDir, '.manifest-sheets.tmp');

  const graySampler = getGraySampler(cellWidth, cellHeight);
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

  let writer = null;
  try {
    writer = new SheetWriter({
      plan, results, perSheet, totalSheets: plan.sheets,
      startSec, videoName: sanitizeVideoName(input),
      quality, layout, ext,
      cellWidth, cellHeight, format: ext,
      annotate, gap, stampPos, stampDir,
      outDir, dryRun, quiet, spoolPath,
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
        // --dry-run 只要数值，不保留像素，避免大视频白占内存。
        buffer: dryRun ? null : picked.buffer,
      });
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
        buffer: frame.buffer, pts, frameIndex: index,
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
    await writer.finish();

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
        filledSlots: writer.filledSlots,
        emptySlots: writer.emptySlots,
        emptyReasons: {
          'no-frame': writer.emptyNoFrame,
          'beyond-duration': writer.emptyBeyond,
        },
      },
    };

    await writeManifestFile({ meta, spoolPath, manifestPath, tmpPath: tmpManifestPath });

    const manifest = {
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
    return manifest;
  } catch (error) {
    if (writer) writer.abort();
    await rm(spoolPath, { force: true }).catch(() => {});
    await rm(tmpManifestPath, { force: true }).catch(() => {});
    throw error;
  }
}
