import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, ensureBinaries } from '../src/probe.js';
import { decodeFrames } from '../src/decode.js';
import {
  getGraySampler, changeScore, createScoreScratch, BLOCK_PX, SAMPLE_W, SAMPLE_H,
} from '../src/score.js';
import { run } from '../src/pipeline.js';

// 分析对象：当前平滑预算模式 vs 常规 15fps 均匀取最大变化。
// 两边总帧数都在 15 fps 左右，逐帧比较「捕获到的变化」与「播放时相邻帧之间的差异」。

const PROJECT = path.resolve('.');
const SOURCE_ROOT = path.join(PROJECT, '用户提供的内容');
const OUT_DIR = path.join(PROJECT, '输出', '预算采样');
const WORK_ROOT = path.join(os.tmpdir(), 'vpf-budget-diff');
const BASE_CELL = { cellWidth: 480, cellHeight: 270 };
const BASE_IMAGE = { layout: '2x2', format: 'jpg', quality: 90, annotate: true, gap: 4 };

function stats(values) {
  if (!values.length) return { mean: 0, p90: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))];
  return {
    mean: sum / sorted.length,
    p90: at(0.9),
    max: sorted[sorted.length - 1],
  };
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

/** 同时跑一遍预算模式与固定 15fps 模式的 dry-run，拿到两边选中的帧与得分。 */
async function buildManifests(video, base) {
  const budgetDir = path.join(WORK_ROOT, base, 'budget');
  const uniformDir = path.join(WORK_ROOT, base, 'uniform');
  const budget = await run({
    input: video, outDir: budgetDir, ...BASE_CELL, ...BASE_IMAGE,
    budget: true, budgetFps: 15, minFps: 1, maxFps: 30,
    noiseFloor: 0, dryRun: true, quiet: true,
  });
  const uniform = await run({
    input: video, outDir: uniformDir, ...BASE_CELL, ...BASE_IMAGE,
    adaptive: false, budget: false, slotsPerSecond: 15,
    noiseFloor: 0, dryRun: true, quiet: true,
  });
  return {
    budget: { manifest: budget, cells: budget.sheets.flatMap((sheet) => sheet.cells).filter((cell) => !cell.empty) },
    uniform: { manifest: uniform, cells: uniform.sheets.flatMap((sheet) => sheet.cells).filter((cell) => !cell.empty) },
  };
}

/** 第一遍只解一遍，把两套策略用到的那几十帧灰度图留下来，供帧间差异计算。 */
async function collectGrays(video, frameIndexes) {
  const needed = new Set(frameIndexes);
  const sampler = getGraySampler(480, 270);
  const grays = new Map();
  for await (const frame of decodeFrames({ input: video, cellWidth: 480, cellHeight: 270 })) {
    if (!needed.has(frame.index)) continue;
    const gray = new Uint8Array(SAMPLE_W * SAMPLE_H);
    sampler(frame.buffer, gray);
    grays.set(frame.index, gray);
    if (grays.size === needed.size) break;
  }
  return grays;
}

/** 相邻选中帧之间的变化量：即播放时每次换帧的视觉跳变。 */
function playbackDiffs(cells, grays) {
  const ordered = cells.slice().sort((a, b) => a.frameIndex - b.frameIndex);
  const scratch = createScoreScratch(BLOCK_PX);
  const diffs = [];
  let previous = null;
  for (const cell of ordered) {
    const gray = grays.get(cell.frameIndex);
    if (!gray) continue;
    if (previous) diffs.push(changeScore(gray, previous, BLOCK_PX, scratch).score);
    previous = gray;
  }
  return diffs;
}

/**
 * 两套策略的选帧关系：完全同帧比例、平均最近帧距，并把每个预算帧匹配到最近的均匀帧，
 * 供后续比较「同一时间附近，两套策略选出的画面差多少」。
 */
