# Focused legacy video decoder

This directory builds the WebGPU player's progressive MPEG-2 Video software
decoder. The runtime continues to use Mediabunny for source I/O,
Matroska demuxing, packet timestamps, seeking, and packet ownership. Only the
compressed video packet is passed to this focused decoder.

The decoder links only FFmpeg `libavcodec` and `libavutil`, with every component
disabled except the MPEG-2 Video decoder. It is not `ffmpeg.wasm`, does not
contain the FFmpeg command-line program, and does not expose an in-memory media
filesystem or a second demuxer.

## Build

The build consumes the exact FFmpeg source archive already packaged for the
focused TrueHD/MLP decoder, or downloads the same hash-pinned archive when it
is absent. It rejects any Emscripten version other than 4.0.13 and never reads
a mutable sibling FFmpeg checkout or reuses a configured build directory:

```powershell
python scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py --verify-reproducible
```

The build writes `legacy-video-decode.js`, `legacy-video-decode.wasm`, and their
hash manifest under `artifacts/`. `REVISION` pins the exact FFmpeg source,
Emscripten release, bridge hash, and isolated rebuild result. Release builds
compile twice in independent temporary directories and reject differing output.

## Supported output envelope

- MPEG-2 Main Profile
- 8-bit 4:2:0 output only
- Progressive frames only
- Maximum 1920x1080 until higher tiers pass exact output and throughput probes

Interlaced pictures are detected from the decoded `AVFrame` and rejected.
Interlaced MPEG-2 and deinterlacing are outside this product route and are not
planned by this checkpoint.

Mediabunny 1.52.2 exposes unknown Matroska tracks and their exact packets. This
product route is intentionally Matroska-only. MPEG-TS, M2TS, MPEG-PS, MOV, MP4,
and every other container remain unadvertised.

## Licensing

The bridge is GPL-2.0-or-later as part of jellyfin-web. The linked FFmpeg
configuration contains LGPL components and is built from the revision in
`REVISION`. Ordinary distributions include the upstream LGPL text, bridge
source, repository GPL text, focused/shared build scripts, and the exact FFmpeg
source archive already present under `libraries/ffmpeg-truehd/`. Codec patent
availability remains jurisdiction-dependent and is not established by the
software licenses.
