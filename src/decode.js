import { spawn } from 'node:child_process';
import { ffmpegPath } from './probe.js';

const PTS_RE = /n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:([-\d.eE+]+)/;
/** 等 showinfo 行的兜底上限：正常远小于此值，只防解析器异常时卡死。 */
const PTS_WAIT_TIMEOUT_MS = 10000;

/**
 * 单遍流式解码。滤镜链末尾挂 showinfo，把每帧的 pts_time 打到 stderr，
 * 从而免掉一次 ffprobe 全片扫描，且时间戳与帧严格一一对应。
 * start/end 用 ffmpeg 输入侧 -ss / -t 截取，只解码目标片段。
 *
 * 含 alpha 的输入（GIF/APNG 动图常见）以 rgba 解码，并在滤镜链里用透明色
 * 补齐到单格尺寸：
 * - preserveAlpha=true（输出 PNG/WebP）：保留 rgba，透明像素原样交给合成；
 * - preserveAlpha=false（输出 JPG）：在 JS 里按 channel × alpha / 255 合成到
 *   黑色背景，再交给打分与拼图。
 * 不用 filter_complex 叠黑底，是因为 overlay 的主输入决定输出时间戳，
 * 会破坏 showinfo 与源帧的对应关系；JS 处理保持原滤镜链与时间戳不变。
 */
export async function* decodeFrames({
  input, cellWidth, cellHeight, start = 0, end = null, hasAlpha = false, preserveAlpha = false,
}) {
  const preserve = hasAlpha && preserveAlpha;
  // 不透明输入沿用旧滤镜链，保证原有视频输出逐字节不变；
  // 含 alpha 的输入先把像素格式统一成 rgba，再用透明色补边，
  // 这样缩放产生的黑边不会变成不透明黑块。
  const filter = hasAlpha
    ? [
      `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease`,
      'format=rgba',
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      'setsar=1',
      'showinfo',
    ].join(',')
    : [
      `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease`,
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      'showinfo',
    ].join(',');

  // showinfo 走 av_log 的 INFO 级别，用 -v error 会把它吞掉。
  const args = ['-v', 'info', '-nostdin'];
  // 输入侧 -ss 快，且对解码输出是精确的（会丢弃起始之前的帧）。
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', input, '-map', '0:v:0', '-an', '-sn', '-dn');
  if (end != null) args.push('-t', String(Math.max(0.001, end - start)));
  args.push('-vf', filter, '-pix_fmt', hasAlpha ? 'rgba' : 'rgb24', '-vsync', '0', '-f', 'rawvideo', 'pipe:1');

  const proc = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // 只缓存「已解析、尚未被消费」的几帧时间戳；消费后即删，超长视频不会堆积。
  const ptsByIndex = new Map();
  const ptsWaiters = new Map();
  let lineBuf = '';
  let stderrText = '';

  const resolveWaiter = (index, pts) => {
    const waiter = ptsWaiters.get(index);
    if (!waiter) return;
    ptsWaiters.delete(index);
    waiter(pts);
  };

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderrText = (stderrText + chunk).slice(-16384);
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const match = PTS_RE.exec(line);
      if (match) {
        const index = Number(match[1]);
        const pts = Number(match[2]);
        if (ptsWaiters.has(index)) resolveWaiter(index, pts);
        else ptsByIndex.set(index, pts);
      }
    }
  });

  const closed = new Promise((resolve) => {
    proc.once('error', (error) => resolve({ error }));
    proc.once('close', (code) => resolve({ code }));
  }).then((result) => {
    // 进程结束时还没等到 showinfo 行的帧按缺失处理，避免等待永久挂起。
    for (const index of [...ptsWaiters.keys()]) resolveWaiter(index, null);
    ptsByIndex.clear();
    return result;
  });

  /** 取走已缓存的时间戳（消费即删）；没有则返回 undefined。 */
  const takePts = (index) => {
    const pts = ptsByIndex.get(index);
    if (pts === undefined) return undefined;
    ptsByIndex.delete(index);
    return pts;
  };

  /**
   * 取第 index 帧的时间戳。像素数据与 showinfo 日志走 stdout/stderr 两条管道，
   * 日志可能晚于像素到达；此时等解析器确认，而不是用帧率推算顶替真实时间戳
   * （推算会抹平 VFR 间隔，让帧落进错误的槽）。日志丢失或进程结束则返回 null。
   */
  const waitPts = (index) => new Promise((resolve) => {
    const cached = takePts(index);
    if (cached !== undefined) {
      resolve(cached);
      return;
    }
    const timer = setTimeout(() => resolveWaiter(index, null), PTS_WAIT_TIMEOUT_MS);
    ptsWaiters.set(index, (pts) => {
      clearTimeout(timer);
      resolve(pts);
    });
  });

  const pixelCount = cellWidth * cellHeight;
  const frameSize = pixelCount * (hasAlpha ? 4 : 3);
  // 按帧尺寸累加：管道分块边界与帧边界无关，逐块拼到整帧后再交出。
  // 交出的缓冲区归调用方所有，下一帧重新分配，避免与后续读取互相覆盖。
  let frame = Buffer.allocUnsafe(frameSize);
  let filled = 0;
  let index = 0;
  let streamError = null;

  try {
    for await (const chunk of proc.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(chunk.length - offset, frameSize - filled);
        chunk.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled < frameSize) continue;

        const current = index++;
        const cached = takePts(current);
        const pts = cached !== undefined ? cached : await waitPts(current);
        yield {
          index: current,
          buffer: hasAlpha && !preserve ? flattenAlpha(frame, pixelCount) : frame,
          channels: preserve ? 4 : 3,
          pts,
        };
        frame = Buffer.allocUnsafe(frameSize);
        filled = 0;
      }
    }
  } catch (error) {
    streamError = error;
  }

  const result = await closed;
  if (streamError) throw streamError;
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`ffmpeg 解码失败（退出码 ${result.code}）：${stderrText.trim() || '无错误输出'}`);
  }
}

/**
 * RGBA -> RGB24，透明像素按黑色合成：out = channel × alpha / 255。
 * 不透明像素直接复制，避免额外取整改变原图颜色。
 */
function flattenAlpha(rgba, pixels) {
  const rgb = Buffer.allocUnsafe(pixels * 3);
  for (let source = 0, target = 0; target < rgb.length; source += 4, target += 3) {
    const alpha = rgba[source + 3];
    if (alpha === 255) {
      rgb[target] = rgba[source];
      rgb[target + 1] = rgba[source + 1];
      rgb[target + 2] = rgba[source + 2];
    } else {
      rgb[target] = ((rgba[source] * alpha + 127) / 255) | 0;
      rgb[target + 1] = ((rgba[source + 1] * alpha + 127) / 255) | 0;
      rgb[target + 2] = ((rgba[source + 2] * alpha + 127) / 255) | 0;
    }
  }
  return rgb;
}
