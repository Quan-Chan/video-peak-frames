# video-peak-frames

Video frame extraction tool. It splits a video into fixed-length time slots, picks the frame with the highest change in each slot, and composes the frames into images. An adaptive sampling mode can also distribute the frame rate according to how much the picture changes.

## Features

- Frames are assigned to slots by their real timestamps. A slot without a source frame produces an empty frame, which occupies one cell and leaves the position of other frames unchanged.
- Change is measured as a local peak, so local change and global change count equally.
- Adaptive sampling: busy segments get more frames and quiet segments get fewer, with a frame rate clamped between a lower and an upper bound; segments tile the timeline.
- Time range, slots per second, image format and quality, layout, and frames per image are configurable.
- A timecode can be composited into the images, with selectable position and text direction.
- File names carry the video name, time range, image quality, and layout.
- Each sheet is composed as soon as its frames are known, and frame buffers are released immediately; the manifest is written incrementally, so memory use does not grow with video length.
- `manifest.json` records the timestamp, score, candidate count, and selection basis of every slot.

## Algorithm

### Time slots

The time range is divided into consecutive slots of fixed width. The width is the reciprocal of `--slots-per-second`, default 20 slots per second, that is 50 milliseconds per slot.
Slot i covers `[i / n, (i + 1) / n)` seconds, where n is the slots per second. Each frame falls into the slot that contains its timestamp.
When the frame rate is lower than the slots per second, some slots hold no frame. Those slots produce empty frames.

### Change

The absolute difference of two consecutive frames is divided into blocks of `--block-size` pixels on the side, default 16. For each block the mean absolute difference is taken; the maximum over all blocks is the change of the later frame.
The computation runs at 320×180. Averaging within a block suppresses noise.
The global mean absolute difference is written to `manifest.json` and is not used for ranking.

### Selection

The frame with the highest change in a slot is selected. When the change does not exceed `--noise-floor`, a frame near the middle of the slot is selected instead.
`--noise-floor` defaults to 0, which selects the highest change in every case.

### Adaptive sampling

With `--adaptive` the sampling rate is no longer fixed. `--max-fps` defines the base grid (its reciprocal is the slot width), and the timeline is divided into windows of `--adapt-window` seconds, one second by default.

Inside a window, every base slot keeps the highest-change candidate frame. The window activity is the mean change of those slots, counting only slots that have a frame.
A target frame rate is mapped linearly from the activity: at or below `--adapt-low` it is `--min-fps`, at or above `--adapt-high` it is `--max-fps`, with a proportional transition in between.
The target frame count is the target rate times the window duration, clamped to both bounds; it never exceeds the number of occupied base slots nor the source frame rate.

The window is split into that many consecutive segments, each taking the highest-change candidate frame inside it; segments tile the whole window. Every segment occupies one cell and may have a different duration. A segment without any source frame produces an empty frame.
A sheet therefore covers a time span that depends on the amount of change, and every frame carries a duration, so the timeline can be reconstructed from the frames.

### Composition

Selected frames are scaled to the cell size given by `--cell`, keeping aspect ratio and padding the rest.
Cells are arranged in the grid given by `--layout`. When the grid has more cells than frames, the remaining cells are filled with dark gray.
Adjacent cells are separated by `--gap` pixels on a white canvas.

### Timecode

Timecode text is taken from the Roboto Mono glyph outlines, converted to SVG paths by `opentype.js`, and composited into the image.
Rendering does not use SVG `<text>` and does not read system fonts.

## Install

```bash
npm install
npm run install:ffmpeg
```

`npm run install:ffmpeg` fetches an LGPL build of ffmpeg and ffprobe into `vendor/ffmpeg/`. It can be skipped when both are already on the system PATH.

## Usage

```bash
node bin/cli.mjs input.mp4 -o out
node bin/cli.mjs input.mp4 -o out --start 5 --end 10 --slots-per-second 10
node bin/cli.mjs input.mp4 -o out --layout 2x1 --frames-per-sheet 2 --stamp-pos br --stamp-dir v-tb
node bin/cli.mjs input.mp4 -o out --adaptive
node bin/cli.mjs input.mp4 -o out --adaptive --min-fps 1 --max-fps 30 --adapt-low 0.5 --adapt-high 20
```

