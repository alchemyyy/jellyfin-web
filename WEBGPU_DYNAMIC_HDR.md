# WebGPU Dynamic HDR Implementation Record

Status: Dolby Vision remains implemented per decoded frame. HEVC HDR10+ now has
a bounded per-frame metadata path and an ST 2094-40 tone-mapping path. Invalid
or unsupported HDR10+ metadata falls back to the same frame's static HDR10
configuration without restarting playback.

Research and implementation date: 2026-08-03

## Scope and result

Dynamic HDR is handled before encoded packet ownership leaves the custom decode
worker. JavaScript cannot recover HDR10+ metadata from a decoded `VideoFrame`:
Chromium exposes color-space fields but no ST 2094-40 metadata in the WebCodecs
`VideoFrame` interface. Chromium 153's desktop HEVC parser consumes static CLLI
and MDCV SEI messages and recognizes AGTM T.35 data, but it does not expose the
Samsung HDR10+ T.35 payload to JavaScript. The player therefore parses the
owned encoded access unit and associates its metadata with decoder output by
exact integer-microsecond PTS.

```text
Mediabunny HEVC access unit
  -> bounded prefix/suffix SEI parser
  -> HDR10+ ITU-T T.35 parser
  -> generation-owned exact-PTS reorder queue
  -> WebCodecs or bundled HEVC decoder
  -> worker protocol metadata on the matching decoded frame
  -> presenter render-settings uniform
  -> ST 2094-40 Bezier OOTF or scene-statistics spline
  -> BT.709/sRGB output
```

This does not delegate dynamic-metadata interpretation to the browser and does
not infer it from bitrate, resolution, filename, or container labels.

Playback negotiation advertises Jellyfin's `HDR10Plus` range type only on
authorized HEVC Main10 PQ routes. Native external-texture presentation requires
the existing external PQ authorization; raw presentation requires the existing
raw PQ authorization. The HEVC-specific range is kept out of VP9 and AV1
profiles. This lets an HDR10+ HEVC item reach the custom packet parser without
claiming a dynamic-metadata path for codecs whose packet formats are not
implemented.

## Support matrix

| Input metadata | Current behavior | Failure behavior |
| --- | --- | --- |
| Static HDR10 MDCV and CLLI | Existing bounded startup scan selects static input peak and mastering metadata. | Missing or conflicting metadata uses the existing conservative static configuration. |
| HLG | Existing HLG transfer path. HLG has no HDR10+ ST 2094-40 payload. | Existing route authorization and HTML fallback apply. |
| HDR10+ application version 0 or 1, one whole-frame processing window, no peak-luminance grid | Implemented for HEVC prefix or suffix SEI. Per-frame MaxSCL, average MaxRGB, distributions, target display, knee, and up to 15 Bezier anchors are parsed. | No dynamic payload on a frame uses static HDR10 for that frame. |
| HDR10+ version 0 or 1 with no Bezier anchors | Per-frame peak and average drive the existing perceptual spline. | Static HDR10 is used when the statistics are unusable. |
| HDR10+ multiple processing windows | Syntax is bounded and classified `unsupported`; region masks are not approximated. | Static HDR10 for the frame. |
| HDR10+ targeted or mastering peak-luminance grids | Syntax is bounded and classified `unsupported`; a grid is not collapsed to one guessed peak. | Static HDR10 for the frame. |
| HDR10+ reserved saturation mapping | Syntax is bounded and classified `unsupported`. | Static HDR10 for the frame. |
| HDR10+ application version above 1 | Parsed only far enough to classify it `unsupported`. | Static HDR10 for the frame. |
| Malformed or conflicting HDR10+ payloads | Classified explicitly; no prior-frame value is reused. | Static HDR10 for the frame. |
| HDR10+ in AV1, VP9, or H.264 | Not implemented in the custom packet path. No capability claim is made. | Existing static HDR/browser route or server fallback. |
| Dolby Vision Profiles 5 and 8 | Existing libdovi RPU reconstruction, exact-PTS metadata pairing, and profile-specific authorization. | Profile 5 fails the custom route because its base is not a valid HDR10 fallback. Compatible Profile 8 variants use their verified base fallback. |
| Dolby Vision Profile 7 MEL/FEL | Existing RPU reconstruction plus MEL handling or exact-PTS BL/EL pairing and FEL residual composition. | Verified HDR10 base fallback with explicit telemetry where the profile permits it. |
| Other dynamic HDR systems, including HDR Vivid and SL-HDR | Not implemented or advertised. | Static compatible base if independently valid; otherwise normal player/server fallback. |

