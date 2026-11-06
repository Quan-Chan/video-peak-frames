#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { run } from '../src/pipeline.js';
import { ensureBinaries } from '../src/probe.js';
import { parseLayout, capacityError } from '../src/compose.js';

const HELP = `视频抽帧工具 vpf

把视频按时间槽抽帧：每槽取「变化最大」的一帧，再拼成一张图片。
槽内没有源帧时空帧占位，槽位固定、后续帧绝不左移。

用法：
  vpf <input.mp4> -o ./frames [选项]
  vpf -i input.mp4 --start 5 --end 10 --slots-per-second 10

一、预算（取多少、多密、什么格式）
  -i, --input <file>        输入视频
  -o, --out <dir>           输出目录，默认 ./frames
      --start <sec>         截取起点（秒），默认 0
      --end <sec>           截取终点（秒），默认到片尾
      --slots-per-second n  采样频率：每秒切几槽，默认 20（即 50ms 一槽），
                            可调 10（100ms）甚至 1（1 秒一槽）
      --format <s>          jpg（默认，jpeg 等价）/ png / webp
      --quality <1-100>     图片质量，默认 90；png 为无损格式，
                            此值映射为压缩级别（越大文件越大越快）

二、输出模式
      --layout <CxR>        排版结构，默认 2x2；可写 2x1 / 1x1 / 3x2 / 4x1 等
      --frames-per-sheet n  一帧（一张图）里包含几张图片，默认等于排版格子数。
                            格子数不足容纳时会直接报错
      --annotate            合成时间码（默认开启）
      --no-annotate         不合成时间码（空帧横杠仍保留）
      --stamp-pos <位置>    时间码合成位置，默认 tl，可用中文或缩写：
                            左上 tl / 右上 tr / 左下 bl / 右下 br / 屏幕中间 c
                            上侧 t / 下侧 b / 左边 l / 右边 r
      --stamp-dir <方向>    文字排列方向，默认 h-lr：
                            从左至右横向 h-lr / 从右至左横向 h-rl
                            从上至下竖向 v-tb / 从下至上竖向 v-bt
      --cell <WxH>          单格尺寸，默认 480x270
      --gap <px>            格子间距，默认 4

三、其他
      --noise-floor <n>     变化量地板（0-255），默认 0，即始终取槽内变化最大的一帧；
                            调高后，整槽变化都低于该值时改取槽中附近一帧
      --block-size <px>     局部变化检测的分块边长（320x180 采样像素），默认 16。
                            越小越灵敏（也更易受噪点影响），越大越接近全局平均
      --dry-run             只分析并写 manifest.json，不生成图片
      --quiet               不打印进度
  -h, --help                显示帮助

输出文件名统一为：
  <视频名>__t<起s>-<止s>__q<质量>__<排版>__<序号>.<扩展名>
  例：CS2__t0.00s-0.20s__q90__2x2__00001.jpg
`;

const POS_ALIAS = {
  '左上': 'tl', '右上': 'tr', '左下': 'bl', '右下': 'br', '屏幕中间': 'c', '中间': 'c',
  '上侧': 't', '下侧': 'b', '左边': 'l', '右边': 'r',
  tl: 'tl', tr: 'tr', bl: 'bl', br: 'br', c: 'c', center: 'c',
  t: 't', top: 't', b: 'b', bottom: 'b', l: 'l', left: 'l', r: 'r', right: 'r',
};
const DIR_ALIAS = {
  '从左至右横向': 'h-lr', '从右至左横向': 'h-rl', '从上至下竖向': 'v-tb', '从下至上竖向': 'v-bt',
  '横向': 'h-lr', '反向横排': 'h-rl', '竖向': 'v-tb', '反向竖排': 'v-bt',
  'h-lr': 'h-lr', 'h-rl': 'h-rl', 'v-tb': 'v-tb', 'v-bt': 'v-bt',
  lr: 'h-lr', rl: 'h-rl', tb: 'v-tb', bt: 'v-bt',
};

function fail(message) {
  throw new Error(message);
}

