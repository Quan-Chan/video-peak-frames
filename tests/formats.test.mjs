import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ffmpegPath, ensureBinaries } from '../src/probe.js';
import { run } from '../src/pipeline.js';

const exec = promisify(execFile);
let tmp;
let video10;
let video5;
let gif10;
let apng10;
let apng30;
let stillPng;
let transparentGif;
let transparentApng;
let animatedWebp = null;

const BASE = {
  cellWidth: 160,
  cellHeight: 90,
  layout: '2x2',
  format: 'jpg',
  quality: 80,
  annotate: false,
  gap: 2,
  slotsPerSecond: 20,
  framesPerSheet: 4,
  noiseFloor: 0,
  blockPx: 16,
  quiet: true,
};

async function ffmpeg(args) {
  await exec(ffmpegPath, ['-y', '-v', 'error', ...args], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 生成 4 帧 RGBA（透明底 + 红方块），用于黑底合成与 png/webp 透明保留测试。 */
async function makeAlphaFrames(dir) {
  await mkdir(dir, { recursive: true });
  const width = 64;
  const height = 64;
  for (let frame = 0; frame < 4; frame++) {
    const buffer = Buffer.alloc(width * height * 4, 0);
    const left = 8 + frame * 12;
    for (let y = 24; y < 40; y++) {
      for (let x = left; x < left + 16; x++) {
        const offset = (y * width + x) * 4;
        buffer[offset] = 220;
        buffer[offset + 1] = 30;
        buffer[offset + 2] = 30;
        buffer[offset + 3] = 255;
      }
    }
    await sharp(buffer, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(path.join(dir, frame + '.png'));
  }
}

before(async () => {
  await ensureBinaries();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vpf-format-'));

  video10 = path.join(tmp, 'ten.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=2', '-c:v', 'mpeg4', '-q:v', '2', video10]);
  video5 = path.join(tmp, 'five.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=5:d=2', '-c:v', 'mpeg4', '-q:v', '2', video5]);

  gif10 = path.join(tmp, 'ten.gif');
  await ffmpeg(['-i', video10, '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', gif10]);

  apng10 = path.join(tmp, 'ten.png');
  await ffmpeg(['-i', video10, '-plays', '0', '-f', 'apng', apng10]);

  apng30 = path.join(tmp, 'thirty.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-f', 'apng', apng30]);

  stillPng = path.join(tmp, 'still.png');
  await ffmpeg(['-i', video10, '-frames:v', '1', stillPng]);

  const frameDir = path.join(tmp, 'alpha-frames');
  await makeAlphaFrames(frameDir);
  transparentGif = path.join(tmp, 'alpha.gif');
  await ffmpeg([
    '-framerate', '5', '-start_number', '0', '-i', path.join(frameDir, '%d.png'),
    '-vf', 'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128',
    transparentGif,
  ]);

  transparentApng = path.join(tmp, 'alpha.png');
  await ffmpeg([
    '-framerate', '5', '-start_number', '0', '-i', path.join(frameDir, '%d.png'),
    '-plays', '0', '-f', 'apng', transparentApng,
  ]);

  animatedWebp = path.join(tmp, 'anim.webp');
  try {
    await ffmpeg(['-i', video10, '-loop', '0', '-c:v', 'libwebp_anim', '-q:v', '80', animatedWebp]);
  } catch {
    animatedWebp = null;
  }
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('GIF 输入：按真实时间轴分槽，结果与同源视频一致', async () => {
  const gifManifest = await run({ ...BASE, input: gif10, outDir: path.join(tmp, 'out-gif'), dryRun: true });
  const videoManifest = await run({ ...BASE, input: video10, outDir: path.join(tmp, 'out-video'), dryRun: true });

  assert.equal(gifManifest.source.codec, 'gif');
  assert.equal(gifManifest.source.animated, true);
  assert.equal(gifManifest.source.durationSource, 'stream');
  assert.equal(gifManifest.summary.slots, 40);
  assert.equal(gifManifest.summary.filledSlots, 20);
  assert.equal(gifManifest.summary.emptySlots, 20);

  // 低帧率空槽必须与视频完全一致：槽位固定、不压实。
  const shape = (manifest) => manifest.sheets.map((sheet) => sheet.cells.map((cell) => cell.empty));
  assert.deepEqual(shape(gifManifest), shape(videoManifest));
});

test('APNG 输入：容器没有时长时按帧表推算，全片正常分槽', async () => {
  const manifest = await run({ ...BASE, input: apng10, outDir: path.join(tmp, 'out-apng'), dryRun: true });

  assert.equal(manifest.source.codec, 'apng');
  assert.equal(manifest.source.durationSource, 'packets');
  assert.ok(Math.abs(manifest.source.duration - 2) < 0.01, `时长推算错误：${manifest.source.duration}`);
  assert.equal(manifest.summary.slots, 40);
  assert.equal(manifest.summary.filledSlots, 20);
  assert.equal(manifest.summary.emptySlots, 20);
  assert.deepEqual(
    manifest.sheets[0].cells.map((cell) => cell.empty),
    [false, true, false, true]
  );
});

test('APNG 30fps：毫秒级 timebase 舍入不会让边界帧落进前一槽', async () => {
  const manifest = await run({ ...BASE, input: apng30, outDir: path.join(tmp, 'out-apng30'), dryRun: true });

  const cells = manifest.sheets.flatMap((sheet) => sheet.cells).filter((cell) => !cell.empty);
  assert.equal(cells.length, 20);
  for (const cell of cells) {
    // 30fps CFR：第 i 帧的真实时间是 i/30 秒，应落在 floor(i/30 × 20) 槽。
    assert.equal(
      cell.slot,
      Math.floor((cell.frameIndex * 20) / 30),
      `第 ${cell.frameIndex} 帧落在槽 ${cell.slot}，与真实时间戳不符`
    );
  }
});

test('透明 GIF：透明区域合成到黑色背景，不透明区域保留', async () => {
  const outDir = path.join(tmp, 'out-alpha');
  const manifest = await run({
    ...BASE,
    cellWidth: 64,
    cellHeight: 64,
    gap: 0,
    input: transparentGif,
    outDir,
    dryRun: false,
  });

  assert.equal(manifest.source.hasAlpha, true);
  assert.equal(manifest.params.preserveAlpha, false);
  const files = (await readdir(outDir)).filter((file) => file.endsWith('.jpg')).sort();
  assert.equal(files.length, 4);

  const { data, info } = await sharp(path.join(outDir, files[0]))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return [...data.slice(offset, offset + 3)];
  };

  // 左上角格子是透明底，合成后应为黑色；方块区域应保留红色。
  assert.ok(pixel(2, 2).every((value) => value < 40), `透明区域不是黑色：${pixel(2, 2)}`);
  const red = pixel(12, 30);
  assert.ok(red[0] > 180 && red[1] < 60, `方块颜色异常：${red}`);
});

test('透明 GIF：png / webp 输出保留透明通道', async () => {
  for (const format of ['png', 'webp']) {
    const outDir = path.join(tmp, 'out-alpha-' + format);
    const manifest = await run({
      ...BASE,
      cellWidth: 64,
      cellHeight: 64,
      gap: 0,
      format,
      input: transparentGif,
      outDir,
      dryRun: false,
    });

    assert.equal(manifest.params.preserveAlpha, true);
    const files = (await readdir(outDir)).filter((file) => file.endsWith('.' + format)).sort();
    assert.equal(files.length, 4);

    const buffer = await readFile(path.join(outDir, files[0]));
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.hasAlpha, true);

    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    const pixel = (x, y) => {
      const offset = (y * info.width + x) * 4;
      return [...data.slice(offset, offset + 4)];
    };

    // 源帧的透明区域 alpha 为 0；红方块与空帧格保持不透明。
    assert.equal(pixel(2, 2)[3], 0, `${format} 透明区域 alpha 应为 0`);
    const red = pixel(12, 30);
    assert.ok(red[0] > 180 && red[1] < 60 && red[3] === 255, `${format} 方块颜色/alpha 异常：${red}`);
    assert.equal(pixel(70, 2)[3], 255, `${format} 空帧格应保持不透明`);
  }
});