`--dry-run` writes `manifest.json` only. `--help` lists all options.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-i, --input` |  | Input video |
| `-o, --out` | `./frames` | Output directory |
| `--start` | `0` | Range start in seconds |
| `--end` | end of video | Range end in seconds |
| `--slots-per-second` | `20` | Slots per second, the sampling rate. Used as the default of `--max-fps` in adaptive mode |
| `--adaptive` | off | Enable adaptive sampling |
| `--min-fps` | `2` | Lower bound of the adaptive frame rate |
| `--max-fps` | `--slots-per-second` | Upper bound of the adaptive frame rate, which also sets the base grid density |
| `--adapt-window` | `1` | Activity window in seconds, 0-10 |
| `--adapt-low` | `1` | Activity at or below this value uses the lower rate |
| `--adapt-high` | `40` | Activity at or above this value uses the upper rate |
| `--format` | `jpg` | `jpg` / `png` / `webp`; `jpeg` is an alias of `jpg` |
| `--quality` | `90` | Image quality, 1-100. png is lossless; the value maps to the compression level |
| `--layout` | `2x2` | Layout as columns x rows |
| `--frames-per-sheet` | cells of layout | Frames per image. Errors out when it exceeds the cell count |
| `--cell` | `480x270` | Cell size as width x height |
| `--gap` | `4` | Gap between cells in pixels |
| `--annotate` | on | Composite the timecode |
| `--no-annotate` |  | Disable the timecode; the empty-frame mark remains |
| `--stamp-pos` | `tl` | Timecode position: `tl` `tr` `bl` `br` `c` `t` `b` `l` `r` |
| `--stamp-dir` | `h-lr` | Text direction: `h-lr` `h-rl` `v-tb` `v-bt` |
| `--noise-floor` | `0` | Change floor, 0-255 |
| `--block-size` | `16` | Block side for local change detection, in sample pixels |
| `--dry-run` |  | Write `manifest.json` only |
| `--quiet` |  | Suppress progress output |

## Output

Image file names follow:

```text
<video>__t<start>s-<end>s__q<quality>__<layout>__<index>.<ext>
```

Times refer to the original video timeline. Example:

```text
clip__t5.00s-5.40s__q90__2x2__00001.jpg
```

`manifest.json` contains `range`, `params`, `source`, `summary`, and `sheets`. Each entry of `sheets` corresponds to one image and records its time range and, per cell, the slot number, timestamp, score, candidate count, and selection basis.

In adaptive mode the file name format is unchanged, but the time span of each image varies with the density; `params.mode` is `adaptive` and records `minFps`, `maxFps`, `adaptWindow`, `adaptLow`, and `adaptHigh`. Every cell additionally records `end`, `duration`, `window`, and `windowFps`, and `summary` gains `windows` and `avgFps`.

Entries of `sheets` are appended to disk image by image instead of being accumulated in memory, and the slot table is materialized per image. Memory use therefore does not grow with the length of the input.

## Test

```bash
npm test
```

## License

This project is released under the MIT License, see `LICENSE`.

Licenses of dependencies:

| Component | License |
| --- | --- |
| sharp | Apache-2.0 |
| prebuilt libvips binaries of sharp (`@img/sharp-libvips-*`) | LGPL-3.0-or-later |
| opentype.js | MIT |
| @expo-google-fonts/roboto-mono | MIT and SIL Open Font License 1.1 |
| Roboto Mono font | SIL Open Font License 1.1 |

The ffmpeg and ffprobe executables are not distributed with this project. At runtime they are located in this order:

1. Environment variables `VPF_FFMPEG` and `VPF_FFPROBE`
2. The system PATH
3. `vendor/ffmpeg/`, fetched by `scripts/install-ffmpeg.mjs`, an LGPL build without `--enable-gpl`

`vendor/` is kept out of the repository and out of any release artifact. ffmpeg is invoked as a separate process; this project does not link against it.

The prebuilt libvips binaries of sharp are LGPL-3.0-or-later. When distributing an artifact that contains them, include the LGPL-3.0 license text and keep libvips replaceable.
