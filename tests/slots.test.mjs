import test from 'node:test';
import assert from 'node:assert/strict';
import { slotIndexOf, planSlots, slotLayout } from '../src/slots.js';

test('50ms 槽边界按半开区间归属', () => {
  assert.equal(slotIndexOf(0, 20), 0);
  assert.equal(slotIndexOf(0.049, 20), 0);
  assert.equal(slotIndexOf(0.05, 20), 1);
  assert.equal(slotIndexOf(0.099, 20), 1);
  assert.equal(slotIndexOf(0.1, 20), 2);
  assert.equal(slotIndexOf(0.15, 20), 3);
  assert.equal(slotIndexOf(0.2, 20), 4);
});

test('10fps 素材：奇数槽为空且槽位不压实（对应流程图的 0 / 空帧1 / 0.1 / 空帧2 / 0.2）', () => {
  const pts = Array.from({ length: 10 }, (_, i) => i / 10);
  const plan = planSlots({ duration: 1, lastPts: 0.9, slotsPerSecond: 20, framesPerSheet: 4 });

  assert.equal(plan.total, 20);
  assert.equal(plan.sheets, 5);

  const filled = new Set(pts.map((p) => slotIndexOf(p, 20)));
  for (const slot of plan.slots) {
    if (filled.has(slot.slot)) {
      slot.empty = false;
      slot.pts = slot.start;
    }
  }

  const firstFive = plan.slots.slice(0, 5).map((s) =>
    s.empty ? 'EMPTY' : Number(s.start.toFixed(2))
  );
  assert.deepEqual(firstFive, [0, 'EMPTY', 0.1, 'EMPTY', 0.2]);
  assert.equal(plan.slots.filter((s) => !s.empty).length, 10);
  assert.equal(plan.slots.filter((s) => s.empty).length, 10);

  // 第 2 张图从第 4 槽（0.2s）开始，0.2 没有被左移去补前面的空位。
  assert.equal(plan.slots[4].empty, false);
  assert.equal(Number(plan.slots[4].start.toFixed(2)), 0.2);
});

test('片尾不足 4 槽时补齐成完整一张图', () => {
  const plan = planSlots({ duration: 0.21, lastPts: 0.2, slotsPerSecond: 20, framesPerSheet: 4 });
  assert.equal(plan.total, 8);
  assert.equal(plan.sheets, 2);
  assert.equal(plan.slots.length % 4, 0);
  assert.equal(plan.slots[7].reason, 'beyond-duration');
});

test('slotLayout 与 planSlots 的槽几何一致', () => {
  const cases = [
    { duration: 1, lastPts: 0.9, slotsPerSecond: 20, framesPerSheet: 4 },
    { duration: 0.21, lastPts: 0.2, slotsPerSecond: 20, framesPerSheet: 4 },
    { duration: 16.333333, lastPts: null, slotsPerSecond: 20, framesPerSheet: 4 },
    { duration: 0, lastPts: null, slotsPerSecond: 10, framesPerSheet: 2 },
  ];
  for (const options of cases) {
    const layout = slotLayout(options);
    const plan = planSlots(options);
    assert.equal(layout.total, plan.total);
    assert.equal(layout.sheets, plan.sheets);
    assert.equal(layout.slotSec, plan.slotSec);
    for (const slot of plan.slots) {
      assert.equal(layout.startOf(slot.slot), slot.start);
      assert.equal(layout.endOf(slot.slot), slot.end);
      assert.equal(layout.emptyReason(slot.slot), slot.reason);
    }
  }
});

test('60fps 素材每个槽都有候选帧', () => {
  const pts = Array.from({ length: 60 }, (_, i) => i / 60);
  const plan = planSlots({ duration: 1, lastPts: 59 / 60, slotsPerSecond: 20, framesPerSheet: 4 });
  const counts = new Array(plan.total).fill(0);
  for (const p of pts) counts[slotIndexOf(p, 20)]++;
  assert.equal(plan.total, 20);
  assert.ok(counts.every((n) => n >= 2), `存在空槽：${counts.join(',')}`);
});
