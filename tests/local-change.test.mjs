import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { mad, changeScore, SAMPLE_W, SAMPLE_H } from '../src/score.js';
import { run } from '../src/pipeline.js';

const exec = promisify(execFile);
let tmp;
let video;

before(async () => {
  await ensureBinaries();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-local-'));
  video = path.join(tmp, 'local.mp4');
  // 静止灰底；0.100s 一小块方块变白（模拟点击按钮 / UI 更新）；
  // 0.1167s 起整屏轻微增亮（模拟全局轻微变化）。
  await exec(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x646464:s=320x180:r=60:d=1',
    '-vf',
    "drawbox=x=64:y=64:w=24:h=24:color=white:t=fill:enable='between(t,0.100,0.116)'," +
    "drawbox=x=0:y=0:w=iw:h=ih:color=white@0.06:t=fill:enable='between(t,0.1167,0.133)'",
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
    video,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('复现缺陷：全局平均会把小面积大变化判输给全局轻微变化', () => {
  const size = SAMPLE_W * SAMPLE_H;
  const base = new Uint8Array(size).fill(100);

  // 帧 A：只有 24x24 的小方块从 100 跳到 255（约 1% 面积，点击按钮这类变化）
  const local = Uint8Array.from(base);
  for (let y = 64; y < 88; y++) {
    for (let x = 64; x < 88; x++) local[y * SAMPLE_W + x] = 255;
  }
  // 帧 B：整屏均匀增亮 12 灰阶（全局轻微变化）
  const global = Uint8Array.from(base);
  for (let i = 0; i < size; i++) global[i] = 112;

  const madLocal = mad(local, base);
  const madGlobal = mad(global, base);
  // 旧度量（全局平均）确实会选错：这才是「丢失关键信息」的根因
  assert.ok(madGlobal > madLocal, `旧度量应选错：local=${madLocal.toFixed(2)} global=${madGlobal.toFixed(2)}`);
  assert.ok(madLocal < 3, `局部大变化被稀释到 ${madLocal.toFixed(2)} 分`);

  // 新度量（最大块平均差）正确翻转
  const localStats = changeScore(local, base);
  const globalStats = changeScore(global, base);
  assert.ok(localStats.score > globalStats.score,
    `新度量应选对：local=${localStats.score.toFixed(2)} global=${globalStats.score.toFixed(2)}`);
  assert.ok(localStats.score > 100, `局部峰值应显著，实际 ${localStats.score.toFixed(2)}`);
  // 全局均值仍被记录，便于诊断
  assert.ok(localStats.globalMAD < 3);
  // 最大块值恒不小于全局均值，所以全局运动也不会被漏掉
  assert.ok(globalStats.localPeak >= globalStats.globalMAD);
});

test('端到端：槽内选中「局部小块突变」的帧，而不是「全局轻微变化」的帧', async () => {
  const manifest = await run({
    input: video,
    outDir: path.join(tmp, 'out'),
    cellWidth: 320, cellHeight: 180,
    layout: '2x2', format: 'jpg', quality: 80,
    annotate: false, gap: 2,
    slotsPerSecond: 20, framesPerSheet: 4,
    noiseFloor: 0, dryRun: true, quiet: true,
  });

  // 槽 2 = [0.100, 0.150)：含 0.100（方块突变）、0.1167（全局增亮）、0.1333（恢复）
  const cell = manifest.sheets[0].cells[2];
  assert.equal(cell.empty, false);
  assert.equal(cell.candidates, 3);
  assert.ok(
    Math.abs(cell.pts - 0.1) < 0.02,
    `应选中 0.100s 的局部突变帧，实际命中 ${cell.pts}`
  );
  assert.ok(cell.score > 80, `局部峰值应显著，实际 ${cell.score}`);
  assert.ok(cell.globalMAD < 20, `选中帧的全局平均应不大，实际 ${cell.globalMAD}`);
  assert.equal(cell.pickedBy, 'peak');
});