function matchSelections(budgetCells, uniformCells) {
  const uniformByFrame = new Map(uniformCells.map((cell) => [cell.frameIndex, cell]));
  const uniformIndexes = [...uniformByFrame.keys()].sort((a, b) => a - b);
  const budgetSet = new Set(budgetCells.map((cell) => cell.frameIndex));
  const pairs = [];
  let exact = 0;
  let nearestSum = 0;

  for (const cell of budgetCells) {
    if (uniformByFrame.has(cell.frameIndex)) exact++;
    let low = 0;
    let high = uniformIndexes.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (uniformIndexes[mid] < cell.frameIndex) low = mid + 1;
      else high = mid;
    }
    const nearest = uniformByFrame.get(uniformIndexes[low]);
    nearestSum += Math.abs(cell.pts - nearest.pts);
    pairs.push({ budget: cell, uniform: nearest, same: cell.frameIndex === nearest.frameIndex });
  }

  const uniformMatched = uniformIndexes.filter((frameIndex) => budgetSet.has(frameIndex)).length;
  return {
    exactRatio: exact / budgetCells.length,
    uniformMatchedRatio: uniformMatched / uniformIndexes.length,
    meanNearestSeconds: nearestSum / budgetCells.length,
    pairs,
  };
}

function formatTable(rows, columns) {
  const header = '| ' + columns.map((column) => column.label).join(' | ') + ' |';
  const divider = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map((row) => '| ' + columns.map((column) => row[column.key]).join(' | ') + ' |');
  return [header, divider, ...body].join('\n');
}

