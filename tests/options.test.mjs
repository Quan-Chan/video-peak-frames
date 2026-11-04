import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '../src/probe.js';
import { run, buildFileName } from '../src/pipeline.js';
import { parseLayout, stampSvg, STAMP_POS, STAMP_DIR } from '../src/compose.js';

const exec = promisify(execFile);
let tmp;
let video;

before(async () => {
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
  if (tmp) await rm(tmp, { recursive: true, force: true });
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

test('时间码位置与文字方向可配，中文别名可用', async () => {
  const outDir = path.join(tmp, 'stamp');
  const result = spawnSync(process.execPath, [
    'bin/cli.mjs', video, '-o', outDir,
    '--start', '0', '--end', '1',
    '--stamp-pos', '右下', '--stamp-dir', '竖向',
    '--layout', '2x2', '--frames-per-sheet', '4',
    '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(outDir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 5);
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