## HDR10+ syntax and interpretation

The HEVC parser recognizes `user_data_registered_itu_t_t35` payload type 4
with this exact header:

```text
country_code                 0xB5
terminal_provider_code       0x003C
provider_oriented_code       0x0001
application_identifier       0x04
```

The payload is limited to FFmpeg's 907-byte maximum. The parser removes HEVC
emulation-prevention bytes, handles extended SEI type and size fields, and
requires bounded RBSP trailing bits. It does not retain access-unit views.

MaxSCL, average MaxRGB, and distribution values are converted to nits at the
parse boundary. Whole-frame scene peak and average follow FFmpeg's mapping:

1. Estimate peak luminance from the BT.2020 luma-weighted MaxSCL tuple.
2. Scale average MaxRGB by the ratio between that peak and maximum MaxSCL.
3. If MaxSCL is absent, use the largest distribution percentile as peak.

The tone curve follows libplacebo's ST 2094-40 implementation:

- use metadata knee and Bezier anchors when present;
- adapt the knee and control points when the configured output peak differs
  from the metadata target display;
- map perceptual intensity, preserve bounded IPT chroma, then enter the normal
  display-control and dither stages;
- use per-frame peak/average with the ordinary perceptual spline when anchors
  are absent.

Render-settings schema version 7 reserves 144 uniform bytes. Dynamic mode 0 is
static HDR, mode 1 is per-frame statistics, and mode 2 is the ST 2094-40 Bezier
curve. Slider updates remain uniform-only and do not compile a shader per
frame.

## Lifetime and stale-state rules

Each HEVC decode generation owns one `HEVCDynamicHDRMetadataQueue`.

1. Every VCL access unit queues exactly one explicit state: `absent`,
   `conflicting`, `malformed`, `unsupported`, or `valid`.
2. Decoder output takes exactly one state by signed integer-microsecond PTS.
   Decoder reordering does not change metadata ownership.
3. A packet rejected by the decoder consumes its queued state immediately.
4. End of input requires the queue to be empty. Unmatched output or metadata is
   a decode protocol failure rather than a guessed association.
5. Stop, source replacement, seek retirement, error, and worker retirement
   clear the queue.
6. The presenter writes dynamic uniforms only for a valid matching frame. The
   first subsequent fallback state rewrites the static uniform. Seek also
   rewrites static settings before the new generation can present a frame.

This prevents metadata from an old scene, a reordered frame, or an old playback
generation from affecting a later frame. It also avoids an unnecessary uniform
write for every ordinary static-HDR frame.

Dolby Vision has the same generation isolation at its own parser and exact-PTS
queue boundaries. Its stateful prior-mapping support is intentionally reset at
seek and generation changes, then rebuilt by parsing decode-order RPU data from
the selected random-access point.

## Telemetry

The decode session records counts for all five HDR10+ states. The presenter
records applied dynamic frames, static fallback frames, the last state, and the
last applied per-frame peak. Existing Dolby Vision telemetry remains separate.
This separation is required because a successful static HDR or Dolby Vision
authorization does not prove that a file contained valid HDR10+ metadata.

## Validation assets and commands

Deterministic HEVC access-unit fixtures cover:

- valid single-window ST 2094-40 metadata;
- metadata absence after a valid frame;
- malformed payload syntax;
- conflicting duplicate payloads;
- syntactically bounded but unsupported multiwindow metadata;
- decoder reordering, queue drain, and generation clear;
- worker-protocol rejection of malformed cross-thread objects;
- render-uniform application and static reset on fallback and seek.

Run the focused validation:

```bash
npm test -- src/plugins/webGPUVideoPlayer/custom/HDR10PlusMetadata.test.ts \
  src/plugins/webGPUVideoPlayer/custom/HEVCSEI.test.ts \
  src/plugins/webGPUVideoPlayer/custom/HEVCDynamicHDRMetadataQueue.test.ts \
  src/plugins/webGPUVideoPlayer/custom/CustomDeviceProfile.test.ts \
  src/plugins/webGPUVideoPlayer/custom/CustomPlaybackEligibility.test.ts \
  src/plugins/webGPUVideoPlayer/PresentationInput.test.ts \
  src/plugins/webGPUVideoPlayer/RenderSettings.test.ts \
  src/plugins/webGPUVideoPlayer/color/ColorPipelineShader.test.ts \
  src/plugins/webGPUVideoPlayer/custom/DecodeWorkerProtocol.test.ts \
  src/plugins/webGPUVideoPlayer/custom/CustomDecodeSession.test.ts \
  src/plugins/webGPUVideoPlayer/WebGPUPresenter.test.ts
npm run build:check
python scripts/webgpu/probe_dynamic_HDR_shader.py
```

