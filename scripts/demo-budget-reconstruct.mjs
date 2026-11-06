import path from 'node:path';
import { runSamplingDemo } from './lib/sampling-demo.mjs';

const PROJECT = path.resolve('.');

runSamplingDemo({
  project: PROJECT,
  extractArgs: ['--budget'],
  outRoot: path.join(PROJECT, '输出', '预算采样'),
  fixedReconRoot: path.join(PROJECT, '输出', '默认参数重建', '重建'),
  rightLabel: 'RIGHT: BUDGET 15 fps (480x270, 2x)',
  bottomLabel: 'BUDGET 15 fps',
  reconTitleLines: [
    { text: 'FIXED BUDGET SAMPLING', size: 20, y: 70, bold: true },
    { text: 'DEFAULT: 15 fps BUDGET / 1-30 fps PER 1s WINDOW', size: 11, y: 108, color: '0xCCCCCC' },
    { text: 'Optimal allocation by change, exact frame count', size: 11, y: 132, color: '0xAAAAAA' },
  ],
  compareTitleLines: [
    { text: 'BUDGET vs ORIGINAL', size: 40, y: 160 },
    { text: 'DEFAULT: 15 fps BUDGET / 1-30 fps PER 1s WINDOW', size: 24, y: 240, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL (960x540)        RIGHT: BUDGET (480x270, 2x)', size: 22, y: 310, color: '0xAAAAAA' },
  ],
  compare3TitleLines: [
    { text: 'BUDGET vs 20 fps DEFAULT', size: 40, y: 150 },
    { text: 'DEFAULT: 15 fps BUDGET / 1-30 fps PER 1s WINDOW', size: 24, y: 225, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL | TOP RIGHT: 20 fps | BOTTOM RIGHT: BUDGET', size: 22, y: 300, color: '0xAAAAAA' },
  ],
  reconOutputName: '全部_预算重建.mp4',
  compareOutputName: '全部_左右对比.mp4',
  compare3OutputName: '全部_三路对比.mp4',
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
