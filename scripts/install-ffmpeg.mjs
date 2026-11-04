#!/usr/bin/env node
/**
 * 安装 LGPL 构建的 ffmpeg / ffprobe 到 vendor/ffmpeg/。
 *
 * 来源：BtbN/FFmpeg-Builds 的 lgpl 构建（不含 --enable-gpl 与 x264/x265 等 GPL 组件）。
 * 解压后校验 `ffmpeg -version` 不含 --enable-gpl，含则中止并删除。
 * 二进制不进版本库，由本脚本按需获取；分发本项目源码不含 GPL 代码。
 *
 * 用法：node scripts/install-ffmpeg.mjs [--force]
 * 跳过：VPF_SKIP_FFMPEG_INSTALL=1
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor', 'ffmpeg');

const BUILDS = {
  'win32-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip',
    inner: 'ffmpeg-n8.1-latest-win64-lgpl-8.1/bin',
    bin: ['ffmpeg.exe', 'ffprobe.exe'],
    extract: 'zip',
  },
  'linux-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz',
    inner: 'ffmpeg-n8.1-latest-linux64-lgpl-8.1/bin',
    bin: ['ffmpeg', 'ffprobe'],
    extract: 'tarxz',
  },
};

function log(msg) {
  console.log(`[install-ffmpeg] ${msg}`);
}

function fail(msg) {
  console.error(`[install-ffmpeg] ${msg}`);
  process.exit(1);
}

function target() {
  const key = `${process.platform}-${process.arch}`;
  return BUILDS[key] ?? null;
}

function assertLgpl(binPath) {
  const out = execFileSync(binPath, ['-version'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (out.includes('--enable-gpl')) {
    throw new Error(`构建含 --enable-gpl，不符合 LGPL 要求：${binPath}`);
  }
  if (!/libav/i.test(out)) {
    throw new Error(`无法确认 ffmpeg 构建：${binPath}`);
  }
  return out.split('\n')[0].trim();
}

async function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    await exec('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  await exec('unzip', ['-o', '-q', zipPath, '-d', destDir]);
}

async function extractTarXz(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await exec('tar', ['-xJf', archive, '-C', destDir]);
}

async function download(url, to) {
  log(`下载 ${url}`);
  // 用 curl 下载：会读取 http_proxy/https_proxy。
  // Node 内置 fetch 不读代理变量，在代理环境下直连会失败。
  // --ssl-no-revoke：schannel 在代理环境下吊销检查会失败，跳过 CRL/OCSP 查询，
  // 证书验证本身仍然执行。
  await exec('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--ssl-no-revoke', '-o', to, url]);
  const size = fs.statSync(to).size;
  if (size < 1048576) throw new Error(`下载结果过小（${size} 字节），不是有效的压缩包`);
  log(`已下载 ${(size / 1048576).toFixed(1)} MB`);
}

async function main() {
  if (process.env.VPF_SKIP_FFMPEG_INSTALL === '1') {
    log('VPF_SKIP_FFMPEG_INSTALL=1，跳过');
    return;
  }
  const force = process.argv.includes('--force');
  const spec = target();
  if (!spec) {
    log(`平台 ${process.platform}-${process.arch} 无预置 LGPL 构建。`);
    log('请自行安装 LGPL 构建的 ffmpeg 与 ffprobe，并设置 VPF_FFMPEG / VPF_FFPROBE。');
    return;
  }

  const wanted = spec.bin.map((b) => path.join(vendorDir, b));
  if (!force && wanted.every((p) => fs.existsSync(p))) {
    log('已存在，跳过（--force 可重装）');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpf-ffmpeg-'));
  try {
    const archive = path.join(tmp, path.basename(spec.url));
    await download(spec.url, archive);
    const unpacked = path.join(tmp, 'unpacked');
    if (spec.extract === 'zip') await extractZip(archive, unpacked);
    else await extractTarXz(archive, unpacked);

    const binDir = path.join(unpacked, spec.inner);
    fs.mkdirSync(vendorDir, { recursive: true });
    for (const name of spec.bin) {
      const src = path.join(binDir, name);
      if (!fs.existsSync(src)) throw new Error(`压缩包内缺少 ${name}`);
      fs.copyFileSync(src, path.join(vendorDir, name));
      fs.chmodSync(path.join(vendorDir, name), 0o755);
    }

    for (const bin of wanted) {
      log(`校验 ${path.basename(bin)}：${assertLgpl(bin)}`);
    }
    log(`完成，安装到 ${vendorDir}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
