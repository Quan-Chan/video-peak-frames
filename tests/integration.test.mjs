import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ffmpegPath } from '../src/probe.js';
import { run } from '../src/pipeline.js';

const exec = promisify(execFile);
let tmp;
let src10;
let src60;

async function makeVideo(name, extraArgs) {
  const file = path.join(tmp, name);
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    ...extraArgs,
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    file,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return file;
}

const BASE = {
  cellWidth: 160,
  cellHeight: 90,
  layout: '2x2',
  format: 'jpg',
  quality: 80,
  annotate: true,
  gap: 2,
  slotsPerSecond: 20,
  framesPerSheet: 4,
  noiseFloor: 0,
  quiet: true,
};

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-test-'));
  src10 = await makeVideo('ten-fps.mp4', [
    '-f', 'lavfi', '-i', 'color=c=0x000080:s=320x180:r=10:d=1',
  ]);
  src60 = await makeVideo('sixty-fps.mp4', [
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=60:d=1',
    '-vf', "drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='between(t,0.100,0.116)'",
  ]);
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('10fps：每秒 5 张图，空帧按槽位占位且不压实', async () => {
  const outDir = path.join(tmp, 'out10');
  const manifest = await run({ ...BASE, input: src10, outDir, dryRun: false });

  assert.equal(manifest.summary.slots, 20);
  assert.equal(manifest.summary.sheets, 5);
  assert.equal(manifest.summary.filledSlots, 10);
  assert.equal(manifest.summary.emptySlots, 10);

  // 流程图下排：0 / 空帧1 / 0.1 / 空帧2，0.2 仍在下一张图的第一格。
  assert.deepEqual(manifest.sheets[0].cells.map((c) => c.empty), [false, true, false, true]);
  assert.equal(manifest.sheets[0].cells[1].reason, 'no-frame');
  assert.equal(manifest.sheets[0].cells[3].reason, 'no-frame');
  assert.ok(Math.abs(manifest.sheets[0].cells[0].pts - 0) < 0.01);
  assert.ok(Math.abs(manifest.sheets[0].cells[2].pts - 0.1) < 0.01);
  assert.ok(Math.abs(manifest.sheets[1].cells[0].pts - 0.2) < 0.01);

  const files = (await readdir(outDir)).filter((f) => f.endsWith('.jpg'));
  assert.equal(files.length, 5);
  const meta = await sharp(path.join(outDir, files[0])).metadata();
  assert.equal(meta.width, 2 * 160 + 3 * 2);
  assert.equal(meta.height, 2 * 90 + 3 * 2);

  const onDisk = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.sheets.length, 5);
});

test('dry-run 只生成 manifest，不写图片', async () => {
  const outDir = path.join(tmp, 'dry');
  const manifest = await run({ ...BASE, input: src10, outDir, dryRun: true });
  assert.equal(manifest.summary.sheets, 5);
  assert.ok(manifest.sheets.every((s) => s.file === null));
  const files = await readdir(outDir);
  assert.deepEqual(files, ['manifest.json']);
});

test('60fps：每个槽有 3 帧候选，突变帧被选中', async () => {
  const outDir = path.join(tmp, 'out60');
  const manifest = await run({ ...BASE, input: src60, outDir, dryRun: true });

  assert.equal(manifest.summary.emptySlots, 0);
  const slot2 = manifest.sheets[0].cells[2];
  assert.equal(slot2.empty, false);
  assert.equal(slot2.candidates, 3);
  assert.equal(slot2.pickedBy, 'peak');
  assert.ok(slot2.score > 30, `突变得分过低：${slot2.score}`);
  assert.ok(
    Math.abs(slot2.pts - 0.1) < 0.02,
    `槽 2 应命中 0.1s 的白帧，实际命中 ${slot2.pts}`
  );
});
