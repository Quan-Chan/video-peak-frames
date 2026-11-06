import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { run } from '../src/pipeline.js';
import { activityToFps, windowFrameCount, splitWindowSegments } from '../src/adaptive.js';

const exec = promisify(execFile);
let tmp;
let motion60;
let staticThenMotion;

before(async () => {
  await ensureBinaries();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-adapt-'));
  motion60 = path.join(tmp, 'motion-60fps.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=60:d=4',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    motion60,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

  staticThenMotion = path.join(tmp, 'static-then-motion.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-filter_complex',
    'color=c=0x303030:s=320x180:r=60:d=3[base];' +
      'testsrc2=s=320x180:r=60:d=3[move];' +
      '[base][move]concat=n=2:v=1[out]',
    '-map', '[out]',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    staticThenMotion,
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
  adaptive: true, minFps: 2, maxFps: 20, adaptWindow: 1, adaptLow: 1, adaptHigh: 40,
  noiseFloor: 0, dryRun: true, quiet: true,
};

const pick = (manifest) => manifest.sheets
  .flatMap((sheet) => sheet.cells)
  .map((cell) => [cell.empty, cell.frameIndex, cell.pts, cell.start]);

test('活动度映射：低于 low 取下限，高于 high 取上限，中间线性', () => {
  const cfg = { minFps: 2, maxFps: 20, adaptLow: 1, adaptHigh: 40 };
  assert.equal(activityToFps(0, cfg), 2);
  assert.equal(activityToFps(1, cfg), 2);
  assert.equal(activityToFps(40, cfg), 20);
  assert.equal(activityToFps(200, cfg), 20);
  assert.equal(activityToFps(20.5, cfg), 11);
  assert.equal(activityToFps(5, { ...cfg, adaptLow: 5, adaptHigh: 5 }), 20);
});

test('窗口帧数：带上下限，并受候选槽数与源帧率封顶', () => {
  const cfg = { minFps: 2, maxFps: 20, adaptLow: 1, adaptHigh: 40 };
  assert.equal(windowFrameCount({ activity: 0, duration: 1, candidateSlots: 20, sourceFps: 60, ...cfg }), 2);
  assert.equal(windowFrameCount({ activity: 500, duration: 1, candidateSlots: 20, sourceFps: 60, ...cfg }), 20);
  assert.equal(windowFrameCount({ activity: 500, duration: 0.5, candidateSlots: 20, sourceFps: 60, ...cfg }), 10);
  assert.equal(windowFrameCount({ activity: 500, duration: 1, candidateSlots: 20, sourceFps: 5, ...cfg }), 5);
  assert.equal(windowFrameCount({ activity: 0, duration: 1, candidateSlots: 0, sourceFps: 60, ...cfg }), 0);
});

test('窗口切段：区段首尾相接并覆盖整个窗口，每段取段内最高活动度帧', () => {
  const candidates = new Array(20).fill(null);
  candidates[3] = {
    slotIndex: 3, activityScore: 50, score: 50, globalMAD: 1,
    candidates: 1, pickedBy: 'peak', pts: 0.18, frameIndex: 3, buffer: null,
  };
  const segments = splitWindowSegments({
    windowIndex: 0, windowFps: 4,
    windowStart: 0, windowEnd: 1,
    slotSec: 0.05, windowSlots: 20, candidates, count: 4,
  });
  assert.equal(segments.length, 4);
  let cursor = 0;
  for (const segment of segments) {
    assert.equal(segment.start, cursor);
    cursor = segment.end;
  }
  assert.equal(cursor, 1);
  assert.equal(segments[0].empty, false);
  assert.equal(segments[0].frameIndex, 3);
  assert.equal(segments[0].window, 0);
  assert.ok(segments[1].empty && segments[2].empty && segments[3].empty);
});

test('窗口无候选帧时输出一个覆盖整窗的空帧段', () => {
  const segments = splitWindowSegments({
    windowIndex: 2, windowFps: 0,
    windowStart: 2, windowEnd: 3,
    slotSec: 0.05, windowSlots: 20, candidates: new Array(20).fill(null), count: 0,
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].empty, true);
  assert.equal(segments[0].reason, 'no-frame');
  assert.deepEqual([segments[0].start, segments[0].end], [2, 3]);
});

test('自适应：安静段少抽、运动段多抽，区段连续覆盖且无空帧', async () => {
  const outDir = path.join(tmp, 'static-motion');
  const manifest = await run({ ...BASE, input: staticThenMotion, outDir, dryRun: false });
  const cells = manifest.sheets.flatMap((sheet) => sheet.cells);

  assert.equal(manifest.params.mode, 'adaptive');
  assert.equal(manifest.summary.emptySlots, 0);

  let cursor = 0;
  for (const cell of cells) {
    assert.ok(Math.abs(cell.start - cursor) < 1e-6, `区段不连续：${cell.start} != ${cursor}`);
    assert.ok(cell.duration > 0);
    cursor = cell.end;
  }
  assert.ok(Math.abs(cursor - 6) < 0.05, `覆盖长度异常：${cursor}`);

  const quiet = cells.filter((cell) => cell.start < 3);
  const moving = cells.filter((cell) => cell.start >= 3);
  assert.ok(moving.length > quiet.length * 2, `疏密比不足：quiet=${quiet.length} moving=${moving.length}`);

  const perWindow = new Map();
  for (const cell of cells) perWindow.set(cell.window, (perWindow.get(cell.window) ?? 0) + 1);
  for (const count of perWindow.values()) {
    assert.ok(count >= 2 && count <= 20, `窗口帧数越界：${count}`);
  }
  const files = (await readdir(outDir)).filter((name) => name.endsWith('.jpg'));
  assert.equal(files.length, manifest.summary.sheets);
});

test('自适应 min=max=20 时与固定模式选帧、文件名一致', async () => {
  const standardDir = path.join(tmp, 'equal-standard');
  const adaptiveDir = path.join(tmp, 'equal-adaptive');
  const standard = await run({
    ...BASE, input: motion60, outDir: standardDir,
    adaptive: false, slotsPerSecond: 20, framesPerSheet: 4, dryRun: false,
  });
  const adaptive = await run({
    ...BASE, input: motion60, outDir: adaptiveDir,
    minFps: 20, maxFps: 20, dryRun: false,
  });

  assert.deepEqual(pick(adaptive), pick(standard));
  assert.deepEqual(adaptive.sheets.map((sheet) => sheet.file), standard.sheets.map((sheet) => sheet.file));
});

test('自适应支持起止区间，文件名与区段覆盖从区间起点算起', async () => {
  const manifest = await run({
    ...BASE, input: motion60, outDir: path.join(tmp, 'range'),
    start: 1, end: 2, dryRun: false,
  });
  const cells = manifest.sheets.flatMap((sheet) => sheet.cells);
  assert.equal(manifest.range.start, 1);
  assert.equal(manifest.range.end, 2);
  assert.ok(Math.abs(cells[0].start - 1) < 1e-6);
  assert.ok(Math.abs(cells[cells.length - 1].end - 2) < 1e-6);
  assert.ok(manifest.sheets[0].file.startsWith('motion-60fps__t1.00s-'));
});

test('自适应 --dry-run 只写 manifest.json', async () => {
  const outDir = path.join(tmp, 'dry');
  const manifest = await run({ ...BASE, input: motion60, outDir, dryRun: true });
  const files = await readdir(outDir);
  assert.deepEqual(files, ['manifest.json']);
  assert.ok(manifest.summary.sheets > 0);
});

test('自适应参数非法时明确报错', () => {
  const cases = [
    ['--min-fps', '30', '--max-fps', '20'],
    ['--adapt-window', '0'],
    ['--adapt-low', '40', '--adapt-high', '1'],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [
      'bin/cli.mjs', motion60, '-o', path.join(tmp, 'bad'), '--adaptive', '--quiet', ...args,
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0, `应报错：${args.join(' ')}`);
    assert.match(result.stderr + result.stdout, /错误/);
  }
});
