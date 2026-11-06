import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const PROJECT = path.resolve('.');
const SOURCE_ROOT = path.join(PROJECT, '用户提供的内容');
const ROOT = path.join(PROJECT, '输出', '自适应采样');
const SHEET_ROOT = path.join(ROOT, '抽帧');
const FRAME_ROOT = path.join(ROOT, '单帧');
const RECON_ROOT = path.join(ROOT, '重建');
const CMP2_ROOT = path.join(ROOT, '对比');
const CMP3_ROOT = path.join(ROOT, '对比三路');
const DEFAULT_RECON_ROOT = path.join(PROJECT, '输出', '默认参数重建', '重建');
const FFMPEG = path.join(PROJECT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
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

function dt(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

async function ffmpeg(args, label) {
  const started = Date.now();
  try {
    await execFileAsync(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    throw new Error('[' + label + '] ' + (error.stderr || error.message));
  }
  console.log('  ' + label + '  ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}

function parseLayout(text) {
  const match = /^(\d+)x(\d+)$/i.exec(text);
  if (!match) throw new Error('bad layout: ' + text);
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

function sourceNames() {
  return fs.readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter(function (entry) { return entry.isFile() && /\.mp4$/i.test(entry.name); })
    .map(function (entry) { return entry.name; })
    .sort();
}

function displayName(file) {
  return file
    .replace(/\.mp4$/i, '')
    .replace(/_[0-9.]+-[0-9.]+$/, '')
    .replace(/_/g, ' ')
    .toUpperCase();
}

function listLine(file) {
  return "file '" + String(file).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
}

async function extractAdaptive(sourcePath, name) {
  const sheetDir = path.join(SHEET_ROOT, name);
  fs.rmSync(sheetDir, { recursive: true, force: true });
  await execFileAsync(process.execPath, ['bin/cli.mjs', sourcePath, '-o', sheetDir, '--adaptive', '--quiet'], {
    cwd: PROJECT,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(fs.readFileSync(path.join(sheetDir, 'manifest.json'), 'utf8'));
}

async function splitFrames(manifest, name) {
  const cell = manifest.params.cell;
  const cellW = cell[0];
  const cellH = cell[1];
  const cols = parseLayout(manifest.params.layout).cols;
  const sheetDir = path.join(SHEET_ROOT, name);
  const frameDir = path.join(FRAME_ROOT, name);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const frames = [];
  let n = 0;
  for (const sheet of manifest.sheets) {
    if (!sheet.file) continue;
    const sheetPath = path.join(sheetDir, sheet.file);
    for (let i = 0; i < sheet.cells.length; i++) {
      const info = sheet.cells[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const left = GAP + col * (cellW + GAP);
      const top = GAP + row * (cellH + GAP);
      const fileName = String(n + 1).padStart(6, '0') + '.jpg';
      const out = path.join(frameDir, fileName);
      if (info.empty) {
        await sharp({ create: { width: cellW, height: cellH, channels: 3, background: '#14161C' } })
          .jpeg({ quality: 95 })
          .toFile(out);
      } else {
        await sharp(sheetPath)
          .extract({ left: left, top: top, width: cellW, height: cellH })
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toFile(out);
      }
      frames.push({
        index: n + 1,
        file: fileName,
        sheet: sheet.file,
        cell: i,
        start: info.start,
        end: info.end,
        duration: info.duration,
        pts: info.pts,
        frameIndex: info.frameIndex,
        score: info.score,
        window: info.window,
        windowFps: info.windowFps,
      });
      n++;
    }
  }

  fs.writeFileSync(path.join(frameDir, 'frames.json'), JSON.stringify({
    source: name,
    cell: [cellW, cellH],
    gap: GAP,
    layout: manifest.params.layout,
    duration: manifest.source.duration,
    avgFps: manifest.summary.avgFps,
    segments: frames,
  }, null, 2), 'utf8');

  return { name: name, frames: frames, cellW: cellW, cellH: cellH, duration: manifest.source.duration };
}

function writeConcatList(info, listPath) {
  const lines = ['ffconcat version 1.0'];
  let sum = 0;
  for (const frame of info.frames) sum += frame.duration;
  const lastIndex = info.frames.length - 1;
  const frameDir = path.join(FRAME_ROOT, info.name);
  for (let i = 0; i < info.frames.length; i++) {
    const frame = info.frames[i];
    let duration = frame.duration;
    if (i === lastIndex) {
      duration = Math.max(duration, info.duration - (sum - frame.duration) + 0.05);
    }
    lines.push(listLine(path.join(frameDir, frame.file)));
    lines.push('duration ' + duration.toFixed(4));
  }
  const lastFile = path.join(frameDir, info.frames[lastIndex].file);
  lines.push(listLine(lastFile));
  lines.push('duration 0.3000');
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');
}

async function encodeRecon(info) {
  const frameDir = path.join(FRAME_ROOT, info.name);
  const listPath = path.join(frameDir, 'concat.ffconcat');
  writeConcatList(info, listPath);
  const out = path.join(RECON_ROOT, info.name + '.mp4');
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'format=yuv420p',
    '-fps_mode', 'cfr',
    '-r', String(FPS),
    '-c:v', 'libopenh264', '-b:v', '1500k',
    '-t', String(info.duration),
    '-movflags', '+faststart',
    out,
  ], 'recon ' + info.name);
  return out;
}

async function makeTitle(outPath, width, height, textLines, bitrate) {
  const draw = textLines.map(function (line) {
    const font = line.bold ? FONT_BOLD : FONT;
    return "drawtext=fontfile='" + font + "':text='" + dt(line.text) + "':x=(w-text_w)/2:y=" +
      line.y + ':fontsize=' + line.size + ':fontcolor=' + (line.color || 'white');
  }).join(',');
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x101318:s=' + width + 'x' + height + ':d=2:r=' + FPS,
    '-vf', draw,
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', '2',
    '-movflags', '+faststart',
    outPath,
  ], 'title ' + path.basename(outPath));
}

async function encodeCompare2(info) {
  const original = path.join(SOURCE_ROOT, info.sourceFile);
  const recon = path.join(RECON_ROOT, info.name + '.mp4');
  const out = path.join(CMP2_ROOT, info.name + '.mp4');
  const filter = [
    '[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[L]',
    '[1:v]fps=30,scale=960:540:flags=neighbor,setsar=1[R]',
    '[L][R]hstack=inputs=2,pad=' + CMP2_W + ':' + CMP2_H + ':0:64:color=black',
    'drawbox=x=958:y=64:w=4:h=540:color=white@0.35:t=fill',
    "drawtext=fontfile='" + FONT + "':text='" + dt(displayName(info.name)) + "':x=20:y=8:fontsize=28:fontcolor=white",
    "drawtext=fontfile='" + FONT + "':text='" + dt('LEFT: ORIGINAL (960x540)') + "':x=20:y=40:fontsize=18:fontcolor=0xCCCCCC",
    "drawtext=fontfile='" + FONT + "':text='" + dt('RIGHT: ADAPTIVE (480x270, 2x)') + "':x=980:y=40:fontsize=18:fontcolor=0xCCCCCC",
  ].join(',') + '[v]';
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', original, '-i', recon,
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', '6000k',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', String(info.duration),
    '-movflags', '+faststart',
    out,
  ], 'compare2 ' + info.name);
}

async function encodeCompare3(info) {
  const original = path.join(SOURCE_ROOT, info.sourceFile);
  const p20 = path.join(DEFAULT_RECON_ROOT, info.name + '.mp4');
  const adaptive = path.join(RECON_ROOT, info.name + '.mp4');
  if (!fs.existsSync(p20)) throw new Error('missing default 20fps recon: ' + p20);
  const out = path.join(CMP3_ROOT, info.name + '.mp4');
  const filter = [
    '[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[L]',
    '[1:v]fps=30,setsar=1[A]',
    '[2:v]fps=30,setsar=1[B]',
    '[L][A][B]xstack=inputs=3:layout=0_0|960_0|960_270:fill=black,pad=' + CMP3_W + ':' + CMP3_H + ':0:64:color=black',
    'drawbox=x=958:y=64:w=4:h=540:color=white@0.35:t=fill',
    'drawbox=x=960:y=332:w=480:h=4:color=white@0.25:t=fill',
    "drawtext=fontfile='" + FONT + "':text='" + dt(displayName(info.name)) + "':x=20:y=8:fontsize=28:fontcolor=white",
    "drawtext=fontfile='" + FONT + "':text='" + dt('LEFT: ORIGINAL (960x540)') + "':x=20:y=40:fontsize=18:fontcolor=0xCCCCCC",
    "drawtext=fontfile='" + FONT + "':text='" + dt('TOP: 20 fps DEFAULT    BOTTOM: ADAPTIVE') + "':x=980:y=40:fontsize=18:fontcolor=0xCCCCCC",
  ].join(',') + '[v]';
  await ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', original, '-i', p20, '-i', adaptive,
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', '4500k',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', String(info.duration),
    '-movflags', '+faststart',
    out,
  ], 'compare3 ' + info.name);
}

async function concatVideos(inputs, out, width, height, bitrate) {
  const listPath = path.join(ROOT, '_concat_' + path.basename(out, '.mp4') + '.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const input of inputs) {
    lines.push(listLine(input));
  }
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');
  const copyArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', out,
  ];
  try {
    await ffmpeg(copyArgs, 'concat-copy ' + path.basename(out));
    fs.rmSync(listPath, { force: true });
    return;
  } catch (error) {
    console.log('  concat copy failed, re-encoding: ' + path.basename(out));
  }
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-i', input);
  const labels = inputs.map(function (_, i) { return '[' + i + ':v]'; }).join('');
  args.push(
    '-filter_complex', labels + 'concat=n=' + inputs.length + ':v=1:a=0[v]',
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-movflags', '+faststart',
    out,
  );
  await ffmpeg(args, 'concat-reencode ' + path.basename(out));
  fs.rmSync(listPath, { force: true });
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async function () {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
}

async function main() {
  fs.rmSync(SHEET_ROOT, { recursive: true, force: true });
  fs.rmSync(FRAME_ROOT, { recursive: true, force: true });
  fs.rmSync(RECON_ROOT, { recursive: true, force: true });
  fs.rmSync(CMP2_ROOT, { recursive: true, force: true });
  fs.rmSync(CMP3_ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (name.isFile() && /\.(mp4|ffconcat)$/i.test(name.name)) fs.rmSync(path.join(ROOT, name.name), { force: true });
  }
  for (const dir of [SHEET_ROOT, FRAME_ROOT, RECON_ROOT, CMP2_ROOT, CMP3_ROOT]) fs.mkdirSync(dir, { recursive: true });

  const names = sourceNames();
  if (!names.length) throw new Error('no mp4 under ' + SOURCE_ROOT);
  console.log('sources: ' + names.length);

  const infos = [];
  for (let i = 0; i < names.length; i++) {
    const sourceFile = names[i];
    const name = sourceFile.replace(/\.mp4$/i, '');
    const sourcePath = path.join(SOURCE_ROOT, sourceFile);
    console.log('\n=== ' + name + ' (' + (i + 1) + '/' + names.length + ') ===');
    const manifest = await extractAdaptive(sourcePath, name);
    const info = await splitFrames(manifest, name);
    info.sourceFile = sourceFile;
    info.manifest = manifest;
    console.log('  frames ' + info.frames.length + ', avg ' + manifest.summary.avgFps + ' fps, sheets ' + manifest.summary.sheets);
    await encodeRecon(info);
    infos.push(info);
  }

  const jobs = [];
  for (const info of infos) {
    jobs.push({ type: 'compare2', info: info });
    jobs.push({ type: 'compare3', info: info });
  }
  await pool(jobs, 3, async function (job) {
    if (job.type === 'compare2') await encodeCompare2(job.info);
    else await encodeCompare3(job.info);
  });

  const reconTitle = path.join(ROOT, '_title_recon.mp4');
  await makeTitle(reconTitle, RECON_W, RECON_H, [
    { text: 'ADAPTIVE FRAME RATE', size: 20, y: 70, bold: true },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 11, y: 108, color: '0xCCCCCC' },
    { text: 'Frames held for their segment duration', size: 11, y: 132, color: '0xAAAAAA' },
  ], '1200k');

  const cmp2Title = path.join(ROOT, '_title_compare.mp4');
  await makeTitle(cmp2Title, CMP2_W, CMP2_H, [
    { text: 'ADAPTIVE vs ORIGINAL', size: 40, y: 160 },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 24, y: 240, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL (960x540)        RIGHT: ADAPTIVE (480x270, 2x)', size: 22, y: 310, color: '0xAAAAAA' },
  ], '4000k');

  const cmp3Title = path.join(ROOT, '_title_compare3.mp4');
  await makeTitle(cmp3Title, CMP3_W, CMP3_H, [
    { text: 'ADAPTIVE vs 20 fps DEFAULT', size: 40, y: 150 },
    { text: 'DEFAULT: 2-20 fps / 1s WINDOW / 2x2 / 480x270', size: 24, y: 225, color: '0xCCCCCC' },
    { text: 'LEFT: ORIGINAL | TOP RIGHT: 20 fps | BOTTOM RIGHT: ADAPTIVE', size: 22, y: 300, color: '0xAAAAAA' },
  ], '3500k');

  await concatVideos([reconTitle].concat(infos.map(function (info) { return path.join(RECON_ROOT, info.name + '.mp4'); })), path.join(ROOT, '全部_自适应重建.mp4'), RECON_W, RECON_H, '1500k');
  await concatVideos([cmp2Title].concat(infos.map(function (info) { return path.join(CMP2_ROOT, info.name + '.mp4'); })), path.join(ROOT, '全部_左右对比.mp4'), CMP2_W, CMP2_H, '6000k');
  await concatVideos([cmp3Title].concat(infos.map(function (info) { return path.join(CMP3_ROOT, info.name + '.mp4'); })), path.join(ROOT, '全部_三路对比.mp4'), CMP3_W, CMP3_H, '4500k');

  console.log('\n=== SUMMARY ===');
  for (const info of infos) {
    const summary = info.manifest.summary;
    console.log(info.name + ': frames ' + info.frames.length + ', sheets ' + summary.sheets + ', avg ' + summary.avgFps + ' fps, duration ' + info.duration.toFixed(2) + 's');
  }
  console.log('output: ' + ROOT);
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
