import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { run } from '../src/pipeline.js';
import { allocateBudget, smoothWindowActivity, BUDGET_DEFAULTS } from '../src/budget.js';

const exec = promisify(execFile);
let tmp;
let motion60;
let motion30;
let staticThenMotion;
let slow10;

before(async () => {
  await ensureBinaries();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-budget-'));

  motion60 = path.join(tmp, 'motion-60fps.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=60:d=4',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    motion60,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

  motion30 = path.join(tmp, 'motion-30fps.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    motion30,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

  slow10 = path.join(tmp, 'slow-10fps.mp4');
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=4',
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    slow10,
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
  budget: true, budgetFps: 10, minFps: 1, maxFps: 30,
  noiseFloor: 0, dryRun: true, quiet: true,
};

test('预算默认值：15 fps 预算、每窗口 1-30 帧、衰减 3.5 秒', () => {
  assert.deepEqual(BUDGET_DEFAULTS, {
    budgetFps: 15, minFps: 1, maxFps: 30, decaySeconds: 3.5,
  });
});

test('活动度平滑：上升快、下降慢，输出保持在原始范围内', () => {
  const durations = new Array(10).fill(1);
  const rise = smoothWindowActivity([0, 100, 100, 100, 100, 100, 100, 100, 100, 100], durations);
  assert.ok(rise[1] > 30 && rise[1] < 100);
  assert.ok(rise[2] > rise[1]);
  assert.ok(rise[4] > 85);

  const decay = smoothWindowActivity([100, 0, 0, 0, 0, 0, 0, 0, 0, 0], durations);
  assert.ok(decay[1] > 60 && decay[1] < 100);
  assert.ok(decay[2] < decay[1] && decay[2] > 30);
  assert.ok(decay[3] < decay[2]);

  for (const value of [...rise, ...decay]) {
    assert.ok(value >= 0 && value <= 100);
  }

  // 衰减时间常数越大，同样一个静止窗口里保留的帧率越高。
  const fast = smoothWindowActivity([100, 0, 0, 0, 0], durations, 0.5);
  const slow = smoothWindowActivity([100, 0, 0, 0, 0], durations, 10);
  assert.ok(slow[1] > fast[1]);
  assert.ok(slow[3] > fast[3]);
});

test('预算分配：总帧数精确，且每窗口在上下限内', () => {
  const windows = [
    { duration: 1, activity: 8, candidateCount: 3 },
    { duration: 1, activity: 4, candidateCount: 3 },
  ];
  const result = allocateBudget({ windows, totalFrames: 5, minFps: 1, maxFps: 3 });
  assert.equal(result.counts.reduce((sum, count) => sum + count, 0), 5);
  for (let index = 0; index < windows.length; index++) {
    assert.ok(result.counts[index] >= result.lower[index]);
    assert.ok(result.counts[index] <= result.upper[index]);
  }
  assert.deepEqual(result.counts, [3, 2]);
});

test('预算分配：按活动度平方根分配，中等窗口不会被尖峰窗口挤到下限', () => {
  const windows = [
    { duration: 1, activity: 9, candidateCount: 30 },
    { duration: 1, activity: 1, candidateCount: 30 },
  ];
  const result = allocateBudget({ windows, totalFrames: 20, minFps: 1, maxFps: 30 });
  // 权重 sqrt(9):sqrt(1) = 3:1，20 帧应分成 15:5，而不是接近 18:2。
  assert.deepEqual(result.counts, [15, 5]);
});

test('预算分配：同等变化时各窗口均分', () => {
  const windows = Array.from({ length: 3 }, () => ({
    duration: 1, activity: 9, candidateCount: 10,
  }));
  const result = allocateBudget({ windows, totalFrames: 12, minFps: 1, maxFps: 10 });
  assert.deepEqual(result.counts, [4, 4, 4]);
});

test('预算分配：同分时均匀铺开，不扎堆在最早窗口', () => {
  const windows = Array.from({ length: 4 }, () => ({ duration: 1, activity: 5, candidateCount: 3 }));
  const result = allocateBudget({ windows, totalFrames: 8, minFps: 1, maxFps: 3 });
  assert.deepEqual(result.counts, [2, 2, 2, 2]);
});

test('预算分配：无候选帧的窗口不参与分配', () => {
  const windows = [
    { duration: 1, activity: 7, candidateCount: 2 },
    { duration: 1, activity: 0, candidateCount: 0 },
    { duration: 1, activity: 5, candidateCount: 2 },
  ];
  const result = allocateBudget({ windows, totalFrames: 3, minFps: 1, maxFps: 2 });
  assert.deepEqual(result.counts, [2, 0, 1]);
});

test('预算分配：不可行时明确报错并给出可达范围', () => {
  assert.throws(
    () => allocateBudget({
      windows: [{ duration: 1, activity: 2, candidateCount: 3 }],
      totalFrames: 4, minFps: 1, maxFps: 3,
    }),
    /超过可达上限/,
  );
  assert.throws(
    () => allocateBudget({
      windows: [{ duration: 1, activity: 2, candidateCount: 3 }],
      totalFrames: 0, minFps: 1, maxFps: 3,
    }),
    /低于分配下限/,
  );
});

test('预算：安静段少抽、运动段多抽，区段连续且帧数精确', async () => {
  const outDir = path.join(tmp, 'static-motion');
  const manifest = await run({ ...BASE, input: staticThenMotion, outDir, dryRun: false });
  const cells = manifest.sheets.flatMap((sheet) => sheet.cells);

  assert.equal(manifest.params.mode, 'budget');
  assert.equal(manifest.params.budgetFrames, 60);
  assert.equal(manifest.summary.slots, 60);
  assert.equal(manifest.summary.sheets, 15);
  assert.equal(manifest.summary.emptySlots, 0);

  let cursor = 0;
  for (const cell of cells) {
    assert.ok(Math.abs(cell.start - cursor) < 1e-6, '区段不连续：' + cell.start + ' != ' + cursor);
    assert.ok(cell.duration > 0);
    cursor = cell.end;
  }
  assert.ok(Math.abs(cursor - 6) < 0.05, '覆盖长度异常：' + cursor);

  const quiet = cells.filter((cell) => cell.start < 3);
  const moving = cells.filter((cell) => cell.start >= 3);
  assert.ok(moving.length > quiet.length * 2, '疏密比不足：quiet=' + quiet.length + ' moving=' + moving.length);

  const perWindow = new Map();
  for (const cell of cells) {
    if (!perWindow.has(cell.window)) perWindow.set(cell.window, []);
    perWindow.get(cell.window).push(cell);
  }
  for (const windowCells of perWindow.values()) {
    assert.ok(windowCells.length >= 1 && windowCells.length <= 30, '窗口帧数越界：' + windowCells.length);
    // 同一窗口内每帧应占据等长的子段，播放帧率才会均匀（manifest 保留 4 位小数）。
    const lengths = windowCells.map((cell) => cell.end - cell.start);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) < 2e-3, '窗口内帧没有均匀铺开');
  }

  const files = (await readdir(outDir)).filter((name) => name.endsWith('.jpg'));
  assert.equal(files.length, 15);
});

test('预算：预算等于上限时命中全部基准槽（30fps 源、30fps 基准）', async () => {
  const outDir = path.join(tmp, 'full-grid');
  const manifest = await run({
    ...BASE, input: motion30, outDir,
    budgetFps: 30, minFps: 30, maxFps: 30, dryRun: false,
  });
  const cells = manifest.sheets.flatMap((sheet) => sheet.cells);

  assert.equal(cells.length, 120);
  assert.equal(manifest.summary.slots, 120);
  assert.equal(manifest.summary.sheets, 30);
  assert.equal(manifest.summary.emptySlots, 0);
  assert.deepEqual(cells.map((cell) => cell.frameIndex), Array.from({ length: 120 }, (_, index) => index));
  assert.ok(Math.abs(cells[0].start) < 1e-9);
  assert.ok(Math.abs(cells[cells.length - 1].end - 4) < 1e-6);
});

test('预算：区间截取与末图不满', async () => {
  const outDir = path.join(tmp, 'range');
  const manifest = await run({
    ...BASE, input: motion60, outDir,
    start: 0, end: 3.3, budgetFps: 5, maxFps: 10, minFps: 1, dryRun: false,
  });
  const cells = manifest.sheets.flatMap((sheet) => sheet.cells);

  assert.equal(manifest.range.start, 0);
  assert.equal(manifest.range.end, 3.3);
  assert.equal(cells.length, 17);
  assert.equal(manifest.summary.sheets, 5);
  assert.equal(manifest.sheets[manifest.sheets.length - 1].cells.length, 1);
  assert.ok(Math.abs(cells[0].start - 0) < 1e-6);
  assert.ok(Math.abs(cells[cells.length - 1].end - 3.3) < 1e-6);
});

test('预算 --dry-run 只写 manifest.json', async () => {
  const outDir = path.join(tmp, 'dry');
  const manifest = await run({ ...BASE, input: motion60, outDir, dryRun: true });
  const files = await readdir(outDir);
  assert.deepEqual(files, ['manifest.json']);
  assert.equal(manifest.params.budgetFrames, 40);
  assert.equal(manifest.summary.slots, 40);
  assert.equal(manifest.summary.sheets, 10);
});

test('CLI --budget 默认 15 fps、每窗口 1-30 帧', () => {
  const outDir = path.join(tmp, 'cli-defaults');
  const result = spawnSync(process.execPath, [
    'bin/cli.mjs', motion60, '-o', outDir, '--budget', '--dry-run', '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.params.mode, 'budget');
  assert.equal(manifest.params.budgetFps, 15);
  assert.equal(manifest.params.minFps, 1);
  assert.equal(manifest.params.maxFps, 30);
  assert.equal(manifest.params.activityDecaySeconds, 3.5);
  assert.equal(manifest.params.budgetFrames, 60);
  assert.equal(manifest.summary.slots, 60);
});

test('CLI --budget-decay 可调，并写入 manifest', () => {
  const outDir = path.join(tmp, 'cli-decay');
  const result = spawnSync(process.execPath, [
    'bin/cli.mjs', motion60, '-o', outDir, '--budget', '--budget-decay', '8', '--dry-run', '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.params.activityDecaySeconds, 8);
  assert.equal(manifest.params.activityAttackSeconds, 1.2);
});

test('已移除 --adapt-window', () => {
  const result = spawnSync(process.execPath, [
    'bin/cli.mjs', motion60, '-o', path.join(tmp, 'removed-window'),
    '--budget', '--adapt-window', '2', '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /错误/);
});

test('预算参数非法或实际不可行时明确报错', () => {
  const bad = [
    [ '--budget', '--budget-fps', '31', '--max-fps', '30' ],
    [ '--budget', '--budget-fps', '5', '--min-fps', '10' ],
    [ '--budget', '--budget-decay', '0' ],
    [ '--budget', '--adaptive' ],
  ];
  for (const args of bad) {
    const result = spawnSync(process.execPath, [
      'bin/cli.mjs', motion60, '-o', path.join(tmp, 'bad'), '--quiet', ...args,
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0, '应报错：' + args.join(' '));
    assert.match(result.stderr + result.stdout, /错误/);
  }

  // 10fps 源在 30fps 基准网格下最多约 10 fps，20fps 预算不可达。
  const infeasible = spawnSync(process.execPath, [
    'bin/cli.mjs', slow10, '-o', path.join(tmp, 'infeasible'),
    '--budget', '--budget-fps', '20', '--max-fps', '30', '--quiet',
  ], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(infeasible.status, 0);
  assert.match(infeasible.stderr + infeasible.stdout, /可达上限/);
});
