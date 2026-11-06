import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const ROOT = path.resolve('输出/默认参数重建');
const SHEET_ROOT = path.join(ROOT, '抽帧');
const FRAME_ROOT = path.join(ROOT, '单帧');
const RECON_ROOT = path.join(ROOT, '重建');
const CMP_ROOT = path.join(ROOT, '对比');
const SOURCE_ROOT = path.resolve('用户提供的内容');
const FFMPEG = path.resolve('vendor/ffmpeg/ffmpeg.exe');
const FONT = 'C\\:/Windows/Fonts/arial.ttf';
const FONT_BOLD = 'C\\:/Windows/Fonts/arialbd.ttf';
const GAP = 4;

function sh(args, label) {
  console.log(`\n[${label}]`);
  execFileSync(FFMPEG, args, { stdio: 'inherit' });
}

function dt(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

function parseLayout(text) {
  const m = /^(\d+)x(\d+)$/i.exec(text);
  if (!m) throw new Error(`bad layout: ${text}`);
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

async function splitFrames(dir, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const { cols } = parseLayout(manifest.params.layout);
  const [cellW, cellH] = manifest.params.cell;
  const sps = manifest.params.slotsPerSecond;
  const duration = manifest.source.duration;
  const frameCount = Math.ceil(duration * sps - 1e-9);
  const frameDir = path.join(FRAME_ROOT, name);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  let n = 0;
  outer:
  for (const sheet of manifest.sheets) {
    const sheetPath = path.join(dir, sheet.file);
    for (let i = 0; i < sheet.cells.length; i++) {
      if (n >= frameCount) break outer;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const left = GAP + col * (cellW + GAP);
      const top = GAP + row * (cellH + GAP);
      const out = path.join(frameDir, `${String(n + 1).padStart(6, '0')}.jpg`);
      await sharp(sheetPath)
        .extract({ left, top, width: cellW, height: cellH })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toFile(out);
      n++;
    }
  }
  if (n !== frameCount) throw new Error(`${name}: expected ${frameCount} frames, got ${n}`);
  return { name, manifest, frameDir, frameCount, duration, sps };
}

function encodeRecon(info) {
  const out = path.join(RECON_ROOT, `${info.name}.mp4`);
  sh([
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-framerate', String(info.sps),
    '-i', path.join(info.frameDir, '%06d.jpg'),
    '-frames:v', String(info.frameCount),
    '-vf', 'scale=in_range=full:out_range=limited,format=yuv420p',
    '-c:v', 'libopenh264', '-b:v', '1500k',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', String(info.sps),
    '-t', String(info.duration),
    '-movflags', '+faststart',
    out,
  ], `recon ${info.name}`);
  return out;
}

function encodeCompare(info, recon) {
  const original = path.join(SOURCE_ROOT, `${info.name}.mp4`);
  const out = path.join(CMP_ROOT, `${info.name}.mp4`);
  const filter = [
    '[0:v]fps=30,scale=960:540:force_original_aspect_ratio=decrease,' +
      'pad=960:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[L]',
    '[1:v]fps=30,scale=960:540:flags=neighbor,setsar=1[R]',
    '[L][R]hstack=inputs=2,pad=1920:604:0:64:color=black',
    'drawbox=x=958:y=64:w=4:h=540:color=white@0.35:t=fill',
    `drawtext=fontfile='${FONT}':text='${dt(info.name)}':x=20:y=8:fontsize=28:fontcolor=white`,
    `drawtext=fontfile='${FONT}':text='${dt('LEFT: ORIGINAL (960x540)')}':x=20:y=40:fontsize=18:fontcolor=0xCCCCCC`,
    `drawtext=fontfile='${FONT}':text='${dt('RIGHT: RECONSTRUCTED (480x270, 2x)')}':x=980:y=40:fontsize=18:fontcolor=0xCCCCCC`,
  ].join(',') + '[v]';
  sh([
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-i', original, '-i', recon,
    '-filter_complex', filter,
    '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', '6000k',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-t', String(info.duration),
    '-movflags', '+faststart',
    out,
  ], `compare ${info.name}`);
  return out;
}

function makeTitle(out, width, height, fps, lines, bitrate) {
  const draw = lines.map((line) => {
    return `drawtext=fontfile='${FONT_BOLD}':text='${dt(line.text)}':` +
      `x=(w-text_w)/2:y=${line.y}:fontsize=${line.size}:fontcolor=${line.color ?? 'white'}`;
  }).join(',');
  sh([
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i', `color=c=0x101318:s=${width}x${height}:d=2:r=${fps}`,
    '-vf', draw,
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', '2',
    '-movflags', '+faststart',
    out,
  ], `title ${path.basename(out)}`);
}

function concatVideos(inputs, out, fps, bitrate) {
  const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
  for (const input of inputs) args.push('-i', input);
  const labels = inputs.map((_, i) => `[${i}:v]`).join('');
  const filter = `${labels}concat=n=${inputs.length}:v=1:a=0[v]`;
  args.push(
    '-filter_complex', filter, '-map', '[v]', '-an',
    '-c:v', 'libopenh264', '-b:v', bitrate,
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-movflags', '+faststart',
    out,
  );
  sh(args, `concat ${path.basename(out)}`);
}

async function main() {
  const only = process.argv[2] ?? '';
  fs.rmSync(FRAME_ROOT, { recursive: true, force: true });
  fs.rmSync(RECON_ROOT, { recursive: true, force: true });
  fs.rmSync(CMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(FRAME_ROOT, { recursive: true });
  fs.mkdirSync(RECON_ROOT, { recursive: true });
  fs.mkdirSync(CMP_ROOT, { recursive: true });

  const names = fs.readdirSync(SHEET_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !only || name.includes(only));
  if (!names.length) throw new Error(`no extraction dirs under ${SHEET_ROOT}`);

  const infos = [];
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    const info = await splitFrames(path.join(SHEET_ROOT, name), name);
    console.log(`frames ${info.frameCount}, duration ${info.duration.toFixed(3)}s`);
    const recon = encodeRecon(info);
    const compare = encodeCompare(info, recon);
    infos.push({ ...info, recon, compare });
  }

  if (only) {
    console.log('\npartial run complete');
    return;
  }

  const reconTitle = path.join(ROOT, '_title_recon.mp4');
  const cmpTitle = path.join(ROOT, '_title_compare.mp4');
  makeTitle(reconTitle, 480, 270, 20, [
    { text: 'RECONSTRUCTED FROM DEFAULT FRAMES', size: 20, y: 70 },
    { text: '20 fps - 480x270 - 50 ms per slot', size: 13, y: 110, color: '0xCCCCCC' },
    { text: 'No audio. Timecode is burned in.', size: 13, y: 135, color: '0xAAAAAA' },
  ], '1200k');
  makeTitle(cmpTitle, 1920, 604, 30, [
    { text: 'DEFAULT PARAMETERS', size: 46, y: 160 },
    { text: '20 slots/s - 2x2 - 480x270 - q90', size: 28, y: 235, color: '0xCCCCCC' },
    {
      text: 'LEFT: original (960x540)      RIGHT: reconstructed (480x270, 2x)',
      size: 24, y: 310, color: '0xAAAAAA',
    },
  ], '4000k');

  concatVideos(
    [reconTitle, ...infos.map((i) => i.recon)],
    path.join(ROOT, '全部_抽帧重建.mp4'),
    20,
    '1500k',
  );
  concatVideos(
    [cmpTitle, ...infos.map((i) => i.compare)],
    path.join(ROOT, '全部_左右对比.mp4'),
    30,
    '6000k',
  );
  console.log('\nall done');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