The browser probe launches an isolated current Chrome or Edge profile, emits
the production raw PQ shader through `vite-node`, and requires both WGSL
compilation and asynchronous render-pipeline creation to succeed. Chrome on the
local NVIDIA Lovelace adapter returned `compiled`, no compilation messages, and
no validation error for render-settings schema version 7.

Inspect a local Matroska or MP4 HEVC title without decoding it:

```bash
npx vite-node scripts/webgpu/probe_dynamic_HDR_fixture.ts \
  '/path/to/title.mkv' 100000
```

The report includes bounded status counts, status transitions with integer
microsecond timestamps, the first valid metadata object, and observed dynamic
peak range. A non-HDR HEVC smoke fixture was probed successfully and reported
five explicit `absent` states without malformed data.

## Release validation matrix

Before claiming HDR10+ as product-qualified, record all of the following:

| Axis | Required cases |
| --- | --- |
| Containers | Matroska and ISO BMFF with HEVC length-prefixed packets; Annex B packet coverage through generated tests. |
| Decode route | Native WebCodecs `VideoFrame`, raw `copyTo`, and bundled HEVC raw planes where each route is otherwise authorized. |
| Metadata cadence | Every-frame, scene-change repetition, absent first frame, valid-to-absent, absent-to-valid, and rapid scene changes. |
| Decoder order | I/P-only, B-frame reorder, duplicate PTS rejection, seek to random-access point, seek storms, and next-item reuse. |
| Payload status | Valid, absent, malformed, conflicting duplicate, application version above 1, multiwindow, both peak grids, and reserved saturation mapping. |
| Display settings | Default 100-nit SDR, changed output peak, paper white, exposure, all three configured static operators, and live setting changes. |
| GPU lifecycle | Initial authorization, first submission validation, active and paused device loss, one recovery, second-loss fallback, and DPR/fullscreen resize. |
| Reference | Same timestamps captured from mpv/libplacebo ST 2094-40 with matched output peak and no ICC/night-light transforms; compare luma curve, highlight detail, color error, and temporal discontinuity. |
| Soak | At least one feature-length HDR10+ title, bounded worker queue, no retained frame buffers, no stale dynamic uniforms, and stable telemetry counts. |

No product support claim should be expanded to AV1, VP9, H.264, multiwindow
processing, or a peak grid until that exact packet parser and render behavior
has equivalent deterministic and real-title evidence.

## Source and licensing record

No new decoder binary or runtime dependency is introduced by this work. The
syntax and reference math were checked against these exact source revisions:

- FFmpeg `a59498db085e3d635532397128550141ab87408a`:
  `libavcodec/itut35.c`, `libavutil/hdr_dynamic_metadata.c`, and
  `libswscale/format.c`.
- libplacebo `4d82c6898551068d4ae6a6b5538efcddc2c7cf64`:
  `src/tone_mapping.c`, especially `st2094_40` and its knee/control-point
  adaptation.
- mpv `1d15686142fd5d53c954aab7526cedab05ef9dc3`:
  `video/out/vo_gpu_next.c`, which selects libplacebo's ST 2094-40 function.
- Chromium 153.0.7986.1 local source:
  `media/gpu/h265_decoder.cc`, `media/base/agtm.cc`, and
  `third_party/blink/renderer/modules/webcodecs/video_frame.idl`.

FFmpeg and libplacebo source files used for reference are LGPL-2.1-or-later.
The repository's GPL-2.0-or-later license is compatible with that reference
implementation work. Chromium references are BSD-licensed and were used to
confirm browser behavior, not copied into the player.

## Known remaining limitations

- There is not yet a checked-in, decodable HDR10+ media fixture. The in-code
  access units deterministically validate packet syntax and ownership, while a
  private or generated real HEVC file is still required for browser/mpv pixel
  qualification.
- Region-based multiwindow rendering and peak-luminance grids are intentionally
  not approximated.
- The normal HTML backend can still play browser-supported HDR10+ content, but
  the custom shader cannot consume metadata hidden inside that backend.
- WebGPU output remains an SDR canvas in this phase. Native HDR display output
  and metadata passthrough are separate future work.
