import { parseLayout, capacityError } from './compose.js';

/** 输出格式 -> 扩展名。jpeg 是 jpg 的别名。 */
export const EXT = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' };

/** 输出格式是否支持 alpha 通道（JPG 不支持）。 */
export function outputSupportsAlpha(format) {
  return format === 'png' || format === 'webp';
}

export function extensionOf(format) {
  return EXT[format] ?? 'jpg';
}

/**
 * 固定模式、自适应模式与预算模式共用的参数校验。
 * 返回后续流程需要的规范化结果；报错文案与旧版保持一致。
 */
export function resolveCommonOptions(options) {
  const { layout, format, framesPerSheet = null, start = 0, end = null } = options;

  const ext = extensionOf(format);
  const { cells: layoutCells } = parseLayout(layout);
  const perSheet = framesPerSheet ?? layoutCells;
  if (perSheet < 1) throw new Error('--frames-per-sheet 至少为 1');
  if (perSheet > layoutCells) {
    throw new Error(capacityError(layout, perSheet, `--frames-per-sheet ${perSheet} 张图片`));
  }

  const startSec = Number(start) || 0;
  const endSec = end == null ? null : Number(end);
  if (startSec < 0) throw new Error('--start 不能为负数');
  if (endSec != null && endSec <= startSec) throw new Error('--end 必须大于 --start');

  return { ext, layoutCells, perSheet, startSec, endSec };
}
