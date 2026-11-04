/** pts -> 全局槽号。半开区间 [k/20, (k+1)/20)，eps 用来消除浮点边界误差。 */
export function slotIndexOf(pts, slotsPerSecond = 20) {
  const index = Math.floor(pts * slotsPerSecond + 1e-9);
  return index < 0 ? 0 : index;
}

/**
 * 预先铺好定长槽网格。网格长度恒定且补齐到 framesPerSheet 的整数倍，
 * 每个槽永远占一个格子；没有源帧落入的槽保留 empty=true，由 compose 画成空帧。
 * 槽位按时间索引固定，绝不因为缺帧而把后面的帧左移压实。
 */
export function planSlots({ duration, lastPts, slotsPerSecond = 20, framesPerSheet = 4 }) {
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
  const slots = Array.from({ length: total }, (_, i) => ({
    slot: i,
    start: i * slotSec,
    end: (i + 1) * slotSec,
    empty: true,
    reason: i * slotSec > tailEdge ? 'beyond-duration' : 'no-frame',
    pts: null,
    frameIndex: null,
    score: null,
    candidates: 0,
    pickedBy: null,
    buffer: null,
  }));

  return { slotSec, total, slots, sheets: total / framesPerSheet };
}