function parseCell(text) {
  const match = /^(\d+)x(\d+)$/i.exec(String(text));
  if (!match) fail(`--cell 格式应为 WxH，收到：${text}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 16 || height < 16) fail('--cell 单格尺寸不能小于 16');
  return [width, height];
}

function intOf(text, name, min, max) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} 应为 ${min}-${max} 的整数，收到：${text}`);
  }
  return value;
}

function floatOf(text, name) {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) fail(`${name} 必须是非负数字，收到：${text}`);
  return value;
}

function mapEnum(raw, table, name) {
  const key = String(raw).trim();
  const value = table[key] ?? table[key.toLowerCase()];
  if (!value) fail(`${name} 的取值 ${raw} 不认识，可选：${Object.keys(table).join(' / ')}`);
  return value;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i' },
      out: { type: 'string', short: 'o', default: './frames' },
      start: { type: 'string', default: '0' },
      end: { type: 'string' },
      cell: { type: 'string', default: '480x270' },
      layout: { type: 'string', default: '2x2' },
      'frames-per-sheet': { type: 'string' },
      format: { type: 'string', default: 'jpg' },
      quality: { type: 'string', default: '90' },
      gap: { type: 'string', default: '4' },
      'slots-per-second': { type: 'string', default: '20' },
      'stamp-pos': { type: 'string', default: 'tl' },
      'stamp-dir': { type: 'string', default: 'h-lr' },
      'noise-floor': { type: 'string', default: '0' },
      'block-size': { type: 'string', default: '16' },
      annotate: { type: 'boolean', default: true },
      'no-annotate': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  await ensureBinaries();

  const input = values.input ?? positionals[0];
  if (!input) fail('缺少输入视频，用 vpf <input.mp4> 或 -i <input.mp4> 指定\n\n' + HELP);

  const [cellWidth, cellHeight] = parseCell(values.cell);
  const rawFormat = String(values.format).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(rawFormat)) {
    fail(`--format 只能是 jpg / png / webp，收到：${rawFormat}`);
  }
  const format = rawFormat === 'jpeg' ? 'jpg' : rawFormat;

  const layout = String(values.layout).trim();
  const layoutInfo = parseLayout(layout);

  const framesPerSheet = values['frames-per-sheet'] == null
    ? layoutInfo.cells
    : intOf(values['frames-per-sheet'], '--frames-per-sheet', 1, 64);
  if (framesPerSheet > layoutInfo.cells) {
    fail(capacityError(layout, framesPerSheet, `--frames-per-sheet ${framesPerSheet} 张图片`));
  }

  const options = {
    input: path.resolve(input),
    outDir: path.resolve(values.out),
    start: floatOf(values.start, '--start'),
    end: values.end == null ? null : floatOf(values.end, '--end'),
    cellWidth, cellHeight, layout, format,
    framesPerSheet,
    quality: intOf(values.quality, '--quality', 1, 100),
    gap: intOf(values.gap, '--gap', 0, 64),
    slotsPerSecond: intOf(values['slots-per-second'], '--slots-per-second', 1, 240),
    stampPos: mapEnum(values['stamp-pos'], POS_ALIAS, '--stamp-pos'),
    stampDir: mapEnum(values['stamp-dir'], DIR_ALIAS, '--stamp-dir'),
    noiseFloor: floatOf(values['noise-floor'], '--noise-floor'),
    blockPx: intOf(values['block-size'], '--block-size', 2, 64),
    annotate: values.annotate && !values['no-annotate'],
    dryRun: Boolean(values['dry-run']),
    quiet: Boolean(values.quiet),
  };
  if (options.end != null && options.end <= options.start) {
    fail('--end 必须大于 --start');
  }

  const manifest = await run(options);
  if (!options.quiet) {
    const s = manifest.summary;
    console.log(
      `完成：${s.sheets} 张图 / ${s.slots} 个槽，` +
      `有效帧 ${s.filledSlots}，空帧 ${s.emptySlots}，` +
      `输出目录 ${options.outDir}`
    );
    if (options.dryRun) console.log('（--dry-run：仅生成 manifest.json，未写图片）');
  }
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
