import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/** 演示脚本共用的常量：所有模式的重建与对比都在 480x270 单格上做。 */
const FONT = 'C\\:/Windows/Fonts/arial.ttf';
const FONT_BOLD = 'C\\:/Windows/Fonts/arialbd.ttf';
const GAP = 4;
const FPS = 30;
const RECON_W = 480;
const RECON_H = 270;
const CMP2_W = 1920;
const CMP2_H = 604;
const CMP3_W = 1440;
const CMP3_H = 604;
const MAX_PARALLEL_FFMPEG = 3;

/** 命令行文本里的特殊字符需要转义，drawtext 才能正确解析。 */
export function dt(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export function parseLayout(text) {
  const match = /^(\d+)x(\d+)$/i.exec(text);
  if (!match) throw new Error('bad layout: ' + text);
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

/** 素材文件名 -> 标题用显示名：去掉扩展名与录制时间后缀。 */
export function displayName(file) {
  return file
    .replace(/\.mp4$/i, '')
    .replace(/_[0-9.]+-[0-9.]+$/, '')
    .replace(/_/g, ' ')
    .toUpperCase();
}

export function sourceNames(sourceRoot) {
  return fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function runFfmpeg(ffmpeg, args, label) {
  const started = Date.now();
  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    throw new Error('[' + label + '] ' + (error.stderr || error.message));
  }
  console.log('  ' + label + '  ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}

/** 简单并发池：演示产物里最耗时的是多路对比编码，限制并行数以控制内存。 */
export async function pool(items, limit, worker) {
  let next = 0;
  const runners = [];
  for (let index = 0; index < Math.min(limit, items.length); index++) {
    runners.push((async function run() {
      for (;;) {
        const current = next++;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    })());
  }
  await Promise.all(runners);
}

/** ffconcat 里的文件路径：统一正斜杠并转义单引号。 */
function listLine(file) {
  return "file '" + String(file).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
}

/** 用项目自带的 CLI 抽帧；args 决定固定 / 自适应 / 预算模式。 */
export async function extractFrames({ project, sourcePath, sheetDir, args }) {
  const cli = path.join(project, 'bin', 'cli.mjs');
  fs.rmSync(sheetDir, { recursive: true, force: true });
  await execFileAsync(process.execPath, [
    cli, sourcePath, '-o', sheetDir, '--quiet', ...args,
  ], { cwd: project, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(fs.readFileSync(path.join(sheetDir, 'manifest.json'), 'utf8'));
}

/**
 * 从拼图里裁回单帧，并写 frames.json 作为中间结果。
 * 只处理无空帧的素材：演示素材均为高帧率 CFR，若出现空帧说明流程异常。
 */
export async function splitFrames({ sheetDir, frameDir, manifest }) {
  const { cols } = parseLayout(manifest.params.layout);
  const [cellW, cellH] = manifest.params.cell;
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const cells = [];
  for (const sheet of manifest.sheets) {
    if (!sheet.file) continue;
    for (let index = 0; index < sheet.cells.length; index++) {
      const cell = sheet.cells[index];
      if (cell.empty) throw new Error('演示素材出现空帧，暂不支持：' + sheet.file);
      const column = index % cols;
      const row = Math.floor(index / cols);
      const left = GAP + column * (cellW + GAP);
      const top = GAP + row * (cellH + GAP);
      const fileName = String(cells.length + 1).padStart(6, '0') + '.jpg';
      await sharp(path.join(sheetDir, sheet.file))
        .extract({ left, top, width: cellW, height: cellH })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toFile(path.join(frameDir, fileName));
      cells.push({ ...cell, file: fileName });
    }
  }

  fs.writeFileSync(path.join(frameDir, 'frames.json'), JSON.stringify({
    source: path.basename(manifest.input),
    mode: manifest.params.mode ?? 'fixed',
    cell: [cellW, cellH],
    layout: manifest.params.layout,
    duration: manifest.source.segmentDuration,
    avgFps: manifest.summary.avgFps,
    frames: cells,
  }, null, 2), 'utf8');
  return cells;
}

/** 按每格时长拼回 30fps 恒定帧率视频；与抽帧产物一致，只用 480x270 单格尺寸。 */
export async function encodeRecon({ ffmpeg, frameDir, cells, duration, outFile }) {
  const listPath = path.join(frameDir, 'concat.ffconcat');
  const lines = ['ffconcat version 1.0'];
  let sum = 0;
  for (const cell of cells) sum += cell.duration;
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    let length = cell.duration;
    if (index === cells.length - 1) length = Math.max(length, duration - (sum - cell.duration) + 0.05);
    lines.push(listLine(path.join(frameDir, cell.file)));
    lines.push('duration ' + length.toFixed(4));
  }
  lines.push(listLine(path.join(frameDir, cells[cells.length - 1].file)));
  lines.push('duration 0.3000');
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');

  await runFfmpeg(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'format=yuv420p',
    '-fps_mode', 'cfr', '-r', String(FPS),
    '-c:v', 'libopenh264', '-b:v', '1500k',
    '-t', String(duration),
    '-movflags', '+faststart',
    outFile,
  ], 'recon ' + path.basename(outFile));
}

/** 标题卡：纯色背景 + 居中 drawtext，编码参数与同组视频一致，便于 concat 拼接。 */
export async function makeTitle({ ffmpeg, outFile, width, height, lines, bitrate }) {
  const draw = lines.map((line) => {
    const font = line.bold ? FONT_BOLD : FONT;
    return "drawtext=fontfile='" + font + "':text='" + dt(line.text) + "':x=(w-text_w)/2:y=" +
      line.y + ':fontsize=' + line.size + ':fontcolor=' + (line.color || 'white');
  }).join(',');
  await runFfmpeg(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x101318:s=' + width + 'x' + height + ':d=2:r=' + FPS,
    '-vf', draw,
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', '2',
    '-movflags', '+faststart',
    outFile,
  ], 'title ' + path.basename(outFile));
}

/** 左右对比：左原片 960x540，右重建 480x270 放大 2 倍。 */
export async function encodeCompare2({
  ffmpeg, original, recon, outFile, duration, title, rightLabel,
}) {
  const filter = [
    '[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[L]',
    '[1:v]fps=30,scale=960:540:flags=neighbor,setsar=1[R]',
    '[L][R]hstack=inputs=2,pad=' + CMP2_W + ':' + CMP2_H + ':0:64:color=black',
    'drawbox=x=958:y=64:w=4:h=540:color=white@0.35:t=fill',
    "drawtext=fontfile='" + FONT + "':text='" + dt(title) + "':x=20:y=8:fontsize=28:fontcolor=white",
    "drawtext=fontfile='" + FONT + "':text='" + dt('LEFT: ORIGINAL (960x540)') + "':x=20:y=40:fontsize=18:fontcolor=0xCCCCCC",
    "drawtext=fontfile='" + FONT + "':text='" + dt(rightLabel) + "':x=980:y=40:fontsize=18:fontcolor=0xCCCCCC",
  ].join(',') + '[v]';
  await runFfmpeg(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', original, '-i', recon,
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', '6000k',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', String(duration),
    '-movflags', '+faststart',
    outFile,
  ], 'compare2 ' + path.basename(outFile));
}

/** 三路对比：左原片，右上固定 20fps，右下被测模式。 */
export async function encodeCompare3({
  ffmpeg, original, fixedRecon, modeRecon, outFile, duration, title, bottomLabel,
}) {
  const filter = [
    '[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[L]',
    '[1:v]fps=30,setsar=1[A]',
    '[2:v]fps=30,setsar=1[B]',
    '[L][A][B]xstack=inputs=3:layout=0_0|960_0|960_270:fill=black,pad=' + CMP3_W + ':' + CMP3_H + ':0:64:color=black',
    'drawbox=x=958:y=64:w=4:h=540:color=white@0.35:t=fill',
    'drawbox=x=960:y=332:w=480:h=4:color=white@0.25:t=fill',
    "drawtext=fontfile='" + FONT + "':text='" + dt(title) + "':x=20:y=8:fontsize=28:fontcolor=white",
    "drawtext=fontfile='" + FONT + "':text='" + dt('LEFT: ORIGINAL (960x540)') + "':x=20:y=40:fontsize=18:fontcolor=0xCCCCCC",
    "drawtext=fontfile='" + FONT + "':text='" + dt('TOP: 20 fps DEFAULT    BOTTOM: ' + bottomLabel) + "':x=980:y=40:fontsize=18:fontcolor=0xCCCCCC",
  ].join(',') + '[v]';
  await runFfmpeg(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', original, '-i', fixedRecon, '-i', modeRecon,
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', '4500k',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', String(duration),
    '-movflags', '+faststart',
    outFile,
  ], 'compare3 ' + path.basename(outFile));
}

/** 把标题卡与同构视频拼成合集；参数一致时优先流拷贝，失败再重编码兜底。 */
export async function concatVideos({ ffmpeg, inputs, outFile, bitrate }) {
  const listPath = outFile + '.ffconcat';
  fs.writeFileSync(listPath, ['ffconcat version 1.0', ...inputs.map(listLine)].join('\n') + '\n', 'utf8');
  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', outFile,
    ], 'concat-copy ' + path.basename(outFile));
    fs.rmSync(listPath, { force: true });
    return;
  } catch {
    console.log('  concat copy failed, re-encoding: ' + path.basename(outFile));
  }
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-i', input);
  const labels = inputs.map((_, index) => '[' + index + ':v]').join('');
  args.push(
    '-filter_complex', labels + 'concat=n=' + inputs.length + ':v=1:a=0[v]',
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-movflags', '+faststart',
    outFile,
  );
  await runFfmpeg(ffmpeg, args, 'concat-reencode ' + path.basename(outFile));
  fs.rmSync(listPath, { force: true });
}

