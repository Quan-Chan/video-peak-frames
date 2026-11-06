import sharp from 'sharp';
import { formatTimecode } from './score.js';
import { textToPathData, measureText } from './text-path.js';

const EMPTY_BG = '#14161C';
const UNUSED_BG = '#2A2E38';

/** 时间码合成到格子的预设位置。 */
export const STAMP_POS = ['tl', 'tr', 'bl', 'br', 'c', 't', 'b', 'l', 'r'];
/** 文字排列方向：横（左→右 / 右→左），竖（上→下 / 下→上）。 */
export const STAMP_DIR = ['h-lr', 'h-rl', 'v-tb', 'v-bt'];

/** 通用排版解析：CxR，如 2x2 / 2x1 / 1x1 / 3x2。 */
export function parseLayout(text) {
  const match = /^(\d+)x(\d+)$/i.exec(String(text).trim());
  if (!match) {
    throw new Error(`排版应写成 列x行，例如 2x2 / 2x1 / 1x1 / 3x2，收到：${text}`);
  }
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`排版的列和行都必须是正整数，收到：${text}`);
  }
  const cells = cols * rows;
  if (cells > 64) throw new Error(`排版格子数 ${cells} 过大，最多 64 格`);
  return { cols, rows, cells };
}

/** 格子数不足以容纳所需帧数时的统一报错文案（CLI 与流水线共用）。 */
export function capacityError(layout, needed, what = `${needed} 张图片`) {
  const { cols, rows, cells } = parseLayout(layout);
  return `排版 ${layout}（${cols} 列 × ${rows} 行）只有 ${cells} 格，容纳不下 ${what}。` +
    `请换更大的排版（如 ${suggestLayout(needed)}），或降低每图帧数`;
}

/**
 * 时间码合成层。
 *
 * 文字用 Roboto Mono（SIL OFL 1.1，可商用可分发）的字形轮廓渲染成 SVG path，
 * 不使用 SVG <text>，因此不依赖任何系统自带字体。
 * 竖排不依赖 librsvg 的 writing-mode，逐字符定位，四种方向共用一套坐标；
 * 块放不下时按比例缩小字号。
 */
export function stampSvg(width, height, text, { pos = 'tl', dir = 'h-lr', color = '#FFFFFF' } = {}) {
  if (!STAMP_POS.includes(pos)) {
    throw new Error(`时间码位置 ${pos} 无效，可选：${STAMP_POS.join(' / ')}`);
  }
  if (!STAMP_DIR.includes(dir)) {
    throw new Error(`文字方向 ${dir} 无效，可选：${STAMP_DIR.join(' / ')}`);
  }

  const chars = [...String(text)];
  const vertical = dir === 'v-tb' || dir === 'v-bt';

  const measure = (size) => {
    const cw = measureText('0', size); // 等宽字体，任取一字宽即可
    const lh = size * 1.28;
    const textW = vertical ? cw : chars.length * cw;
    const textH = vertical ? chars.length * lh : lh;
    return {
      cw, lh, textW, textH,
      blockW: textW + size * 0.8,
      blockH: textH + size * 0.55,
    };
  };

  let size = Math.max(11, Math.min(22, Math.round(Math.min(width, height) * 0.05)));
  let box = measure(size);
  const scale = Math.min(1, (width - 10) / box.blockW, (height - 10) / box.blockH);
  if (scale < 1) {
    size = Math.max(10, Math.floor(size * scale));
    box = measure(size);
  }

  const { cw, lh, textW, textH, blockW, blockH } = box;
  const [bx, by] = {
    tl: [5, 5],
    tr: [width - 5 - blockW, 5],
    bl: [5, height - 5 - blockH],
    br: [width - 5 - blockW, height - 5 - blockH],
    c: [(width - blockW) / 2, (height - blockH) / 2],
    t: [(width - blockW) / 2, 5],
    b: [(width - blockW) / 2, height - 5 - blockH],
    l: [5, (height - blockH) / 2],
    r: [width - 5 - blockW, (height - blockH) / 2],
  }[pos];

  const tx = bx + (blockW - textW) / 2;
  const ty = by + (blockH - textH) / 2;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${blockW.toFixed(1)}" height="${blockH.toFixed(1)}" rx="4" fill="#000000" fill-opacity="0.66"/>`;

  for (let i = 0; i < chars.length; i++) {
    const k = vertical
      ? (dir === 'v-bt' ? chars.length - 1 - i : i)
      : (dir === 'h-rl' ? chars.length - 1 - i : i);
    let cx;
    let cy;
    if (vertical) {
      cx = tx + textW / 2;
      cy = ty + (k + 0.76) * lh;
    } else {
      cx = tx + k * cw + cw / 2;
      cy = ty + textH * 0.76;
    }
    const charW = measureText(chars[i], size);
    svg += `<path d="${textToPathData(chars[i], cx - charW / 2, cy, size)}" fill="${color}"/>`;
  }
  return Buffer.from(svg + '</svg>');
}

