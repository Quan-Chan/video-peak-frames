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

/** 动图类编码：时长、帧数、首帧语义与普通视频不同，需要额外探测。 */
const IMAGE_CODECS = new Set(['gif', 'apng', 'png', 'webp']);

/** ffprobe 报告的带 alpha 通道像素格式（rgba / bgra / yuva…）。 */
const ALPHA_PIX_FMT = /^(rgba|bgra|argb|abgr|ya\d*|yuva|gbrap|rgbaf)/i;

/**
 * 动图的帧表时间戳容差（秒）。
 *
 * APNG 的 timebase 是 1/100000，30fps 的真实 0.1 秒会被打印/换算成
 * 0.09999，按半开槽会落进前一槽。GIF/APNG 的延迟只有毫秒级，0.5ms 容差
 * 足以吃掉这种舍入误差，同时远小于一槽（20 槽/秒时 50ms）。
 * 普通视频不走容差，保持原有槽归属逐字节不变。
 */
const IMAGE_SLOT_TOLERANCE_SECONDS = 5e-4;

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [num, den] = String(rate).split('/').map(Number);
  return den ? num / den : 0;
}

/**
 * 读取帧表（只 demux、不解码），返回帧数与最后一帧的结束时间。
 *
 * APNG 的容器没有总时长字段，ffprobe 的 stream/format 都拿不到 duration，
 * 只能按每帧的 pts+duration 推算。GIF 与普通视频已有 duration，不调用这里。
 */
async function probePackets(input) {
  const { stdout } = await exec(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,duration_time',
    '-of', 'csv=p=0',
    input,
  ], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });

  let count = 0;
  let end = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [ptsText, durationText] = line.split(',');
    const pts = Number(ptsText);
    if (!Number.isFinite(pts)) continue;
    count++;
    const duration = Number(durationText);
    const stop = pts + (Number.isFinite(duration) ? duration : 0);
    if (stop > end) end = stop;
  }
  return { count, end };
}

/**
 * 解析输入源。返回抽帧需要的全部信息，并在这里拦截无法处理的输入：
 * - 动图（GIF/APNG）缺失时长时按帧表推算；
 * - 只有一帧的静态图片不是视频或动图，直接拒绝；
 * - 动画 WebP 需要 ffmpeg 支持 ANIM/ANMF，当前构建不支持时明确报错。
 */
export async function probe(input) {
  const { stdout } = await exec(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,duration:format=format_name,duration',
    '-of', 'json',
    input,
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });

  const info = JSON.parse(stdout);
  const stream = info.streams?.[0];
  if (!stream) throw new Error('输入文件中没有找到视频流');

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!(width > 0) || !(height > 0)) {
    // 不支持动画 WebP 的 ffmpeg 只能看到空壳（ANIM/ANMF 被跳过，宽高为 0）。
    throw new Error(
      '无法解析输入的画面尺寸。若这是动画 WebP，当前 ffmpeg 构建可能不支持 ANIM/ANMF；' +
      '请先转换为 GIF/APNG，或改用支持动画 WebP 的 ffmpeg'
    );
  }

  const codec = String(stream.codec_name ?? '');
  const pixFmt = String(stream.pix_fmt ?? '');
  const isImage = IMAGE_CODECS.has(codec);

  // 时长来源：流 → 容器。动图都没有时，按帧表推算。
  const streamDuration = Number(stream.duration);
  const formatDuration = Number(info.format?.duration);
  let duration = 0;
  let durationSource = null;
  if (Number.isFinite(streamDuration) && streamDuration > 0) {
    duration = streamDuration;
    durationSource = 'stream';
  } else if (Number.isFinite(formatDuration) && formatDuration > 0) {
    duration = formatDuration;
    durationSource = 'format';
  }

  let frameCount = Number.parseInt(stream.nb_frames ?? '', 10);
  if (!Number.isFinite(frameCount) || frameCount < 0) frameCount = 0;

  if (isImage && (!(duration > 0) || frameCount === 0)) {
    const packets = await probePackets(input);
    frameCount = frameCount || packets.count;
    if (packets.end > 0) {
      duration = packets.end;
      durationSource = durationSource ?? 'packets';
    }
  }

  if (isImage && frameCount < 2) {
    throw new Error('输入只有 1 帧，不是视频或动图；请提供包含多帧的视频、GIF 或 APNG');
  }
  if (!(duration > 0)) {
    throw new Error('无法确定输入时长；若这是动图，请确认文件完整');
  }

  return {
    width,
    height,
    rFrameRate: parseRate(stream.r_frame_rate),
    avgFrameRate: parseRate(stream.avg_frame_rate),
    duration,
    codec,
    formatName: String(info.format?.format_name ?? ''),
    frameCount,
    animated: isImage ? frameCount >= 2 : true,
    durationSource,
    hasAlpha: ALPHA_PIX_FMT.test(pixFmt),
    slotToleranceSeconds: isImage ? IMAGE_SLOT_TOLERANCE_SECONDS : 0,
  };
}

/**
 * 需要提示用户的自动修正行为（由调用方打印到 stderr）。
 * 只提示「用户看不见但会影响输出」的修正，不提示正常参数。
 *
 * preserveAlpha=true 表示输出 PNG/WebP、透明通道会原样保留，无需提示降级；
 * 输出 JPG 时 alpha 只能合成到黑色背景，需要明确告知。
 */
export function sourceNotices(info, { preserveAlpha = false } = {}) {
  const notices = [];
  if (info.durationSource === 'packets') {
    notices.push(`输入未提供可用时长，已按帧时间戳推算为 ${info.duration.toFixed(3)} 秒（${info.frameCount} 帧）`);
  }
  if (info.hasAlpha && !preserveAlpha) {
    notices.push('输入含 alpha 通道，当前输出格式不支持透明，透明区域按黑色合成（可用 --format png/webp 保留透明）');
  }
  return notices;
}
