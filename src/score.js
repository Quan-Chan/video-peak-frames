// 打分用的降采样分辨率。提到 320x180 是为了别把小尺寸 UI 变化（按钮、弹窗、
// 进度条）在降采样阶段就抹掉——160x90 对 1440p 素材是 12:1，会吞掉这类关键信息。
export const SAMPLE_W = 320;
export const SAMPLE_H = 180;
/** 分块边长（采样像素）。16x16 在 320x180 上得到 20x12 块。 */
export const BLOCK_PX = 16;

/**
 * 把 rgb24 / rgba 帧做区域平均降采样成灰度图。
 *
 * 采样网格只与输入尺寸有关，按「尺寸 + 通道数」缓存采样器，逐帧复用：
 * 取整、边界与倒数权重都在建表时算好，逐帧只剩像素累加。
 * 区域平均本身就是低通，用来压掉编码噪点与颗粒，避免「变化最大」选到噪点帧。
 *
 * 4 通道（RGBA）输入用于输出 PNG/WebP 时保留透明通道的场景：打分仍按
 * 「透明像素合成到黑色」计算（channel × alpha / 255），与旧版把整帧压到
 * 黑底的打分结果一致，不透明视频的分数完全不受影响。
 */
const samplerCache = new Map();

function buildSampler(width, height, channels) {
  const x0 = new Uint16Array(SAMPLE_W);
  const x1 = new Uint16Array(SAMPLE_W);
  const y0 = new Uint16Array(SAMPLE_H);
  const y1 = new Uint16Array(SAMPLE_H);
  const invCount = new Float64Array(SAMPLE_W * SAMPLE_H);
  const xStep = width / SAMPLE_W;
  const yStep = height / SAMPLE_H;

  for (let sx = 0; sx < SAMPLE_W; sx++) {
    const from = Math.floor(sx * xStep);
    x0[sx] = from;
    x1[sx] = Math.min(width, Math.max(from + 1, Math.ceil((sx + 1) * xStep)));
  }
  for (let sy = 0; sy < SAMPLE_H; sy++) {
    const from = Math.floor(sy * yStep);
    const to = Math.min(height, Math.max(from + 1, Math.ceil((sy + 1) * yStep)));
    y0[sy] = from;
    y1[sy] = to;
    for (let sx = 0; sx < SAMPLE_W; sx++) {
      invCount[sy * SAMPLE_W + sx] = 1 / ((x1[sx] - x0[sx]) * (to - from));
    }
  }

  return function gray(rgb, out) {
    let o = 0;
    for (let sy = 0; sy < SAMPLE_H; sy++) {
      const fromY = y0[sy];
      const toY = y1[sy];
      for (let sx = 0; sx < SAMPLE_W; sx++) {
        const fromX = x0[sx];
        const toX = x1[sx];

        if (channels === 4) {
          // 先按 alpha 加权累加，再统一换算到 0..255：等价于把透明像素
          // 合成到黑色底之后再取亮度。
          let r = 0;
          let g = 0;
          let b = 0;
          for (let y = fromY; y < toY; y++) {
            let p = (y * width + fromX) * 4;
            for (let x = fromX; x < toX; x++) {
              const alpha = rgb[p + 3];
              r += rgb[p] * alpha;
              g += rgb[p + 1] * alpha;
              b += rgb[p + 2] * alpha;
              p += 4;
            }
          }
          out[o] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * invCount[o] / 255);
          o++;
          continue;
        }

        // rgb24：先分别累加 R/G/B，再统一乘亮度系数，比逐像素算亮度少一次乘加。
        let r = 0;
        let g = 0;
        let b = 0;
        for (let y = fromY; y < toY; y++) {
          let p = (y * width + fromX) * 3;
          for (let x = fromX; x < toX; x++) {
            r += rgb[p];
            g += rgb[p + 1];
            b += rgb[p + 2];
            p += 3;
          }
        }
        out[o] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * invCount[o]);
        o++;
      }
    }
    return out;
  };
}

export function getGraySampler(width, height, channels = 3) {
  const key = `${width}x${height}x${channels}`;
  let sampler = samplerCache.get(key);
  if (!sampler) {
    sampler = buildSampler(width, height, channels);
    samplerCache.set(key, sampler);
  }
  return sampler;
}

export function toGray(rgb, width, height, out = new Uint8Array(SAMPLE_W * SAMPLE_H), channels = 3) {
  return getGraySampler(width, height, channels)(rgb, out);
}

/** 相邻帧平均绝对差（全局均值），0..255 尺度。仅作诊断，不用于排峰。 */
export function mad(current, previous) {
  if (!previous) return 0;
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs(current[i] - previous[i]);
  return sum / current.length;
}

/** 每个采样像素所属的块号与块内像素数，只与 blockPx 有关，按值缓存。 */
const blockMapCache = new Map();

function getBlockMap(blockPx) {
  let map = blockMapCache.get(blockPx);
  if (!map) {
    const cols = Math.ceil(SAMPLE_W / blockPx);
    const rows = Math.ceil(SAMPLE_H / blockPx);
    const blockOf = new Uint16Array(SAMPLE_W * SAMPLE_H);
    const counts = new Uint32Array(cols * rows);
    for (let y = 0; y < SAMPLE_H; y++) {
      const row = y * SAMPLE_W;
      const blockRow = ((y / blockPx) | 0) * cols;
      for (let x = 0; x < SAMPLE_W; x++) {
        const block = blockRow + ((x / blockPx) | 0);
        blockOf[row + x] = block;
        counts[block]++;
      }
    }
    map = { cols, rows, blockOf, counts };
    blockMapCache.set(blockPx, map);
  }
  return map;
}

/**
 * 打分缓冲：逐帧复用，避免每帧重新分配块累加数组。
 * 值只由 --block-size 决定，一次运行内固定。
 */
export function createScoreScratch(blockPx = BLOCK_PX) {
  const map = getBlockMap(blockPx);
  return { map, sums: new Float64Array(map.cols * map.rows) };
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
export function changeScore(current, previous, blockPx = BLOCK_PX, scratch = null) {
  if (!previous) {
    return { score: 0, globalMAD: 0, localPeak: 0, blockCols: 0, blockRows: 0 };
  }
  const map = scratch?.map ?? getBlockMap(blockPx);
  const sums = scratch?.sums ?? new Float64Array(map.cols * map.rows);
  const { blockOf, counts } = map;
  sums.fill(0);

  let globalSum = 0;
  for (let i = 0; i < current.length; i++) {
    const diff = current[i] - previous[i];
    const abs = diff < 0 ? -diff : diff;
    globalSum += abs;
    sums[blockOf[i]] += abs;
  }

  let localPeak = 0;
  for (let b = 0; b < sums.length; b++) {
    const value = sums[b] / counts[b];
    if (value > localPeak) localPeak = value;
  }

  return {
    score: localPeak,
    globalMAD: globalSum / current.length,
    localPeak,
    blockCols: map.cols,
    blockRows: map.rows,
  };
}

export function formatTimecode(seconds) {
  const ms = Math.max(0, Math.round((seconds ?? 0) * 1000));
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
}