test('透明 APNG：同样合成到黑色背景', async () => {
  const outDir = path.join(tmp, 'out-alpha-apng');
  const manifest = await run({
    ...BASE,
    cellWidth: 64,
    cellHeight: 64,
    gap: 0,
    input: transparentApng,
    outDir,
    dryRun: false,
  });

  assert.equal(manifest.source.codec, 'apng');
  assert.equal(manifest.source.hasAlpha, true);
  const files = (await readdir(outDir)).filter((file) => file.endsWith('.jpg')).sort();
  assert.equal(files.length, 4);

  const { data, info } = await sharp(path.join(outDir, files[0]))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const corner = (2 * info.width + 2) * info.channels;
  assert.ok([...data.slice(corner, corner + 3)].every((value) => value < 40));
});

test('静态单帧图片被拒绝，而不是当成 1 帧视频', async () => {
  await assert.rejects(
    run({ ...BASE, input: stillPng, outDir: path.join(tmp, 'out-still'), dryRun: true }),
    /只有 1 帧|不是视频或动图/
  );
});

test('动画 WebP：当前 ffmpeg 不支持时给出明确报错', async (t) => {
  if (!animatedWebp) {
    t.skip('当前 ffmpeg 构建无法生成动画 WebP，跳过');
    return;
  }
  let error = null;
  try {
    await run({ ...BASE, input: animatedWebp, outDir: path.join(tmp, 'out-webp'), dryRun: true });
  } catch (caught) {
    error = caught;
  }
  if (error) {
    assert.match(error.message, /动画 WebP|无法解析输入的画面尺寸/);
  }
});

