import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { run, buildFileName } from '../src/pipeline.js';
import { parseLayout, stampSvg, STAMP_POS, STAMP_DIR } from '../src/compose.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const exec = promisify(execFile);
let tmp;
let video;

before(async () => {
  await ensureBinaries();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-opts-'));
  video = path.join(tmp, 'clip.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x224466:s=160x90:r=30:d=2',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    video,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
});

after(async () => {
  // Windows 上 libvips 可能短暂持有刚读过的图片句柄，删除时重试几次。
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const BASE = {
  cellWidth: 160, cellHeight: 90,
  layout: '2x2', format: 'jpg', quality: 80,
  annotate: true, gap: 2,
  slotsPerSecond: 20, framesPerSheet: 4,
  noiseFloor: 0, dryRun: true, quiet: true,
};

test('时间范围 --start 0.5 --end 1.5 只取 1 秒片段，文件名带绝对时间区间', async () => {
  const outDir = path.join(tmp, 'range');
  const manifest = await run({ ...BASE, input: video, outDir, start: 0.5, end: 1.5, dryRun: false });

  assert.equal(manifest.range.start, 0.5);
  assert.equal(manifest.range.end, 1.5);
  assert.equal(manifest.summary.slots, 20);
  assert.equal(manifest.summary.sheets, 5);
  assert.equal(
    manifest.sheets[0].file,
    'clip__t0.50s-0.70s__q80__2x2__00001.jpg',
    '文件名应包含视频名、时间区间、质量与排版'
  );
  // 时间码是原片绝对时间，不是片段相对时间
  assert.ok(Math.abs(manifest.sheets[0].cells[0].start - 0.5) < 0.001);
  assert.ok(Math.abs(manifest.sheets[4].cells[3].start - 1.45) < 0.001);

  const files = await readdir(outDir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 5);
  assert.ok(files.includes('manifest.json'));
});

test('buildFileName 统一带上四类元信息', () => {
  assert.equal(
    buildFileName({ videoName: 'MyGameRecording_2024.01.01-00.00', startSec: 3.2, endSec: 3.4, quality: 90, layout: '2x1', index: 12, ext: 'jpg' }),
    'MyGameRecording_2024.01.01-00.00__t3.20s-3.40s__q90__2x1__00012.jpg'
  );
});

test('采样频率调成 10：每秒 10 槽（100ms 一槽）', async () => {
  const manifest = await run({
    ...BASE, input: video, outDir: path.join(tmp, 's10'),
    start: 0, end: 1, slotsPerSecond: 10,
  });
  assert.equal(manifest.params.slotSeconds, 0.1);
  assert.equal(manifest.summary.slots, 12); // 10 槽补齐到每图 4 格
  assert.equal(manifest.summary.sheets, 3);
});

test('采样频率调成 1：一秒一槽', async () => {
  const manifest = await run({
    ...BASE, input: video, outDir: path.join(tmp, 's1'),
    start: 0, end: 2, slotsPerSecond: 1, layout: '1x1', framesPerSheet: 1,
  });
  assert.equal(manifest.params.slotSeconds, 1);
  assert.equal(manifest.summary.slots, 2);
  assert.equal(manifest.summary.sheets, 2);
});

test('排版 1x1 单图：每张图只含一帧', async () => {
  const outDir = path.join(tmp, 'single');
  const manifest = await run({
    ...BASE, input: video, outDir,
    start: 0, end: 1, layout: '1x1', framesPerSheet: 1, dryRun: false,
  });
  assert.equal(manifest.params.layoutCells, 1);
  assert.equal(manifest.summary.sheets, 20);
  const files = await readdir(outDir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 20);
});

test('排版格子数不足以容纳每图帧数时明确报错', async () => {
  await assert.rejects(
    () => run({ ...BASE, input: video, outDir: path.join(tmp, 'err'), layout: '2x2', framesPerSheet: 5 }),
    /容纳不下/
  );
  assert.throws(() => parseLayout('2x3.5'), /排版/);
});

test('时间码位置与文字方向可配，中文别名可用，jpeg 归一为 jpg', async () => {
  const outDir = path.join(tmp, 'stamp');
  const result = spawnSync(process.execPath, [
    'bin/cli.mjs', video, '-o', outDir,
    '--start', '0', '--end', '1',
    '--stamp-pos', '右下', '--stamp-dir', '竖向',
    '--layout', '2x2', '--frames-per-sheet', '4',
    '--format', 'jpeg',
    '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(outDir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 5);
  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.params.format, 'jpg');
  assert.equal(manifest.version, pkg.version);
});

test('manifest.version 与 package.json 版本一致', async () => {
  const manifest = await run({ ...BASE, input: video, outDir: path.join(tmp, 'version') });
  assert.equal(manifest.version, pkg.version);
});

test('每图帧数少于格子数：多余格子留深灰底，不参与时间码', async () => {
  const outDir = path.join(tmp, 'unused');
  const manifest = await run({
    ...BASE, input: video, outDir,
    start: 0, end: 1, framesPerSheet: 2, annotate: false, dryRun: false,
  });
  assert.equal(manifest.summary.sheets, 10);
  assert.equal(manifest.sheets[0].cells.length, 2);

  const files = (await readdir(outDir)).filter((name) => name.endsWith('.jpg'));
  assert.equal(files.length, 10);
  const meta = await sharp(path.join(outDir, files[0])).metadata();
  assert.equal(meta.width, 2 * 160 + 3 * 2);
  assert.equal(meta.height, 2 * 90 + 3 * 2);

  // 第 3 格（index 2）没有被帧占用，应铺未用格底色 #2A2E38
  const pixel = await sharp(path.join(outDir, files[0]))
    .extract({ left: 2 + 160 / 2, top: 2 + 90 + 2 + 90 / 2, width: 1, height: 1 })
    .raw()
    .toBuffer();
  [42, 46, 56].forEach((expected, channel) => {
    assert.ok(Math.abs(pixel[channel] - expected) < 16, `底色异常：${[...pixel]}`);
  });
});

test('png 与 webp 输出走同一套合成路径', async () => {
  for (const format of ['png', 'webp']) {
    const outDir = path.join(tmp, format);
    const manifest = await run({
      ...BASE, input: video, outDir,
      start: 0, end: 0.2, format, quality: 80, dryRun: false,
    });
    assert.equal(manifest.params.format, format);
    const files = (await readdir(outDir)).filter((name) => name.endsWith('.' + format));
    assert.equal(files.length, 1);
    // 从内存读取：避免 libvips 在 Windows 上继续持有文件句柄，导致临时目录删不掉。
    const meta = await sharp(await readFile(path.join(outDir, files[0]))).metadata();
    assert.equal(meta.format, format);
  }
});

test('run 返回的 sheets 按需读取，与 manifest.json 一致且无临时文件残留', async () => {
  const outDir = path.join(tmp, 'lazy');
  const manifest = await run({ ...BASE, input: video, outDir, start: 0, end: 0.4, dryRun: false });

  const onDisk = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sheets.length, onDisk.sheets.length);
  assert.deepEqual(manifest.sheets, onDisk.sheets);

  const files = await readdir(outDir);
  assert.ok(!files.some((name) => name.startsWith('.manifest')), `存在临时文件：${files.join(', ')}`);
});

test('九种位置与四种方向都能生成合成层', () => {
  for (const pos of STAMP_POS) {
    for (const dir of STAMP_DIR) {
      const svg = stampSvg(480, 270, '00:12.345', { pos, dir }).toString('utf8');
      assert.ok(svg.includes('<path'), `${pos}/${dir} 未生成字形轮廓`);
    }
  }
  assert.throws(() => stampSvg(100, 100, 'x', { pos: 'xx' }), /位置/);
  assert.throws(() => stampSvg(100, 100, 'x', { dir: 'yy' }), /方向/);
});