/** 即使关掉时间码，空帧格也保留淡色横杠，避免和真实的全黑画面混淆。 */
function emptyMarkSvg(width, height) {
  const w = Math.min(56, Math.round(width * 0.2));
  const x = Math.round((width - w) / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${x}" y="${Math.round(height / 2)}" width="${w}" height="2" rx="1" fill="#59606E"/>` +
    `</svg>`
  );
}

/**
 * 单格合成层：帧本身（或空帧/未用格底色）、空帧横杠、时间码。
 * 返回 sharp 的 overlay 描述，由 composeSheet 一次合到整张画布上，
 * 避免「每格编码成 PNG 再解码回画布」的往返开销。
 */
function cellOverlays(cell, cellWidth, cellHeight, stamp, left, top) {
  const unused = cell.unused === true;
  const empty = !unused && cell.empty === true;
  const overlays = [];

  if (cell.buffer && !unused) {
    overlays.push({
      input: cell.buffer,
      raw: { width: cellWidth, height: cellHeight, channels: 3 },
      left,
      top,
    });
  } else {
    overlays.push({
      input: { create: { width: cellWidth, height: cellHeight, channels: 3, background: unused ? UNUSED_BG : EMPTY_BG } },
      left,
      top,
    });
  }

  if (empty) overlays.push({ input: emptyMarkSvg(cellWidth, cellHeight), left, top });
  if (stamp && !unused) {
    const label = empty
      ? `EMPTY ${formatTimecode(cell.stampTime ?? cell.start)}`
      : formatTimecode(cell.stampTime ?? cell.pts ?? cell.start);
    overlays.push({ input: stampSvg(cellWidth, cellHeight, label, stamp), left, top });
  }
  return overlays;
}

/** 质量 -> PNG 压缩级别（png 无损，quality 高 = 更快更大）。 */
function pngLevel(quality) {
  return Math.max(0, Math.min(9, Math.round((100 - quality) / 11)));
}

export async function composeSheet({
  cells, cellWidth, cellHeight, layout, outFile,
  format, quality, annotate = true, gap = 4,
  stampPos = 'tl', stampDir = 'h-lr',
}) {
  const { cols, rows, cells: totalCells } = parseLayout(layout);

  if (cells.length > totalCells) {
    throw new Error(capacityError(layout, cells.length));
  }

  const width = cols * cellWidth + (cols + 1) * gap;
  const height = rows * cellHeight + (rows + 1) * gap;
  const stamp = annotate ? { pos: stampPos, dir: stampDir } : null;
  const overlays = [];

  for (let i = 0; i < totalCells; i++) {
    const cell = cells[i] ?? { unused: true, empty: true, start: null };
    const left = gap + (i % cols) * (cellWidth + gap);
    const top = gap + Math.floor(i / cols) * (cellHeight + gap);
    overlays.push(...cellOverlays(cell, cellWidth, cellHeight, stamp, left, top));
  }

  const image = sharp({ create: { width, height, channels: 3, background: '#FFFFFF' } })
    .composite(overlays);

  if (format === 'png') await image.png({ compressionLevel: pngLevel(quality) }).toFile(outFile);
  else if (format === 'webp') await image.webp({ quality }).toFile(outFile);
  else await image.jpeg({ quality }).toFile(outFile);

  return { width, height, cells: totalCells };
}

function suggestLayout(n) {
  for (const [cols, rows] of [[n, 1], [1, n], [Math.ceil(n / 2), 2], [Math.ceil(Math.sqrt(n)), Math.ceil(n / Math.ceil(Math.sqrt(n)))]] ) {
    if (cols * rows >= n && cols * rows <= 64) return `${cols}x${rows}`;
  }
  return '2x2';
}
