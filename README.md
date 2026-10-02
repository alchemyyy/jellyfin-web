# Jellyfin Web with WebGPU Player

A fork of [Jellyfin Web](https://github.com/jellyfin/jellyfin-web) that adds a
WebGPU video player. It direct-plays formats that stock Jellyfin Web would
transcode. Video is decoded in the browser with WebCodecs or bundled
WebAssembly decoders, then drawn with WebGPU, including HDR and Dolby Vision
tone mapping.

## What it adds

- **Direct play in the browser** for:
  - HEVC, including HDR10, HDR10+, HLG, and the 4:2:2 and 4:4:4 range
    extensions
  - Dolby Vision profiles 5, 7, and 8
  - MPEG-2 and VC-1 in Matroska, and JPEG 2000
  - DTS (including DTS-HD MA), TrueHD, E-AC-3, and AC-3 audio, with a choice of
    stereo downmix
- **Capability checks.** The player tells the server only about formats it can
  handle in this browser on this GPU, based on tests it runs in the browser.
  Everything else transcodes as usual.
- **Automatic fallback.** If WebGPU or a decoder fails, playback continues in
  the standard HTML player.
- **WebGPU rendering of regular playback**, for HDR tone mapping and color
  controls.

## Requirements

- **Jellyfin server:** the version named in the release. The web client must
  match the server version.
- **Browser:** Chrome or Edge. Browsers without WebGPU and WebCodecs use the
  standard HTML player.
- **HTTPS:** WebGPU only runs in a secure context, so reach Jellyfin over HTTPS
  (for example through a reverse proxy) or at `localhost`.

## Install

1. Download the archive for your server version from
   [Releases](https://github.com/alchemyyy/jellyfin-web/releases).
2. Stop Jellyfin and back up its web directory:
   - Windows: `C:\Program Files\Jellyfin\Server\jellyfin-web`
   - Debian and Ubuntu: `/usr/share/jellyfin/web`
   - Docker (official image): `/jellyfin/jellyfin-web`
3. Replace the directory's contents with the archive's contents. For Docker,
   mount the extracted archive over `/jellyfin/jellyfin-web`. Alternatively,
   start Jellyfin with `--webdir <path>` or `JELLYFIN_WEB_DIR=<path>`.
4. Start Jellyfin, then hard-refresh open browser tabs so they load the new
   scripts.

To uninstall, restore the backed-up web directory.

## Use

The WebGPU player is selected automatically. To change this for one browser,
open **Settings > Playback > Preferred video player** and choose Auto, WebGPU,
or HTML. The same page sets the stereo downmix algorithm.

Server-wide switches are in the web directory's `config.json`:
`enableWebGPUCustomDecode` and `enableWebGPUHDRToneMapping`.

## Note: HEVC 4:2:2 direct play

When FFprobe reports no bit depth for a file, stock Jellyfin infers it only for
4:2:0 and 4:4:4 pixel formats. Such HEVC 4:2:2 files therefore transcode
instead of direct playing. The server fix is the single commit on the
[`derive-422-bit-depth`](https://github.com/alchemyyy/jellyfin/tree/derive-422-bit-depth)
branch, which is based on upstream Jellyfin.

## Building from source

Requires Node.js 24 and npm 11. Two git submodules live in `vendor/`, so clone
with `--recurse-submodules` or run `git submodule update --init`:

- `vendor/webgpu-player/`: the
  [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player) engine, installed
  as an npm workspace.
- `vendor/webgpu-player-hls/`: the patched
  [hls.js](https://github.com/alchemyyy/hls.js/tree/fix/cals2) (branch
  `fix/cals2`). Build it once with `npm ci` and `npm run build` in that folder.

Then run `npm ci` and `npm run build:production`. The output is in `dist/`.

Design notes for the player and this fork's integration (architecture,
negotiation, codec support, module map, and settled decisions) are in the
engine's [`.agents/`](https://github.com/alchemyyy/WebGPU-Player/tree/master/.agents)
folder, checked out at `vendor/webgpu-player/.agents/`.

## Credits

- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) demuxes media
  for in-browser decoding and remuxes audio to fragmented MP4 for native
  playback. Its [`@mediabunny/ac3`](https://www.npmjs.com/package/@mediabunny/ac3)
  extension supplies the AC-3 decoder.
- [FFmpeg](https://ffmpeg.org/) (LGPL-2.1-or-later) supplies the E-AC-3,
  TrueHD/MLP, MPEG-2 Video, and VC-1 decoders, compiled to WebAssembly from a
  pinned revision. `@mediabunny/ac3` is built on FFmpeg as well.
  - Each decoder's license, bridge source, and source notice ship in the web
    directory's `libraries/` folder.
  - The corresponding FFmpeg and libdcadec source is published with each
    [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player) release.

## License

GPL-2.0, like Jellyfin Web. Bundled third-party decoders keep their own
licenses.
