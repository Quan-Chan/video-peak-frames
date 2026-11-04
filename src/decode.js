import { spawn } from 'node:child_process';
import { ffmpegPath } from './probe.js';

const PTS_RE = /n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:([-\d.eE+]+)/;

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

  const ptsByIndex = [];
  let lineBuf = '';
  let stderrText = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderrText = (stderrText + chunk).slice(-16384);
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const match = PTS_RE.exec(line);
      if (match) ptsByIndex[Number(match[1])] = Number(match[2]);
    }
  });

  const closed = new Promise((resolve) => {
    proc.once('error', (error) => resolve({ error }));
    proc.once('close', (code) => resolve({ code }));
  });

  const frameSize = cellWidth * cellHeight * 3;
  let pending = Buffer.alloc(0);
  let index = 0;
  let streamError = null;

  try {
    for await (const chunk of proc.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameSize) {
        const frame = Buffer.from(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
        const current = index++;
        if (ptsByIndex[current] === undefined) {
          // showinfo 的日志先于该帧像素写出，正常情况到这里已就绪；
          // 让出一轮事件循环，保证 stderr 回调先执行完。
          await new Promise(setImmediate);
        }
        yield { index: current, buffer: frame, pts: ptsByIndex[current] ?? null };
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
