import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const PROJECT = path.resolve('.');
const SOURCE_ROOT = path.join(PROJECT, '用户提供的内容');
const WORK_ROOT = path.join(process.env.TEMP ?? '.', 'vpf-adaptive-demo');
const SHEET_ROOT = path.join(WORK_ROOT, 'sheets');
const FRAME_ROOT = path.join(WORK_ROOT, 'frames');
const TITLE_ROOT = path.join(WORK_ROOT, 'titles');
const OUT_DIR = path.join(PROJECT, '输出', '自适应重建');
const FFMPEG = path.join(PROJECT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FONT = 'C\\:/Windows/Fonts/arial.ttf';
const FONT_BOLD = 'C\\:/Windows/Fonts/arialbd.ttf';
const GAP = 4;
const FPS = 30;
const OUT_W = 960;
const OUT_H = 540;

function sh(args, label) {
  console.log(`\n[${label}]`);
  execFileSync(FFMPEG, args, { stdio: 'inherit' });
}

function dt(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function sourceNames() {
  return fs.readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function displayName(name) {
  return name
    .replace(/\.mp4$/i, '')
    .replace(/_[0-9.]+-[0-9.]+$/, '')
    .replace(/_/g, ' ')
    .toUpperCase();
}

function extractAdaptive(sourcePath, name) {
  const sheetDir = path.join(SHEET_ROOT, name);
  fs.rmSync(sheetDir, { recursive: true, force: true });
  execFileSync(process.execPath, [
    'bin/cli.mjs', sourcePath, '-o', sheetDir, '--adaptive', '--quiet',
  ], { cwd: PROJECT, stdio: 'inherit' });
  return JSON.parse(fs.readFileSync(path.join(sheetDir, 'manifest.json'), 'utf8'));
}

async function splitFrames(manifest, name) {
  const { layout, cell } = manifest.params;
  const [cellW, cellH] = cell;
  const cols = Number(/^(\d+)x/i.exec(layout)[1]);
  const sheetDir = path.join(SHEET_ROOT, name);
  const frameDir = path.join(FRAME_ROOT, name);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const frames = [];
  let n = 0;
  for (const sheet of manifest.sheets.filter((item) => item.file)) {
    const sheetPath = path.join(sheetDir, sheet.file);
    for (let i = 0; i < sheet.cells.length; i++) {
      const cellInfo = sheet.cells[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const left = GAP + col * (cellW + GAP);
      const top = GAP + row * (cellH + GAP);
      const file = path.join(frameDir, `${String(n + 1).padStart(6, '0')}.jpg`);
      if (cellInfo.empty) {
        await sharp({
          create: { width: cellW, height: cellH, channels: 3, background: '#14161C' },
        }).jpeg({ quality: 95 }).toFile(file);
      } else {
        await sharp(sheetPath)
          .extract({ left, top, width: cellW, height: cellH })
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toFile(file);
      }
      frames.push({ file, duration: Number(cellInfo.duration) });
      n++;
    }
  }
  return { frameDir, frames };
}

function makeTitle(file, lines) {
  const draw = lines.map((line) => {
    return `drawtext=fontfile='${line.bold ? FONT_BOLD : FONT}':text='${dt(line.text)}':` +
      `x=(w-text_w)/2:y=${line.y}:fontsize=${line.size}:fontcolor=${line.color ?? 'white'}`;
  }).join(',');
  sh([
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i', `color=c=0x101318:s=480x270:d=1`,
    '-vf', draw,
    '-frames:v', '1', '-q:v', '2',
    file,
  ], `title ${path.basename(file)}`);
}

async function main() {
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SHEET_ROOT, { recursive: true });
  fs.mkdirSync(FRAME_ROOT, { recursive: true });
  fs.mkdirSync(TITLE_ROOT, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const names = sourceNames();
  if (!names.length) throw new Error(`no mp4 under ${SOURCE_ROOT}`);

  const entries = []; // { file, duration }
  const stats = [];

  const intro = path.join(TITLE_ROOT, '000-intro.jpg');
  makeTitle(intro, [
    { text: 'ADAPTIVE FRAME RATE', size: 30, y: 70, bold: true },
    { text: 'DEFAULT PARAMS: 2-20 FPS / 1s WINDOW / 2x2 / 480x270', size: 12, y: 120, color: '0xCCCCCC' },
    { text: 'RECONSTRUCTED FROM EXTRACTED FRAMES', size: 13, y: 150, bold: true },
    { text: 'No audio. Each extracted frame is held for its segment duration.', size: 10, y: 185, color: '0xAAAAAA' },
  ]);
  entries.push({ file: intro, duration: 2.5 });

  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const sourcePath = path.join(SOURCE_ROOT, name);
    console.log(`\n=== ${name} (${index + 1}/${names.length}) ===`);

    const manifest = await extractAdaptive(sourcePath, name);
    const { frames } = await splitFrames(manifest, name);
    const statsLine = `AVG ${manifest.summary.avgFps.toFixed(1)} FPS / ${manifest.summary.slots} SEGMENTS / ${manifest.summary.sheets} SHEETS`;

    const title = path.join(TITLE_ROOT, `${String(index + 1).padStart(3, '0')}-${name}.jpg`);
    makeTitle(title, [
      { text: displayName(name), size: 22, y: 80, bold: true },
      { text: 'ADAPTIVE SAMPLING (DEFAULT PARAMS)', size: 12, y: 125, color: '0xCCCCCC' },
      { text: statsLine, size: 13, y: 155, bold: true },
      { text: `SOURCE ${manifest.source.duration.toFixed(2)}s / CELL ${manifest.params.cell[0]}x${manifest.params.cell[1]} / Q${manifest.params.quality}`, size: 10, y: 190, color: '0xAAAAAA' },
    ]);
    entries.push({ file: title, duration: 2.2 });
    for (const frame of frames) entries.push(frame);

    const totalSeconds = frames.reduce((sum, frame) => sum + frame.duration, 0);
    stats.push({ name, avgFps: manifest.summary.avgFps, segments: manifest.summary.slots, sheets: manifest.summary.sheets, frames: frames.length, seconds: Number(totalSeconds.toFixed(2)) });
    console.log(`frames ${frames.length}, reconstructed duration ${totalSeconds.toFixed(2)}s`);
  }

  // 末尾重复最后一帧，避免 concat 文件对最后一张图的有效时长处理差异。
  const last = entries[entries.length - 1];
  entries.push({ file: last.file, duration: 0.3 });

  const listPath = path.join(WORK_ROOT, 'concat.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const entry of entries) {
    lines.push(`file '${entry.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${entry.duration.toFixed(4)}`);
  }
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');

  const outputFile = path.join(OUT_DIR, '全部_自适应重建.mp4');
  sh([
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    // 输入是 concat 图片序列（帧时长不等），不要用 fps 滤镜：它会把大时长的标题帧压掉。
    // 统一交给 `-fps_mode cfr -r` 做帧率归一。
    '-vf', `scale=${OUT_W}:${OUT_H}:flags=neighbor,format=yuv420p`,
    '-fps_mode', 'cfr',
    '-c:v', 'libopenh264', '-b:v', '2500k',
    '-r', String(FPS), '-movflags', '+faststart',
    outputFile,
  ], 'encode final');

  console.log('\n=== SUMMARY ===');
  for (const item of stats) {
    console.log(`${item.name}: ${item.frames} frames, ${item.seconds}s, sheets ${item.sheets}, avg ${item.avgFps} fps`);
  }
  console.log(`output: ${outputFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
