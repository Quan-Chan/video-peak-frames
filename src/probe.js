import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

// 二进制查找顺序：环境变量 → 系统 PATH → vendor/ffmpeg/。
// 系统二进制属于使用者的环境，本项目不对其许可证负责。
// vendor/ 内为 scripts/install-ffmpeg.mjs 获取的 LGPL 构建（已校验不含 --enable-gpl），
// 不进入版本库与发布物。
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ffmpeg');

function findOnPath(name) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(locator, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

function resolveBinary(envVar, vendorName, fallback) {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`${envVar} 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }
  const onPath = findOnPath(fallback);
  if (onPath) return onPath;
  const inVendor = path.join(vendorDir, vendorName);
  if (fs.existsSync(inVendor)) return inVendor;
  return fallback;
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

export let ffmpegPath = resolveBinary('VPF_FFMPEG', exe('ffmpeg'), 'ffmpeg');
export let ffprobePath = resolveBinary('VPF_FFPROBE', exe('ffprobe'), 'ffprobe');

function usable(bin) {
  try {
    execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 保证 ffmpeg 与 ffprobe 可用。系统与 vendor 都没有时，
 * 调用 scripts/install-ffmpeg.mjs 获取 LGPL 构建后重新解析。
 */
export async function ensureBinaries() {
  if (usable(ffmpegPath) && usable(ffprobePath)) return;
  console.error('[vpf] 未找到 ffmpeg/ffprobe，开始获取 LGPL 构建…');
  await exec(process.execPath, [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-ffmpeg.mjs'),
  ], { stdio: 'inherit' });
  ffmpegPath = resolveBinary('VPF_FFMPEG', exe('ffmpeg'), 'ffmpeg');
  ffprobePath = resolveBinary('VPF_FFPROBE', exe('ffprobe'), 'ffprobe');
  if (!usable(ffmpegPath) || !usable(ffprobePath)) {
    throw new Error('ffmpeg/ffprobe 仍不可用。可运行 npm run install:ffmpeg，或设置 VPF_FFMPEG 与 VPF_FFPROBE');
  }
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [num, den] = String(rate).split('/').map(Number);
  return den ? num / den : 0;
}

export async function frameTimestamps(input, { start = 0, end = null } = {}) {
  const args = ['-v', 'error', '-select_streams', 'v:0'];
  // 该 ffprobe 构建的 -read_intervals 只接受两种半区间形式：
  //   `<start>`  从 start 读到结尾；`%<end>` 从头读到 end。
  // `-`/`+` 不是合法分隔符（实测报 Invalid interval ... specification），
  // 表达不了闭区间，所以这里只切一侧，另一侧由 pipeline 按 pts 精确过滤，
  // 既避免为了几秒素材全片解码，又不牺牲区间精度。
  if (start > 0) args.push('-read_intervals', String(start));
  else if (end != null) args.push('-read_intervals', `%${end}`);
  args.push(
    '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  );
  const { stdout } = await exec(ffprobePath, args, { maxBuffer: 512 * 1024 * 1024, windowsHide: true });

  const points = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const value = Number(text);
    if (Number.isFinite(value)) points.push(value);
  }
  return points;
}

export async function probe(input, { start = 0, end = null } = {}) {
  const { stdout } = await exec(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration',
    '-of', 'json',
    input,
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });

  const info = JSON.parse(stdout);
  const stream = info.streams?.[0];
  if (!stream) throw new Error('输入文件中没有找到视频流');

  const duration = Number(stream.duration ?? info.format?.duration ?? 0) || 0;

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    rFrameRate: parseRate(stream.r_frame_rate),
    avgFrameRate: parseRate(stream.avg_frame_rate),
    duration,
  };
}
