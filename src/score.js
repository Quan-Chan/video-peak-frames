// 打分用的降采样分辨率。提到 320x180 是为了别把小尺寸 UI 变化（按钮、弹窗、
// 进度条）在降采样阶段就抹掉——160x90 对 1440p 素材是 12:1，会吞掉这类关键信息。
export const SAMPLE_W = 320;
export const SAMPLE_H = 180;
/** 分块边长（采样像素）。16x16 在 320x180 上得到 20x12 块。 */
export const BLOCK_PX = 16;

/**
 * 把 rgb24 帧做区域平均降采样成灰度图。
 * 区域平均本身就是低通，用来压掉编码噪点与颗粒，避免「变化最大」选到噪点帧。
 */
export function toGray(rgb, width, height, out = new Uint8Array(SAMPLE_W * SAMPLE_H)) {
  const xStep = width / SAMPLE_W;
  const yStep = height / SAMPLE_H;

  for (let sy = 0; sy < SAMPLE_H; sy++) {
    const y0 = Math.floor(sy * yStep);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((sy + 1) * yStep)));
    for (let sx = 0; sx < SAMPLE_W; sx++) {
      const x0 = Math.floor(sx * xStep);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((sx + 1) * xStep)));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width * 3;
        for (let x = x0; x < x1; x++) {
          const p = row + x * 3;
          sum += 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
          count++;
        }
      }
      out[sy * SAMPLE_W + sx] = count ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

/** 相邻帧平均绝对差（全局均值），0..255 尺度。仅作诊断，不用于排峰。 */
export function mad(current, previous) {
  if (!previous) return 0;
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs(current[i] - previous[i]);
  return sum / current.length;
}

/**
 * 变化量度量：取「最大块平均绝对差」。
 *
 * 为什么不用全局平均：全局 mean 会把稀疏的显著变化稀释掉——
 * 比如画面里只有 1% 的面积（一个按钮、一个弹窗）从 100 变到 255，
 * 全局 MAD 只有约 1.6，而一帧全局轻微增亮 12 灰阶却有 12，
 * 排峰就会选错，点击按钮这类关键信息被「均匀抽帧」吞掉。
 *
 * 分块取最大值后，局部大变化（哪怕只占一小块）与全局运动都能被识别：
 * 全局运动时每个块都变，最大块值约等于全局均值；局部突变时最大块值远高于全局均值。
 * 因为最大块值恒 >= 全局均值，它天然把「整体变化」和「局部变化」都算作变化大。
 * 块内取平均（而非单像素最大）以保持抗噪能力。
 */
export function changeScore(current, previous, blockPx = BLOCK_PX) {
  if (!previous) {
    return { score: 0, globalMAD: 0, localPeak: 0, blockCols: 0, blockRows: 0 };
  }
  const cols = Math.ceil(SAMPLE_W / blockPx);
  const rows = Math.ceil(SAMPLE_H / blockPx);
  const blockSum = new Float64Array(cols * rows);
  const blockCount = new Uint32Array(cols * rows);

  let globalSum = 0;
  for (let y = 0; y < SAMPLE_H; y++) {
    const brow = ((y / blockPx) | 0) * cols;
    const row = y * SAMPLE_W;
    for (let x = 0; x < SAMPLE_W; x++) {
      const d = Math.abs(current[row + x] - previous[row + x]);
      globalSum += d;
      const bi = brow + ((x / blockPx) | 0);
      blockSum[bi] += d;
      blockCount[bi]++;
    }
  }

  let localPeak = 0;
  for (let b = 0; b < blockSum.length; b++) {
    if (blockCount[b] > 0) {
      const value = blockSum[b] / blockCount[b];
      if (value > localPeak) localPeak = value;
    }
  }

  return {
    score: localPeak,
    globalMAD: globalSum / current.length,
    localPeak,
    blockCols: cols,
    blockRows: rows,
  };
}

export function formatTimecode(seconds) {
  const ms = Math.max(0, Math.round((seconds ?? 0) * 1000));
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
}