/**
 * 演示产物总流程：抽帧 -> 裁单帧 -> 重建 -> 左右对比 -> 三路对比 -> 标题与合集。
 * 自适应与预算模式共用这套流程，差异只在抽帧参数、目录名与文案。
 */
export async function runSamplingDemo({
  project, extractArgs, outRoot, fixedReconRoot,
  rightLabel, bottomLabel,
  reconTitleLines, compareTitleLines, compare3TitleLines,
  reconOutputName, compareOutputName, compare3OutputName,
}) {
  const ffmpeg = path.join(project, 'vendor', 'ffmpeg', 'ffmpeg.exe');
  const sourceRoot = path.join(project, '用户提供的内容');
  const sheetRoot = path.join(outRoot, '抽帧');
  const frameRoot = path.join(outRoot, '单帧');
  const reconRoot = path.join(outRoot, '重建');
  const compareRoot = path.join(outRoot, '对比');
  const compare3Root = path.join(outRoot, '对比三路');

  for (const dir of [sheetRoot, frameRoot, reconRoot, compareRoot, compare3Root]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of fs.readdirSync(outRoot)) {
    if (/\.mp4$/i.test(file)) fs.rmSync(path.join(outRoot, file), { force: true });
  }

  const infos = [];
  const names = sourceNames(sourceRoot);
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const base = name.replace(/\.mp4$/i, '');
    const sourcePath = path.join(sourceRoot, name);
    console.log('\n=== ' + base + ' (' + (index + 1) + '/' + names.length + ') ===');

    const sheetDir = path.join(sheetRoot, base);
    const manifest = await extractFrames({ project, sourcePath, sheetDir, args: extractArgs });
    const frameDir = path.join(frameRoot, base);
    const cells = await splitFrames({ sheetDir, frameDir, manifest });
    const duration = manifest.source.segmentDuration;
    const recon = path.join(reconRoot, base + '.mp4');
    await encodeRecon({ ffmpeg, frameDir, cells, duration, outFile: recon });
    console.log('  frames ' + cells.length + ', sheets ' + manifest.summary.sheets);

    infos.push({
      base,
      original: sourcePath,
      fixedRecon: path.join(fixedReconRoot, base + '.mp4'),
      recon,
      duration,
    });
  }

  const jobs = [];
  for (const info of infos) {
    jobs.push({ type: 'compare2', info });
    jobs.push({ type: 'compare3', info });
  }
  await pool(jobs, MAX_PARALLEL_FFMPEG, async (job) => {
    const { info } = job;
    if (job.type === 'compare2') {
      await encodeCompare2({
        ffmpeg, original: info.original, recon: info.recon,
        outFile: path.join(compareRoot, info.base + '.mp4'),
        duration: info.duration,
        title: displayName(info.base),
        rightLabel,
      });
    } else {
      await encodeCompare3({
        ffmpeg, original: info.original, fixedRecon: info.fixedRecon, modeRecon: info.recon,
        outFile: path.join(compare3Root, info.base + '.mp4'),
        duration: info.duration,
        title: displayName(info.base),
        bottomLabel,
      });
    }
  });

  const reconTitle = path.join(outRoot, '_title_recon.mp4');
  await makeTitle({ ffmpeg, outFile: reconTitle, width: RECON_W, height: RECON_H, lines: reconTitleLines, bitrate: '1200k' });
  const compareTitle = path.join(outRoot, '_title_compare.mp4');
  await makeTitle({ ffmpeg, outFile: compareTitle, width: CMP2_W, height: CMP2_H, lines: compareTitleLines, bitrate: '4000k' });
  const compare3Title = path.join(outRoot, '_title_compare3.mp4');
  await makeTitle({ ffmpeg, outFile: compare3Title, width: CMP3_W, height: CMP3_H, lines: compare3TitleLines, bitrate: '3500k' });

  await concatVideos({
    ffmpeg,
    inputs: [reconTitle, ...infos.map((info) => info.recon)],
    outFile: path.join(outRoot, reconOutputName),
    bitrate: '1500k',
  });
  await concatVideos({
    ffmpeg,
    inputs: [compareTitle, ...infos.map((info) => path.join(compareRoot, info.base + '.mp4'))],
    outFile: path.join(outRoot, compareOutputName),
    bitrate: '6000k',
  });
  await concatVideos({
    ffmpeg,
    inputs: [compare3Title, ...infos.map((info) => path.join(compare3Root, info.base + '.mp4'))],
    outFile: path.join(outRoot, compare3OutputName),
    bitrate: '4500k',
  });

  console.log('\n=== SUMMARY ===');
  for (const info of infos) {
    console.log(info.base + ': duration ' + info.duration.toFixed(2) + 's');
  }
  console.log('output: ' + outRoot);
}
