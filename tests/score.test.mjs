import test from 'node:test';
import assert from 'node:assert/strict';
import { toGray, mad, formatTimecode, getGraySampler, createScoreScratch, changeScore, SAMPLE_W, SAMPLE_H } from '../src/score.js';

const W = 320;
const H = 180;

test('区域平均降采样得到固定 320x180 灰度图', () => {
  const black = Buffer.alloc(W * H * 3, 0);
  const gray = toGray(black, W, H);
  assert.equal(gray.length, SAMPLE_W * SAMPLE_H);
  assert.ok(gray.every((v) => v === 0));
});

test('MAD 对全黑/全白给出 255，对相同帧给出 0', () => {
  const black = toGray(Buffer.alloc(W * H * 3, 0), W, H);
  const white = toGray(Buffer.alloc(W * H * 3, 255), W, H);
  assert.equal(mad(black, white), 255);
  assert.equal(mad(black, black), 0);
  assert.equal(mad(black, null), 0);
});

test('单像素噪点被区域平均明显压制', () => {
  const clean = Buffer.alloc(W * H * 3, 0);
  const noisy = Buffer.from(clean);
  noisy[(90 * W + 160) * 3] = 255;
  noisy[(90 * W + 160) * 3 + 1] = 255;
  noisy[(90 * W + 160) * 3 + 2] = 255;
  const a = toGray(clean, W, H);
  const b = toGray(noisy, W, H);
  assert.ok(mad(a, b) < 2, `噪点影响过大：${mad(a, b)}`);
});

test('采样器与打分布阵可跨帧复用，结果与一次性调用一致', () => {
  const black = Buffer.alloc(W * H * 3, 0);
  const white = Buffer.alloc(W * H * 3, 255);

  // 同一尺寸只建一次采样器
  assert.equal(getGraySampler(W, H), getGraySampler(W, H));

  const sampler = getGraySampler(W, H);
  const reused = new Uint8Array(SAMPLE_W * SAMPLE_H);
  sampler(black, reused);
  assert.deepEqual([...toGray(black, W, H)], [...reused]);

  const scratch = createScoreScratch(16);
  const oneOff = changeScore(toGray(white, W, H), toGray(black, W, H));
  const reusedScore = changeScore(toGray(white, W, H), toGray(black, W, H), 16, scratch);
  assert.equal(oneOff.score, reusedScore.score);
  assert.equal(oneOff.globalMAD, reusedScore.globalMAD);
  // 复用后第二帧也必须是干净重新累加的结果
  const second = changeScore(toGray(black, W, H), toGray(white, W, H), 16, scratch);
  assert.equal(second.score, oneOff.score);
});

test('时间码格式', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(0.125), '00:00.125');
  assert.equal(formatTimecode(61.05), '01:01.050');
});

test('RGBA 采样器：透明像素按黑色计入，与黑底合成一致', () => {
  const W = 320;
  const H = 180;
  const opaqueWhite = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    opaqueWhite[i * 4] = 255;
    opaqueWhite[i * 4 + 1] = 255;
    opaqueWhite[i * 4 + 2] = 255;
    opaqueWhite[i * 4 + 3] = 255;
  }
  const transparent = Buffer.alloc(W * H * 4, 0);

  const white = toGray(opaqueWhite, W, H, undefined, 4);
  const clear = toGray(transparent, W, H, undefined, 4);
  assert.ok(white.every((value) => value === 255));
  assert.ok(clear.every((value) => value === 0));

  // 半透明白色合成到黑底后约为 128，验证 alpha 加权路径。
  const half = Buffer.from(opaqueWhite);
  for (let i = 0; i < W * H; i++) half[i * 4 + 3] = 128;
  const halfGray = toGray(half, W, H, undefined, 4);
  assert.ok(halfGray.every((value) => Math.abs(value - 128) <= 1), '半透明亮度异常');

  // 通道数不同的采样器不能共用缓存。
  assert.notEqual(getGraySampler(W, H), getGraySampler(W, H, 4));
});
