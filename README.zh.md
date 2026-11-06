# video-peak-frames

视频抽帧工具。把视频按固定长度的时间槽切分，每个时间槽取变化量最大的一帧，拼成图片输出。另有两种按画面变化分配帧率的采样模式：自适应采样与固定预算采样。

## 功能

- 时间槽按帧的真实时间戳归属。槽内没有源帧时输出空帧，空帧占一个格子，其余帧的位置不变
- 变化量取局部峰值，局部变化与全局变化同等计入
- 自适应采样：画面变化多的片段多抽帧、变化少的片段少抽帧，帧率限定在上下限之间，每段连续覆盖时间轴
- 固定预算采样：给定平均帧率预算，先完整扫描再按变化幅度平滑分配，总帧数固定、图片数量确定
- 时间范围、每秒槽数、图片格式与质量、排版、每张图的帧数可调
- 图片内合成时间码，合成位置与文字方向可选
- 文件名包含视频名、时间区间、图片质量与排版
- 每张图在其帧确定后立即合成并释放帧缓冲，manifest 逐条流式写入，内存占用不随视频时长增长
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

### 自适应采样

开启 `--adaptive` 后，采样频率不再固定。以 `--max-fps` 为基准网格（槽宽为其倒数），按 `--adapt-window` 秒（默认 1 秒）划分窗口。

每个窗口中，每个基准槽保留候选帧里变化量最大的一帧。窗口活动度取这些槽变化量的平均值（只看有帧的槽）。
由活动度线性映射出目标帧率：活动度不高于 `--adapt-low` 时取 `--min-fps`，不低于 `--adapt-high` 时取 `--max-fps`，中间按比例过渡。
目标帧数等于目标帧率乘窗口时长，夹到上下限；同时不超过窗口内有帧的基准槽数，也不超过源帧率。

窗口按目标帧数切分为连续区段，每段取段内活动度最高的候选帧，区段首尾相接覆盖整个窗口。每段对应一个格子，起止时间可变；段内确实没有源帧时输出空帧。
因此每张图覆盖的时间跨度会随画面变化而变化，每帧也带明确时长，可按帧时长重建时间轴。

### 固定预算采样

开启 `--budget` 后，总帧数由预算决定：`round(--budget-fps × 区间时长)`。默认预算 15 fps；每个窗口（`--adapt-window`，默认 1 秒）帧数下限 1、上限 30（`--min-fps` / `--max-fps`）。

预算模式需要先完整扫描一遍：以 `--max-fps` 为基准网格（槽宽为其倒数），每个基准槽保留候选帧里变化量最大的一帧并记录得分，这一遍不保留像素。

随后在「每窗口帧数有上下限、总帧数固定」的约束下做平滑分配：权重取窗口平均活动度的平方根，压缩尖峰片段的影响，避免变化中等的片段被尖峰片段挤到下限。目标等价于最大化各窗口 `sqrt(活动度) × log(帧数)` 之和，连续最优解为 `clamp(λ × sqrt(活动度), 下限, 上限)`；对 λ 二分求出唯一解后，用最大余数法取整，保证总帧数精确等于预算。

选中的槽按时间排序，相邻两帧之间形成一个连续区段：第一段从区间起点开始，最后一段到区间终点。每段对应一个格子，起止时间可变，最后一张图可能不满。

第二遍解码按第一遍记录的帧号抓取选中帧并拼图，因此预算模式会解码两遍；`--dry-run` 只跑第一遍并写 `manifest.json`。

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
node bin/cli.mjs input.mp4 -o out --adaptive
node bin/cli.mjs input.mp4 -o out --adaptive --min-fps 1 --max-fps 30 --adapt-low 0.5 --adapt-high 20
node bin/cli.mjs input.mp4 -o out --budget
node bin/cli.mjs input.mp4 -o out --budget --budget-fps 10 --max-fps 30
```

`--dry-run` 只写 `manifest.json`。`--help` 输出全部参数。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-i, --input` |  | 输入视频 |
| `-o, --out` | `./frames` | 输出目录 |
| `--start` | `0` | 截取起点，秒 |
| `--end` | 片尾 | 截取终点，秒 |
| `--slots-per-second` | `20` | 每秒槽数，即采样频率。自适应模式下作为 `--max-fps` 的默认值；预算模式不使用该参数 |
| `--adaptive` | 关 | 开启自适应采样 |
| `--budget` | 关 | 开启固定预算采样 |
| `--budget-fps` | `15` | 预算平均帧率，1-240，需在 `--min-fps` 与 `--max-fps` 之间 |
| `--min-fps` | 自适应 `2` / 预算 `1` | 每秒抽帧下限 |
| `--max-fps` | 自适应 `--slots-per-second` / 预算 `30` | 每秒抽帧上限，同时决定基准网格密度 |
| `--adapt-window` | `1` | 统计窗口，秒，范围 0-10 |
| `--adapt-low` | `1` | 活动度不高于该值时使用下限帧率 |
| `--adapt-high` | `40` | 活动度不低于该值时使用上限帧率 |
| `--format` | `jpg` | `jpg` / `png` / `webp`；`jpeg` 等价于 `jpg` |
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

自适应与预算模式下文件名格式不变，但每张图的时间跨度随密度变化。自适应模式 `params.mode` 为 `adaptive`，记录 `minFps`、`maxFps`、`adaptWindow`、`adaptLow`、`adaptHigh`；预算模式 `params.mode` 为 `budget`，记录 `budgetFps`、`budgetFrames`、`minFps`、`maxFps`、`adaptWindow`、`allocator`。两种模式的每格都额外记录 `end`、`duration`、`window` 与 `windowFps`，`summary` 增加 `windows` 与 `avgFps`。

`sheets` 在运行过程中逐张图写入磁盘，不在内存里累积整份记录；槽表也按图物化。因此超长视频的内存占用不随片长增长。

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