async function main() {
  await ensureBinaries();
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = fs.readdirSync(SOURCE_ROOT).filter((name) => /\.mp4$/i.test(name)).sort();

  const rows = [];
  const allBudgetDiffs = [];
  const allUniformDiffs = [];
  const allBudgetScores = [];
  const allUniformScores = [];
  const allMatchedDiffs = [];
  let totalBudgetFrames = 0;
  let totalUniformFrames = 0;
  let totalExact = 0;
  let totalUniformMatched = 0;
  let totalNearest = 0;
  let totalBudgetDuration = 0;

  for (const name of names) {
    const base = name.replace(/\.mp4$/i, '');
    const video = path.join(SOURCE_ROOT, name);
    console.log('analyze ' + base);
    const info = await probe(video);
    const { budget, uniform } = await buildManifests(video, base);

    const budgetFrames = budget.cells.map((cell) => cell.frameIndex);
    const uniformFrames = uniform.cells.map((cell) => cell.frameIndex);
    const grays = await collectGrays(video, [...budgetFrames, ...uniformFrames]);

    const budgetDiffs = playbackDiffs(budget.cells, grays);
    const uniformDiffs = playbackDiffs(uniform.cells, grays);
    const budgetScores = budget.cells.map((cell) => cell.score);
    const uniformScores = uniform.cells.map((cell) => cell.score);
    const selection = matchSelections(budget.cells, uniform.cells);

    // 两套策略在同一时间附近选出的画面差多少：只统计「不是同一帧」的匹配对。
    const pairScratch = createScoreScratch(BLOCK_PX);
    const matchedDiffs = [];
    for (const pair of selection.pairs) {
      if (pair.same) continue;
      const budgetGray = grays.get(pair.budget.frameIndex);
      const uniformGray = grays.get(pair.uniform.frameIndex);
      if (budgetGray && uniformGray) {
        matchedDiffs.push(changeScore(budgetGray, uniformGray, BLOCK_PX, pairScratch).score);
      }
    }

    allBudgetDiffs.push(...budgetDiffs);
    allUniformDiffs.push(...uniformDiffs);
    allBudgetScores.push(...budgetScores);
    allUniformScores.push(...uniformScores);
    allMatchedDiffs.push(...matchedDiffs);
    totalBudgetFrames += budget.cells.length;
    totalUniformFrames += uniform.cells.length;
    totalExact += Math.round(selection.exactRatio * budget.cells.length);
    totalUniformMatched += Math.round(selection.uniformMatchedRatio * uniform.cells.length);
    totalNearest += selection.meanNearestSeconds * budget.cells.length;
    totalBudgetDuration += info.duration;

    const gap = (cells) => {
      const ordered = cells.slice().sort((a, b) => a.frameIndex - b.frameIndex);
      const gaps = [];
      for (let index = 1; index < ordered.length; index++) gaps.push(ordered[index].pts - ordered[index - 1].pts);
      return stats(gaps);
    };
    const budgetGap = gap(budget.cells);
    const uniformGap = gap(uniform.cells);
    const budgetDiffStats = stats(budgetDiffs);
    const uniformDiffStats = stats(uniformDiffs);
    const budgetScoreStats = stats(budgetScores);
    const uniformScoreStats = stats(uniformScores);
    const matchedDiffStats = stats(matchedDiffs);

    rows.push({
      name: base,
      duration: round(info.duration),
      budgetFrames: budget.cells.length,
      uniformFrames: uniform.cells.length,
      budgetFps: round(budget.cells.length / info.duration),
      uniformFps: round(uniform.cells.length / info.duration),
      exactRatio: round(selection.exactRatio * 100, 1) + '%',
      uniformMatchedRatio: round(selection.uniformMatchedRatio * 100, 1) + '%',
      nearestMs: round(selection.meanNearestSeconds * 1000, 1),
      matchedDiffMean: round(matchedDiffStats.mean),
      matchedDiffP90: round(matchedDiffStats.p90),
      matchedDiffMax: round(matchedDiffStats.max),
      budgetScoreMean: round(budgetScoreStats.mean),
      uniformScoreMean: round(uniformScoreStats.mean),
      scoreRatio: round(budgetScoreStats.mean / uniformScoreStats.mean, 3),
      budgetScoreSum: round(budgetScores.reduce((sum, value) => sum + value, 0), 1),
      uniformScoreSum: round(uniformScores.reduce((sum, value) => sum + value, 0), 1),
      budgetDiffMean: round(budgetDiffStats.mean),
      uniformDiffMean: round(uniformDiffStats.mean),
      diffRatio: round(budgetDiffStats.mean / uniformDiffStats.mean, 3),
      budgetDiffP90: round(budgetDiffStats.p90),
      uniformDiffP90: round(uniformDiffStats.p90),
      budgetDiffMax: round(budgetDiffStats.max),
      uniformDiffMax: round(uniformDiffStats.max),
      budgetGapMean: round(budgetGap.mean * 1000, 1),
      uniformGapMean: round(uniformGap.mean * 1000, 1),
      budgetGapMax: round(budgetGap.max * 1000, 1),
      uniformGapMax: round(uniformGap.max * 1000, 1),
    });
  }

  const totalBudgetScore = stats(allBudgetScores);
  const totalUniformScore = stats(allUniformScores);
  const totalBudgetDiff = stats(allBudgetDiffs);
  const totalUniformDiff = stats(allUniformDiffs);
  const totalMatchedDiff = stats(allMatchedDiffs);
  const summary = {
    videos: rows.length,
    durationSeconds: round(totalBudgetDuration),
    budgetFrames: totalBudgetFrames,
    uniformFrames: totalUniformFrames,
    budgetFps: round(totalBudgetFrames / totalBudgetDuration),
    uniformFps: round(totalUniformFrames / totalBudgetDuration),
    exactRatio: round(totalExact / totalBudgetFrames * 100, 1),
    uniformMatchedRatio: round(totalUniformMatched / totalUniformFrames * 100, 1),
    nearestMs: round(totalNearest / totalBudgetFrames * 1000, 1),
    matchedDiffMean: round(totalMatchedDiff.mean),
    matchedDiffP90: round(totalMatchedDiff.p90),
    matchedDiffMax: round(totalMatchedDiff.max),
    budgetScoreMean: round(totalBudgetScore.mean),
    uniformScoreMean: round(totalUniformScore.mean),
    scoreRatio: round(totalBudgetScore.mean / totalUniformScore.mean, 3),
    budgetDiffMean: round(totalBudgetDiff.mean),
    uniformDiffMean: round(totalUniformDiff.mean),
    diffRatio: round(totalBudgetDiff.mean / totalUniformDiff.mean, 3),
    budgetDiffP90: round(totalBudgetDiff.p90),
    uniformDiffP90: round(totalUniformDiff.p90),
    budgetDiffMax: round(totalBudgetDiff.max),
    uniformDiffMax: round(totalUniformDiff.max),
  };

  const table1 = formatTable(rows, [
    { key: 'name', label: '素材' },
    { key: 'duration', label: '时长(s)' },
    { key: 'budgetFrames', label: '预算帧数' },
    { key: 'uniformFrames', label: '均匀帧数' },
    { key: 'budgetFps', label: '预算平均fps' },
    { key: 'uniformFps', label: '均匀平均fps' },
  ]);

  const table2 = formatTable(rows, [
    { key: 'name', label: '素材' },
    { key: 'budgetScoreMean', label: '预算捕获均值' },
    { key: 'uniformScoreMean', label: '均匀捕获均值' },
    { key: 'scoreRatio', label: '预算/均匀' },
    { key: 'budgetScoreSum', label: '预算捕获总和' },
    { key: 'uniformScoreSum', label: '均匀捕获总和' },
  ]);

  const table3 = formatTable(rows, [
    { key: 'name', label: '素材' },
    { key: 'budgetDiffMean', label: '预算帧间差均值' },
    { key: 'uniformDiffMean', label: '均匀帧间差均值' },
    { key: 'diffRatio', label: '预算/均匀' },
    { key: 'budgetDiffP90', label: '预算P90' },
    { key: 'uniformDiffP90', label: '均匀P90' },
    { key: 'budgetGapMean', label: '预算换帧间隔均值(ms)' },
    { key: 'uniformGapMean', label: '均匀换帧间隔均值(ms)' },
  ]);

  const table4 = formatTable(rows, [
    { key: 'name', label: '素材' },
    { key: 'exactRatio', label: '预算帧与均匀同帧' },
    { key: 'uniformMatchedRatio', label: '均匀帧被预算命中' },
    { key: 'nearestMs', label: '平均最近帧距(ms)' },
    { key: 'matchedDiffMean', label: '不同选帧差异均值' },
    { key: 'matchedDiffP90', label: '不同选帧差异P90' },
    { key: 'budgetGapMax', label: '预算最大间隔(ms)' },
    { key: 'uniformGapMax', label: '均匀最大间隔(ms)' },
  ]);

  const markdown = [
    '# 预算 15fps 与均匀 15fps 的逐帧差异分析',
    '',
    '对比对象：当前平滑预算采样（默认 15 fps 预算）与常规均匀 15fps 采样（每 1/15 秒取变化最大帧）。',
    '两边都使用 480x270 单格、同一套局部峰值变化量（320x180、16px 分块）。',
    '',
    '指标说明：',
    '- 捕获变化：选中帧在所属时间槽内的局部峰值得分，越大代表该帧本身变化越明显；',
    '- 帧间差异：播放时相邻两个选中帧之间的局部峰值差异，代表换帧时的视觉跳变；',
    '- 不同选帧差异：预算帧与「时间最近的均匀帧」不是同一帧时，两帧画面之间的局部峰值差异；',
    '- 完全同帧 / 均匀帧被命中：两套策略是否选中了完全相同的解码帧。',
    '',
    '## 1. 帧数与平均帧率',
    '',
    table1,
    '',
    '## 2. 捕获变化对比',
    '',
    table2,
    '',
    '## 3. 播放时的帧间差异',
    '',
    table3,
    '',
    '## 4. 选帧重合度与换帧间隔',
    '',
    table4,
    '',
    '## 合计',
    '',
    '- 总时长：' + summary.durationSeconds + ' s；预算 ' + summary.budgetFrames + ' 帧（' + summary.budgetFps + ' fps），均匀 ' + summary.uniformFrames + ' 帧（' + summary.uniformFps + ' fps）',
    '- 捕获变化均值：预算 ' + summary.budgetScoreMean + '，均匀 ' + summary.uniformScoreMean + '，比值 ' + summary.scoreRatio,
    '- 帧间差异均值：预算 ' + summary.budgetDiffMean + '，均匀 ' + summary.uniformDiffMean + '，比值 ' + summary.diffRatio,
    '- 帧间差异 P90：预算 ' + summary.budgetDiffP90 + '，均匀 ' + summary.uniformDiffP90,
    '- 不同选帧差异：均值 ' + summary.matchedDiffMean + '，P90 ' + summary.matchedDiffP90 + '，最大 ' + summary.matchedDiffMax,
    '- 完全同帧比例：' + summary.exactRatio + '%；均匀帧被预算命中比例：' + summary.uniformMatchedRatio + '%；平均最近帧距：' + summary.nearestMs + ' ms',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT_DIR, '15帧均匀对比.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, '15帧均匀对比.json'), JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log('\n' + markdown);
  console.log('written: ' + path.join(OUT_DIR, '15帧均匀对比.md'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
