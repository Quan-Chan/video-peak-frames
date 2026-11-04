import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const exec = promisify(execFile);

function binaryOf(mod, name) {
  const value = typeof mod === 'string' ? mod : (mod?.path ?? mod?.default?.path);
  if (!value) throw new Error(`无法定位 ${name} 可执行文件`);
  return value;
}

export const ffmpegPath = binaryOf(ffmpegInstaller, 'ffmpeg');
export const ffprobePath = binaryOf(ffprobeInstaller, 'ffprobe');

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
