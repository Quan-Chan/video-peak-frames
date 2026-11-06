import path from 'node:path';
import { runSamplingDemo } from './lib/sampling-demo.mjs';

const PROJECT = path.resolve('.');

runSamplingDemo({
  project: PROJECT,
  extractArgs: ['--adaptive'],
  outRoot: path.join(PROJECT, '输出', '自适应采样'),
  fixedReconRoot: path.join(PROJECT, '输出', '默认参数重建', '重建'),
  rightLabel: 'RIGHT: ADAPTIVE (480x270, 2x)',
  bottomLabel: 'ADAPTIVE',
  reconTitleLines: [
    { text: 'ADAPTIVE FRAME RATE', size: 20, y: 70, bold: true },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 11, y: 108, color: '0xCCCCCC' },
    { text: 'Frames held for their segment duration', size: 11, y: 132, color: '0xAAAAAA' },
  ],
  compareTitleLines: [
    { text: 'ADAPTIVE vs ORIGINAL', size: 40, y: 160 },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 24, y: 240, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL (960x540)        RIGHT: ADAPTIVE (480x270, 2x)', size: 22, y: 310, color: '0xAAAAAA' },
  ],
  compare3TitleLines: [
    { text: 'ADAPTIVE vs 20 fps DEFAULT', size: 40, y: 150 },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 24, y: 225, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL | TOP RIGHT: 20 fps | BOTTOM RIGHT: ADAPTIVE', size: 22, y: 300, color: '0xAAAAAA' },
  ],
  reconOutputName: '全部_自适应重建.mp4',
  compareOutputName: '全部_左右对比.mp4',
  compare3OutputName: '全部_三路对比.mp4',
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
