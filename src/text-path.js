import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';

/**
 * 文本 -> SVG path 轮廓。
 *
 * 字体：Roboto Mono，SIL Open Font License 1.1（可商用、可再分发），
 * 经 @expo-google-fonts/roboto-mono（MIT 包装）引入。
 * 用 opentype.js 把字形转成 SVG path 后再交给 sharp 渲染，
 */
const require_ = createRequire(import.meta.url);

let fontCache = null;

function fontFile() {
  const dir = path.dirname(require_.resolve('@expo-google-fonts/roboto-mono/package.json'));
  return path.join(dir, '400Regular', 'RobotoMono_400Regular.ttf');
}

function loadFont() {
  if (!fontCache) {
    const buf = fs.readFileSync(fontFile());
    fontCache = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return fontCache;
}

/** 文本转 SVG path 的 d 属性。(x, y) 是基线左端点。 */
export function textToPathData(text, x, y, fontSize) {
  return loadFont().getPath(String(text), x, y, fontSize).toPathData(2);
}

/** 文本在给定字号下的宽度（px）。 */
export function measureText(text, fontSize) {
  return loadFont().getAdvanceWidth(String(text), fontSize);
}

export const FONT_INFO = Object.freeze({
  family: 'Roboto Mono',
  license: 'SIL Open Font License 1.1',
  packaging: '@expo-google-fonts/roboto-mono (MIT)',
});
