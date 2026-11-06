import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 写入一块数据，等待落盘（或失败），同时处理背压。 */
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/** 按 JSON.stringify(..., null, 2) 的数组项缩进，供流式写出 sheets。 */
function indentEntry(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

/**
 * manifest 的流式写入。
 *
 * 运行期间 sheets 逐张图写入 spool 文件（约 1MB 批量写），结束时再按
 * JSON.stringify(..., null, 2) 的排版拼成 manifest.json 临时文件并 rename。
 * 这样任意长度的视频都不需要把整份 manifest 常驻内存，输出排版与一次性
 * JSON.stringify 逐字节一致。
 */
export class ManifestSpool {
  constructor({ outDir }) {
    this.outDir = outDir;
    this.manifestPath = path.join(outDir, 'manifest.json');
    this.tmpPath = path.join(outDir, '.manifest.json.tmp');
    this.spoolPath = path.join(outDir, '.manifest-sheets.tmp');

    this.stream = null;
    this.streamError = null;
    this.first = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.count = 0;
  }

  ensureStream() {
    if (this.stream) return;
    this.stream = createWriteStream(this.spoolPath, { flags: 'w' });
    // 写回调能拿到错误；这里再记一份，流被销毁后的同步 throw 也能还原成原始原因。
    this.stream.on('error', (error) => { this.streamError = error; });
  }

  /** 追加一张图的 manifest 条目。 */
  async addSheet(entry) {
    this.ensureStream();
    const chunk = (this.first ? '' : ',\n') + indentEntry(JSON.stringify(entry, null, 2));
    this.first = false;
    this.count++;
    await this.append(chunk);
  }

  async append(chunk) {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= 1024 * 1024) await this.flush();
  }

  async flush() {
    if (!this.pending.length) return;
    const chunk = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    try {
      await writeChunk(this.stream, chunk);
    } catch (error) {
      throw this.streamError ?? error;
    }
  }

  /** 写最终 manifest：头部 + spool 里的 sheets + 收尾，然后原子替换。 */
  async finish(meta) {
    const baseText = JSON.stringify(meta, null, 2);

    if (this.count === 0) {
      const text = `${baseText.slice(0, -2)},\n  "sheets": []\n}`;
      await writeFile(this.tmpPath, text, 'utf8');
      await rename(this.tmpPath, this.manifestPath);
      await rm(this.spoolPath, { force: true }).catch(() => {});
      return;
    }

    this.ensureStream();
    await this.flush();
    try {
      await new Promise((resolve, reject) => {
        this.stream.end((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      throw this.streamError ?? error;
    }

    const head = baseText.slice(0, -2) + ',\n  "sheets": [\n';
    const out = createWriteStream(this.tmpPath, { flags: 'w' });
    out.on('error', () => {});
    await writeChunk(out, head);

    let buffered = [];
    let bufferedBytes = 0;
    for await (const chunk of createReadStream(this.spoolPath)) {
      buffered.push(chunk);
      bufferedBytes += chunk.length;
      if (bufferedBytes >= 1024 * 1024) {
        await writeChunk(out, Buffer.concat(buffered, bufferedBytes));
        buffered = [];
        bufferedBytes = 0;
      }
    }
    if (buffered.length) await writeChunk(out, Buffer.concat(buffered, bufferedBytes));
    await writeChunk(out, '\n  ]\n}');
    await new Promise((resolve, reject) => {
      out.end((error) => (error ? reject(error) : resolve()));
    });

    await rename(this.tmpPath, this.manifestPath);
    // 临时片段清理失败不影响结果，manifest.json 已经就位。
    await rm(this.spoolPath, { force: true }).catch(() => {});
  }

  async abort() {
    if (this.stream) this.stream.destroy();
    await rm(this.tmpPath, { force: true }).catch(() => {});
    await rm(this.spoolPath, { force: true }).catch(() => {});
  }
}

/** 需要完整 sheets 的调用方（测试、工具）按需从磁盘读，避免流水线常驻整份 manifest。 */
export function readSheets(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8')).sheets;
}
