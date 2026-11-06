import path from 'node:path';
import { composeSheet } from './compose.js';
import { buildFileName } from './naming.js';

/**
 * 区段模式的单图写队列，自适应模式与预算模式共用。
 *
 * 与固定网格模式的差别：一格就是一个区段（起止时间可变），最后一张图可能不满。
 * 其余行为一致：满一张图立即合成、队列深度 2、完成后释放帧缓冲、manifest 流式写盘。
 */
export class SegmentSheetWriter {
  constructor(options) {
    this.perSheet = options.perSheet;
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

    this.cells = [];
    this.queue = [];
    this.sheets = 0;
    this.filledSlots = 0;
    this.emptySlots = 0;
    this.emptyNoFrame = 0;
  }

  /** 追加一格；攒满每图帧数就入队合成。 */
  async addCell(cell) {
    this.cells.push(cell);
    if (this.cells.length >= this.perSheet) await this.flushSheet();
  }

  async flushSheet() {
    if (!this.cells.length) return;
    const cells = this.cells;
    this.cells = [];
    const index = ++this.sheets;
    const absStart = this.startSec + cells[0].start;
    const absEnd = this.startSec + cells[cells.length - 1].end;
    const file = buildFileName({
      videoName: this.videoName,
      startSec: absStart,
      endSec: absEnd,
      quality: this.quality,
      layout: this.layout,
      index,
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
      index,
      name: file,
      file: this.dryRun ? null : file,
      span: [absStart, absEnd],
      cells,
      composed: cellForCompose,
      done,
    });
    if (this.queue.length > this.maxInflight) await this.shift();
  }

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
      end: Number((this.startSec + cell.end).toFixed(4)),
      duration: Number((cell.end - cell.start).toFixed(4)),
      empty: cell.empty,
      reason: cell.empty ? cell.reason : null,
      pts: cell.empty ? null : Number((this.startSec + cell.pts).toFixed(6)),
      frameIndex: cell.empty ? null : cell.frameIndex,
      score: cell.empty ? null : cell.score,
      globalMAD: cell.empty ? null : cell.globalMAD,
      candidates: cell.candidates,
      pickedBy: cell.empty ? null : cell.pickedBy,
      window: cell.window,
      windowFps: Number(Number(cell.windowFps).toFixed(3)),
    }));

    await this.manifest.addSheet(entry);

    for (const cell of job.cells) {
      if (cell.empty) {
        this.emptySlots++;
        if (cell.reason === 'no-frame') this.emptyNoFrame++;
      } else {
        this.filledSlots++;
      }
    }
    for (const cell of job.cells) cell.buffer = null;
    for (const cell of job.composed) cell.buffer = null;

    if (!this.quiet) {
      const filled = job.cells.filter((cell) => !cell.empty).length;
      console.log(`[${job.index}] ${job.name}  有效帧 ${filled}/${job.cells.length}`);
    }
  }

  async drain() {
    while (this.queue.length) await this.shift();
  }

  async finish() {
    if (this.cells.length) await this.flushSheet();
    await this.drain();
  }
}
