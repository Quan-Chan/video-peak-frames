# video-peak-frames

视频抽帧工具。把视频按固定长度的时间槽切分，每个时间槽取变化量最大的一帧，拼成图片输出。

## 功能

- 时间槽按帧的真实时间戳归属。槽内没有源帧时输出空帧，空帧占一个格子，其余帧的位置不变
- 变化量取局部峰值，局部变化与全局变化同等计入
- 时间范围、每秒槽数、图片格式与质量、排版、每张图的帧数可调
- 图片内合成时间码，合成位置与文字方向可选
- 文件名包含视频名、时间区间、图片质量与排版
- 输出 `manifest.json`，记录每个槽的时间戳、得分、候选帧数与选中依据

## 算法

### 时间槽

时间段按槽宽切分为连续的槽。槽宽为 `--slots-per-second` 的倒数，默认每秒 20 槽，即每槽 50 毫秒。
槽 i 覆盖 `[i / n, (i + 1) / n)` 秒，n 为每秒槽数。每帧按时间戳归入所属槽。
每秒帧数少于槽数时存在没有帧的槽，这些槽输出空帧。

### 变化量

相邻两帧的灰度差值图划分为边长 `--block-size`（默认 16）的方块。每块取绝对差的平均值，所有块的最大值作为后一帧的变化量。
计算在 320×180 分辨率上进行。块内取平均抑制噪点。
全局平均绝对差写入 `manifest.json`，不参与排序。

### 选帧

每槽内变化量最大的帧被选中。变化量不超过 `--noise-floor` 时改取槽内靠中间的一帧。
`--noise-floor` 默认 0，即始终取变化量最大的帧。

### 拼图

选中的帧缩放到 `--cell` 指定的单格尺寸，宽高比不变，不足处补边。
按 `--layout` 排成网格。格子数多于帧数时，剩余格子填深灰色。
相邻格子间距 `--gap` 像素，画布底色白色。

### 时间码

时间码文字取 Roboto Mono 字形，经 `opentype.js` 转为 SVG 路径后合成到图片。
渲染不使用 SVG `<text>`，不读取系统字体。

## 安装

```bash
npm install
npm run install:ffmpeg
```

`npm run install:ffmpeg` 获取 LGPL 构建的 ffmpeg 与 ffprobe 到 `vendor/ffmpeg/`。系统 PATH 上已有两者时可跳过。

## 使用

```bash
node bin/cli.mjs input.mp4 -o out
node bin/cli.mjs input.mp4 -o out --start 5 --end 10 --slots-per-second 10
node bin/cli.mjs input.mp4 -o out --layout 2x1 --frames-per-sheet 2 --stamp-pos 右下 --stamp-dir 竖向
```

`--dry-run` 只写 `manifest.json`。`--help` 输出全部参数。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-i, --input` |  | 输入视频 |
| `-o, --out` | `./frames` | 输出目录 |
| `--start` | `0` | 截取起点，秒 |
| `--end` | 片尾 | 截取终点，秒 |
| `--slots-per-second` | `20` | 每秒槽数，即采样频率 |
| `--format` | `jpg` | `jpg` / `png` / `webp` |
| `--quality` | `90` | 图片质量，1-100。png 为无损格式，此值映射为压缩级别 |
| `--layout` | `2x2` | 排版，列 x 行 |
| `--frames-per-sheet` | 排版格子数 | 每张图包含的帧数。超过格子数时报错 |
| `--cell` | `480x270` | 单格尺寸，宽 x 高 |
| `--gap` | `4` | 格子间距，像素 |
| `--annotate` | 开启 | 合成时间码 |
| `--no-annotate` |  | 关闭时间码，空帧横杠仍保留 |
| `--stamp-pos` | `tl` | 时间码位置：`tl` `tr` `bl` `br` `c` `t` `b` `l` `r`；中文可用：左上 右上 左下 右下 中间 上侧 下侧 左边 右边 |
| `--stamp-dir` | `h-lr` | 文字方向：`h-lr` `h-rl` `v-tb` `v-bt`；中文可用：从左至右横向 从右至左横向 从上至下竖向 从下至上竖向 |
| `--noise-floor` | `0` | 变化量地板，0-255 |
| `--block-size` | `16` | 局部变化检测的分块边长，采样像素 |
| `--dry-run` |  | 只写 `manifest.json` |
| `--quiet` |  | 不打印进度 |

## 输出

图片文件名格式：

```text
<视频名>__t<起s>-<止s>__q<质量>__<排版>__<序号>.<扩展名>
```

时间取视频原始时间轴。示例：

```text
clip__t5.00s-5.40s__q90__2x2__00001.jpg
```

`manifest.json` 含 `range`、`params`、`source`、`summary`、`sheets` 五段。`sheets` 每项对应一张图片，记录时间区间与逐格的槽号、时间戳、得分、候选帧数、选中依据。

## 测试

```bash
npm test
```

## 许可证

本项目以 MIT 许可证发布，见 `LICENSE`。

依赖的许可证：

| 组件 | 许可证 |
| --- | --- |
| sharp | Apache-2.0 |
| sharp 的 libvips 预编译二进制（`@img/sharp-libvips-*`） | LGPL-3.0-or-later |
| opentype.js | MIT |
| @expo-google-fonts/roboto-mono | MIT 与 SIL Open Font License 1.1 |
| Roboto Mono 字体 | SIL Open Font License 1.1 |

ffmpeg 与 ffprobe 的可执行文件不随本项目分发。运行时按以下顺序查找：

1. 环境变量 `VPF_FFMPEG` 与 `VPF_FFPROBE`
2. 系统 PATH
3. `vendor/ffmpeg/`，由 `scripts/install-ffmpeg.mjs` 获取，为不含 `--enable-gpl` 的 LGPL 构建

`vendor/` 不进入版本库与发布物。ffmpeg 以独立进程方式调用，本项目代码不与其链接。

sharp 的 libvips 预编译二进制为 LGPL-3.0-or-later。分发含该二进制的产物时，附 LGPL-3.0 许可证全文，并保留替换 libvips 的途径。
