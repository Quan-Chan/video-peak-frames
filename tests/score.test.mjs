import test from 'node:test';
import assert from 'node:assert/strict';
import { toGray, mad, formatTimecode, SAMPLE_W, SAMPLE_H } from '../src/score.js';

const W = 320;
const H = 180;

test('区域平均降采样得到固定 160x90 灰度图', () => {
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

test('时间码格式', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(0.125), '00:00.125');
  assert.equal(formatTimecode(61.05), '01:01.050');
});
