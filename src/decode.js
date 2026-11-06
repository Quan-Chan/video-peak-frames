import { spawn } from 'node:child_process';
import { ffmpegPath } from './probe.js';

const PTS_RE = /n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:([-\d.eE+]+)/;
/** 等 showinfo 行的兜底上限：正常远小于此值，只防解析器异常时卡死。 */
const PTS_WAIT_TIMEOUT_MS = 10000;

/**
 * 单遍流式解码。滤镜链末尾挂 showinfo，把每帧的 pts_time 打到 stderr，
 * 从而免掉一次 ffprobe 全片扫描，且时间戳与帧严格一一对应。
 * start/end 用 ffmpeg 输入侧 -ss / -t 截取，只解码目标片段。
 */
export async function* decodeFrames({ input, cellWidth, cellHeight, start = 0, end = null }) {
  const filter = [
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
  args.push('-vf', filter, '-pix_fmt', 'rgb24', '-vsync', '0', '-f', 'rawvideo', 'pipe:1');

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

  const frameSize = cellWidth * cellHeight * 3;
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
        yield { index: current, buffer: frame, pts };
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
