import path from 'node:path';

/** 视频名清洗：去掉路径分隔符与 Windows 文件名非法字符，空白压成单空格。 */
export function sanitizeVideoName(input) {
  const base = path.basename(input, path.extname(input));
  const safe = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || 'video';
}

export function fmtSec(value) {
  return Number(value).toFixed(2);
}

/** 文件名统一携带元信息：视频名 / 时间区间 / 质量 / 排版 / 序号。 */
export function buildFileName({ videoName, startSec, endSec, quality, layout, index, ext }) {
  return `${videoName}__t${fmtSec(startSec)}s-${fmtSec(endSec)}s__q${quality}__${layout}__${String(index).padStart(5, '0')}.${ext}`;
}