test('低帧率视频保持固定槽位：不自动降低参数', async () => {
  const manifest = await run({ ...BASE, input: video5, outDir: path.join(tmp, 'out-five'), dryRun: true });

  assert.equal(manifest.params.slotsPerSecond, 20);
  assert.equal(manifest.summary.slots, 40);
  assert.equal(manifest.summary.filledSlots, 10);
  assert.equal(manifest.summary.emptySlots, 30);
});

test('动图预算模式默认预算超过源帧率时给出可达上限错误', async () => {
  await assert.rejects(
    run({ ...BASE, budget: true, input: gif10, outDir: path.join(tmp, 'out-budget'), dryRun: true }),
    /可达上限/
  );
});

test('自适应模式可直接处理 APNG 动图', async () => {
  const manifest = await run({ ...BASE, adaptive: true, input: apng10, outDir: path.join(tmp, 'out-adapt'), dryRun: true });

  assert.equal(manifest.params.mode, 'adaptive');
  assert.ok(manifest.summary.slots > 0);
  assert.equal(manifest.summary.emptySlots, 0);
});

test('自适应与预算模式的 png 输出保留动图透明通道', async () => {
  const adaptive = await run({
    ...BASE,
    adaptive: true,
    format: 'png',
    input: transparentGif,
    outDir: path.join(tmp, 'out-adapt-alpha-png'),
    dryRun: true,
  });
  assert.equal(adaptive.params.preserveAlpha, true);
  assert.ok(adaptive.summary.slots > 0);

  const budgetDir = path.join(tmp, 'out-budget-gif-png');
  const budget = await run({
    ...BASE,
    budget: true,
    budgetFps: 5,
    format: 'png',
    input: gif10,
    outDir: budgetDir,
    dryRun: false,
  });
  assert.equal(budget.params.preserveAlpha, true);
  assert.equal(budget.summary.slots, 10);

  const files = (await readdir(budgetDir)).filter((file) => file.endsWith('.png'));
  assert.equal(files.length, 3);
  const buffer = await readFile(path.join(budgetDir, files[0]));
  assert.equal((await sharp(buffer).metadata()).hasAlpha, true);
});

test('自适应与预算模式都能处理动图（透明通道走同一解码链）', async () => {
  const adaptive = await run({
    ...BASE,
    adaptive: true,
    input: transparentGif,
    outDir: path.join(tmp, 'out-adapt-alpha'),
    dryRun: true,
  });
  assert.equal(adaptive.params.mode, 'adaptive');
  assert.ok(adaptive.summary.slots > 0);

  const budget = await run({
    ...BASE,
    budget: true,
    budgetFps: 5,
    input: gif10,
    outDir: path.join(tmp, 'out-budget-gif'),
    dryRun: false,
  });
  assert.equal(budget.params.mode, 'budget');
  assert.equal(budget.summary.slots, 10);
  const files = (await readdir(path.join(tmp, 'out-budget-gif'))).filter((file) => file.endsWith('.jpg'));
  assert.equal(files.length, 3);
});
