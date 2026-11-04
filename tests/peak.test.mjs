import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { decodeFrames } from '../src/decode.js';
import { toGray, changeScore } from '../src/score.js';
import { run } from '../src/pipeline.js';

const exec = promisify(execFile);

/**
 * 黄金回归：不信任流水线自己的 best 记录，独立解码一遍重算每帧变化量
 * （最大块平均差），再核对 manifest 中每个槽选中的 frameIndex 确实是槽内最大值。
 */
test('每个槽选中的确实是槽内变化量最大的那一帧', async () => {
  await ensureBinaries();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-peak-'));
  try {
    const video = path.join(tmp, 'source.mp4');
    await exec(ffmpegPath, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=60:d=1',
      '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
      video,
    ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

    const cellWidth = 160;
    const cellHeight = 90;
    const manifest = await run({
      input: video,
      outDir: path.join(tmp, 'out'),
      cellWidth, cellHeight,
      layout: '2x2', format: 'jpg', quality: 80,
      annotate: false, gap: 2,
      slotsPerSecond: 20, framesPerSheet: 4,
      noiseFloor: 0, dryRun: true, quiet: true,
    });

    // 60fps / 20 槽 = 每槽 3 帧；MAD 相对上一帧连续计算，跨槽不重置。
    const scores = [];
    let previous = null;
    for await (const frame of decodeFrames({ input: video, cellWidth, cellHeight })) {
      const gray = toGray(frame.buffer, cellWidth, cellHeight);
      scores.push({ index: frame.index, score: previous ? changeScore(gray, previous).score : 0 });
      previous = gray;
    }
    assert.equal(scores.length, 60);

    const expected = [];
    for (let i = 0; i < scores.length; i += 3) {
      const group = scores.slice(i, i + 3);
      expected.push(group.reduce((a, b) => (b.score > a.score ? b : a)).index);
    }

    const actual = manifest.sheets
      .flatMap((sheet) => sheet.cells)
      .filter((cell) => !cell.empty)
      .map((cell) => cell.frameIndex);

    assert.equal(actual.length, expected.length);
    assert.deepEqual(actual, expected);
    assert.ok(
      manifest.sheets.flatMap((s) => s.cells).every((c) => c.pickedBy === 'peak'),
      '默认噪声地板为 0 时所有有效槽都应标记为 peak'
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
