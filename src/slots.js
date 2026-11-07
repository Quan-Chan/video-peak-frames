/**
 * pts -> 全局槽号。半开区间 [k/20, (k+1)/20)。
 *
 * toleranceSeconds 只给动图（GIF/APNG）用：它们的 timebase 会把 0.1 秒
 * 换算成 0.09999 这类值，严格按半开区间会落进前一槽。普通视频传 0，
 * 保持原有槽归属逐字节不变。
 */
export function slotIndexOf(pts, slotsPerSecond = 20, toleranceSeconds = 0) {
  const index = Math.floor(pts * slotsPerSecond + toleranceSeconds * slotsPerSecond + 1e-9);
  return index < 0 ? 0 : index;
}

/**
 * 槽网格的纯几何部分。
 *
 * 只算槽宽、槽数、每槽的起止时间与空槽原因，不物化任何槽对象：
 * 超长视频的槽数随时长线性增长，流水线按「图」逐张物化当前 4 个槽即可，
 * 内存不随片长增长。planSlots 也由它物化，两者不会各算一套。
 */
export function slotLayout({ duration, lastPts = null, slotsPerSecond = 20, framesPerSheet = 4 }) {
  const slotSec = 1 / slotsPerSecond;
  const byDuration = Math.ceil(duration / slotSec);
  // 最后一帧所在槽的序号 + 1 即为所需槽数；用与分槽一致的函数避免边界差一。
  const byLastFrame = Number.isFinite(lastPts)
    ? slotIndexOf(lastPts, slotsPerSecond) + 1
    : 0;
  // duration 有效时严格按给定区间算槽数，末帧不得顶出额外的槽；
  // duration 缺失时才用最后一帧兜底。
  let total = duration > 0 ? byDuration : byLastFrame;
  total = Math.max(total, framesPerSheet);
  total = Math.ceil(total / framesPerSheet) * framesPerSheet;

  const tailEdge = Number.isFinite(lastPts) ? lastPts + slotSec : duration;

  return {
    slotSec,
    total,
    sheets: total / framesPerSheet,
    startOf: (index) => index * slotSec,
    endOf: (index) => (index + 1) * slotSec,
    emptyReason: (index) => (index * slotSec > tailEdge ? 'beyond-duration' : 'no-frame'),
  };
}

/**
 * 预先铺好定长槽网格。
 *
 * 网格长度恒定且补齐到 framesPerSheet 的整数倍，每个槽永远占一个格子；
 * 没有源帧落入的槽保留 empty=true，由 compose 画成空帧。
 * 槽位按时间索引固定，绝不因为缺帧而把后面的帧左移压实。
 *
 * 流水线不再调用它（超长视频会一次性建出全部槽对象），保留给需要整表的测试与工具。
 */
export function planSlots({ duration, lastPts, slotsPerSecond = 20, framesPerSheet = 4 }) {
  const layout = slotLayout({ duration, lastPts, slotsPerSecond, framesPerSheet });
  const slots = Array.from({ length: layout.total }, (_, i) => ({
    slot: i,
    start: layout.startOf(i),
    end: layout.endOf(i),
    empty: true,
    reason: layout.emptyReason(i),
    pts: null,
    frameIndex: null,
    score: null,
    candidates: 0,
    pickedBy: null,
    buffer: null,
  }));

  return { slotSec: layout.slotSec, total: layout.total, slots, sheets: layout.sheets };
}
