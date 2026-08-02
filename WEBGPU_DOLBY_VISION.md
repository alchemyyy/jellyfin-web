# WebGPU Dolby Vision Implementation Record

Status: Profile 5 and 8 reconstruction, Profile 7 MEL reconstruction, and
exact-device runtime authorization implemented; Profile 7 FEL currently uses
an explicit HDR10-base fallback while full residual composition remains pending

Research date: 2026-08-01
Target: mpv-quality Dolby Vision reconstruction in the custom WebGPU decode path

## Purpose

This document records how mpv, FFmpeg, and libplacebo implement Dolby
Vision, where that implementation is intentionally incomplete, and how to
reproduce the useful parts in this repository.

The target is not native Dolby Vision passthrough or Dolby certification.
The target is the open-source reconstruction model used by mpv:

```text
encoded HEVC access units
  -> base-layer decode
  -> RPU parsing and per-frame reshaping metadata
  -> optional Profile 7 enhancement-layer decode and residual composition
  -> BT.2020/PQ image
  -> ordinary WebGPU gamut and tone mapping
```

Dolby Vision must remain a separately qualified route. The player must not
advertise Dolby Vision merely because it can decode the underlying HEVC base
layer.

## Executive conclusion

mpv does not use a native Dolby playback stack. FFmpeg parses Dolby Vision
RPU data from the encoded HEVC stream, libplacebo reconstructs a standard
BT.2020/PQ image in shaders, and libplacebo then performs its normal gamut and
tone mapping. Hardware decoding can supply the base and enhancement images,
but the Dolby Vision reconstruction remains shader-side.

There are two distinct mpv parity targets:

1. **mpv v0.41 stable parity**
   - Genuine Profile 5 and Profile 8.x RPU reshaping.
   - Profile 7 falls back to its HDR10-compatible base layer.
   - Optional L1 brightness metadata can still influence generic tone mapping.
2. **Current mpv master parity**
   - Includes the Profile 5 and 8.x path.
   - Adds Profile 7 MEL/FEL support, a second HEVC decoder, PTS pairing, and
     FEL residual composition.

The Profile 7 work landed in May 2026, after the v0.41.0 release. It is in
current mpv development sources but not the latest stable release as of the
research date.

## Implemented reconstruction checkpoint

The repository now contains a pinned `wasm32-unknown-unknown` wrapper around
libdovi revision `38adec045bf183c24df38149836c920398072281`. It has no WASM
imports, exports a fixed 16 MiB maximum memory, accepts at most 64 KiB per RPU,
and copies a 3,232-byte schema-versioned snapshot out of module memory. The
artifact, exact revision, and libdovi license are copied into the ordinary web
build and verified byte-for-byte by the codec artifact gate.

The parser currently:

- accepts Profiles 5, 7, and 8;
- retains 16 mapping IDs and implements prior-mapping lookup plus FFmpeg's
  mapping-ID-zero fallback;
- resets all mapping state at generation and seek boundaries;
- converts encoded pivot deltas into the cumulative normalized pivots required
  by libplacebo's shader model;
- packs polynomial and MMR curves, nonlinear and linear matrices, LINEAR_DZ
  NLQ data, source PQ bounds, and L1 metadata into finite float32 data;
- identifies single-layer, MEL, FEL, and active FEL residual cases;
- rejects Profile 4, malformed CRCs, compressed display metadata, unsupported
  interpolation, mixed per-segment mapping methods, missing prior state, and
  out-of-range metadata instead of approximating them.

Conformance tests instantiate the checked-in WASM artifact directly and cover
eight upstream libdovi fixtures, stable output hashes, Profile 4 rejection,
CRC failure and recovery, owned snapshots, exact close behavior, zero imports,
the 16 MiB growth ceiling, and corrupt packed-schema rejection. Rust unit tests
cover explicit mapping storage, exact prior-ID lookup, ID-zero fallback, and
reset semantics.

Each HEVC worker generation now owns and prewarms one parser session. RPU NAL
units are parsed sequentially in packet decode order before the cleaned base
layer packet reaches the decoder. Ordinary HEVC packets do not wait for parser
initialization. Parsed snapshots are paired with decoder output by exact signed
integer-microsecond PTS and transferred under protocol schema version 3. The
compressed enhancement access unit and raw RPU bytes remain worker-local. Only
the packed RPU snapshot and an `absent`, `discarded-mel`, or `discarded-fel`
disposition cross the worker boundary. Stop, seek, failure, and generation
retirement reset and close the parser exactly once.

The presentation path now consumes those snapshots through a fixed WebGPU
storage buffer and follows libplacebo's reshape, nonlinear matrix, PQ EOTF,
RGB-to-LMS, HPE LMS-to-BT.2020, and PQ OETF order. Profile 5 and single-layer
Profile 8 are represented by a separate presentation descriptor rather than by
overloading ordinary PQ or HLG metadata.

The routes are fail-closed. Profile 5 and 8 require an exact per-frame RPU and
no enhancement-layer payload. Profile 7 requires an exact RPU, an enhancement
NAL in the encoded access unit, and a disposition matching the parsed MEL or
FEL state. Raw presentation requires qualified 10-bit I420 output and the
applicable exact-device GPU authorization fixture. Native Profile 5
presentation separately requires decoded-output evidence for its exact
WebCodecs configuration and authorization of the production
`GPUExternalTexture` shader path. A successful authorization for one route
cannot authorize another. Device recovery repeats the applicable authorization
and creates a new per-frame storage buffer before presentation resumes.

Profile 7 MEL applies RPU reconstruction to the HDR10-compatible base image.
Profile 7 FEL is currently identified exactly but deliberately presents the
HDR10 base instead of applying the RPU without its residual. Full FEL requires
the worker-local enhancement packet to feed a second decoder, exact-PTS BL/EL
pairing, LINEAR_DZ composition, and new device authorization fixtures.
Presentation telemetry counts successful Profile 7 MEL frames separately from
FEL HDR10-base fallback frames so a session cannot report full FEL fidelity by
omission.

## Profile support matrix

| Profile | mpv v0.41 stable | Current mpv master | Safe custom-player fallback |
| --- | --- | --- | --- |
| 5 | Full RPU reshape | Full RPU reshape | No generic base-layer fallback. Use a qualified native HTML path or server transcode |
| 7 MEL | HDR10 base; optional L1-assisted generic tone mapping | RPU reshape; trivial NLQ means no useful EL residual | HDR10 base |
| 7 FEL | HDR10 base; FEL fidelity is lost | BL plus second EL decode, LINEAR_DZ residual merge, and RPU reshape | HDR10 base or explicitly reported BL-only approximation |
| 8.1 | Full RPU reshape | Full RPU reshape | HDR10 base |
| 8.4 | Full RPU reshape | Full RPU reshape | HLG base |
| Other 8.x | Generic 8.x implementation exists | Same | Depends on the BL signal compatibility ID; do not advertise without fixtures |
| 4 | Unsupported | Unsupported | No custom route |

### Profile 5

Profile 5 is single-layer, but its base signal is not backward-compatible with
ordinary HDR10 or HLG presentation. Decoding its HEVC picture and treating the
result as ordinary BT.2020/PQ is incorrect. Its RPU reshape curves and color
matrices are required.

Evidence:

- libplacebo's initial implementation explicitly covers Profiles 5 and 8.x and
  consumes color matrices and reshaping coefficients:
  [libplacebo Dolby Vision implementation commit](https://github.com/haasn/libplacebo/commit/775a9325a23e26443b562b104c1fe949b99aa3c8)
- libdovi reports Profile 5 as not backward-compatible:
  [profile5.rs](https://github.com/quietvoid/dovi_tool/blob/38adec045bf183c24df38149836c920398072281/dolby_vision/src/rpu/profiles/profile5.rs)

If RPU parsing or shader reconstruction fails for Profile 5, the custom path
must stop presenting that session. It may switch to the already-defined whole
player fallback, but it must never silently reinterpret the raw frame as HDR10.

### Profile 7

Profile 7 contains an HDR10-compatible base layer, RPU metadata, and an
enhancement layer. The RPU header has `disable_residual_flag = 0`.

MEL and FEL differ in the enhancement residual:

- MEL carries trivial NLQ parameters, so there is no useful residual to merge.
- FEL carries nontrivial NLQ parameters and requires the enhancement image for
  full reconstruction.

libdovi's MEL test checks for zero offsets, slopes, and thresholds with the
expected neutral maximum values. Nontrivial data is classified as FEL:
[rpu_data_nlq.rs](https://github.com/quietvoid/dovi_tool/blob/38adec045bf183c24df38149836c920398072281/dolby_vision/src/rpu/rpu_data_nlq.rs).

Stable mpv v0.41 only maps parsed Dolby Vision metadata when
`disable_residual_flag` is true. That excludes Profile 7:
[mpv v0.41 mp_image.c](https://github.com/mpv-player/mpv/blob/v0.41.0/video/mp_image.c#L1182-L1204).

Current mpv master maps the newer libplacebo metadata model and supports the
enhancement image:
[current mpv mp_image.c](https://github.com/mpv-player/mpv/blob/1d15686142fd5d53c954aab7526cedab05ef9dc3/video/mp_image.c#L1180-L1207).

### Profile 8.x

Profile 8 is single-layer and normally has a compatible base representation.
The two initial targets are:

- Profile 8.1: HDR10-compatible base.
- Profile 8.4: HLG-compatible base.

Dolby documents these compatibility relationships:

- [Dolby Vision encoding guidance](https://professionalsupport.dolby.com/s/article/Dolby-Vision-Encoding-using-Blackmagic-Design-DaVinci-Resolve-Studio-AQs)
- [Dolby Vision Profile 8.4 description](https://professionalsupport.dolby.com/s/article/Dolby-Vision-for-video-sharing-services-FAQs)

Other Profile 8 compatibility IDs must remain unadvertised until corresponding
fixtures and fallback behavior are known.

## mpv and libplacebo reconstruction pipeline

### Metadata production

FFmpeg's HEVC decoder parses RPU NAL units and attaches structured
`AV_FRAME_DATA_DOVI_METADATA` side data to decoded frames. The relevant parser
and metadata definitions are:

- [FFmpeg dovi_rpudec.c](https://github.com/FFmpeg/FFmpeg/blob/406c5a37aa666d648928a142d367483fe1acdd17/libavcodec/dovi_rpudec.c)
- [FFmpeg dovi_meta.h](https://github.com/FFmpeg/FFmpeg/blob/406c5a37aa666d648928a142d367483fe1acdd17/libavutil/dovi_meta.h)

The parser is stateful. In particular, an RPU may use `use_prev_vdr_rpu` to
refer to prior mapping state. Seeking therefore requires resetting parser state,
starting at an appropriate random-access packet, and parsing every intervening
RPU in decode order.

FFmpeg's current parser has explicit limitations:

- unsupported RPU formats request a sample and fail;
- missing RPU VDR sequence information is unsupported;
- dynamic metadata compression modes greater than one are not implemented;
- only `AV_DOVI_NLQ_LINEAR_DZ` is implemented;
- an undocumented linear-interpolation mapping mode is unsupported.

These limitations should be treated as route failures, not approximated with
unverified math.

### Metadata mapping

`pl_map_dovi_metadata` maps the parsed FFmpeg structures into the shader-facing
model. It copies:

- the nonlinear YCC-to-RGB matrix and offset;
- the RGB-to-LMS matrix;
- per-component pivots;
- polynomial or MMR reshape coefficients;
- Profile 7 LINEAR_DZ offsets, slopes, and thresholds.

`pl_map_avdovi_metadata` then marks the input representation as Dolby Vision
and its reconstructed output as BT.2020/PQ:
[libplacebo libav_internal.h](https://github.com/haasn/libplacebo/blob/4d82c6898551068d4ae6a6b5538efcddc2c7cf64/src/include/libplacebo/utils/libav_internal.h#L941-L1058).

### Exact reconstruction order

The WebGPU implementation should initially follow libplacebo's order exactly:

1. Normalize base-layer sample code values into the representation expected by
   the RPU.
2. Clamp the normalized components to `[0, 1]` and apply each component's
   piecewise polynomial or MMR reshape curve.
3. If a nontrivial Profile 7 FEL enhancement image is available, center and
   dequantize it with LINEAR_DZ and add the residual to the reshaped base image.
4. Apply the RPU nonlinear YCC-to-RGB matrix and offset.
5. Apply the PQ EOTF to the nonlinear component values.
6. Apply the supplied RGB-to-LMS matrix followed by libplacebo's fixed BT.2020
   HPE LMS-to-RGB matrix.
7. Apply the PQ OETF. The result is ordinary BT.2020/PQ encoded RGB.
8. Feed that image to the existing linearization, gamut mapping, tone mapping,
   display controls, and output encoding stages.

The exact reference symbols are `pl_shader_dovi_reshape`,
`sh_dovi_compose_nlq`, and `PL_COLOR_SYSTEM_DOLBYVISION`:
[libplacebo colorspace.c](https://github.com/haasn/libplacebo/blob/4d82c6898551068d4ae6a6b5538efcddc2c7cf64/src/shaders/colorspace.c).

The initial implementation should preserve the PQ EOTF/OETF round trip so that
golden comparisons can use the same operation boundaries. After equivalence is
proven, the final PQ OETF and the existing next-stage PQ EOTF may be folded into
a direct linear-nits path.

## Profile 7 enhancement-layer path

Full Profile 7 support consists of four independent changes that landed after
mpv v0.41:

1. FFmpeg split NAL type 63 into a standalone enhancement-layer HEVC stream:
   [FFmpeg dovi_split commit](https://github.com/FFmpeg/FFmpeg/commit/6026988b753ebb1bd424612f40b17c0c363d8ed7)
2. mpv exposed the split stream through its demux path:
   [mpv dovi_split commit](https://github.com/mpv-player/mpv/commit/998c20af67cbf2c928e3e82f651a5408e597299e)
3. mpv created a second decoder and paired BL and EL frames:
   [mpv enhancement-pair commit](https://github.com/mpv-player/mpv/commit/5330cae57eba5d34719d2d6a13d98770e8841afc)
4. libplacebo mapped NLQ and composed the residual:
   [NLQ mapping commit](https://github.com/haasn/libplacebo/commit/6e66d6d5c9a2fdb6f4fa1d86454cc9582413beb7)
   and [FEL merge commit](https://github.com/haasn/libplacebo/commit/801b6812fb3fcadc7a44ab5f8585d3a1b5302a5f)

FFmpeg's splitter treats:

- NAL type 62 as the RPU;
- NAL type 63 as a wrapper around an enhancement-layer HEVC NAL;
- all other HEVC NAL units as base-layer data.

When extracting the EL, it removes the two-byte outer NAL header. It obtains the
EL decoder configuration from `hvcE` where available:
[FFmpeg dovi_split.c](https://github.com/FFmpeg/FFmpeg/blob/406c5a37aa666d648928a142d367483fe1acdd17/libavcodec/bsf/dovi_split.c).

mpv pairs BL and EL images by PTS with a `1e-6` second tolerance and bounds each
queue at 16 images. Missing, late, or undecodable EL results in BL-only output:
[mpv f_enhancement_pair.c](https://github.com/mpv-player/mpv/blob/1d15686142fd5d53c954aab7526cedab05ef9dc3/filters/f_enhancement_pair.c).

libplacebo upscales and aligns the EL before composition. Dolby metadata does
not signal layer siting, so libplacebo assumes the EL is left-sited based on its
sample analysis. Sampling failure produces BL-only output:
[libplacebo renderer.c](https://github.com/haasn/libplacebo/blob/4d82c6898551068d4ae6a6b5538efcddc2c7cf64/src/renderer.c#L1560-L1650).

Current mpv can use a second hardware decoder and a separate hardware-surface
mapper for the EL. This is hardware-assisted decode, not native Dolby Vision
passthrough:
[mpv vo_gpu_next.c](https://github.com/mpv-player/mpv/blob/1d15686142fd5d53c954aab7526cedab05ef9dc3/video/out/vo_gpu_next.c#L715-L745).

## mpv limitations that this project should preserve honestly

### No Dolby target-display trim algorithm

The libplacebo mapping consumes source minimum/maximum PQ and L1 maximum and
average PQ values. It does not apply Dolby L2 or L8 target-display artistic
trims. Other Dolby metadata levels may be present in the parsed structure, but
they are not part of this reconstruction path.

After reconstruction, mpv uses ordinary libplacebo color, gamut, and tone
mapping. This can produce excellent output, but it is not Dolby's licensed
Content Mapping Unit and must not be described as preserving every Dolby trim.

### No full Dolby Vision output metadata

mpv can output standard HDR or tone-map to a target. Its dynamic output mode
does not transmit a complete Dolby Vision metadata stream. mpv documents that
it instead produces HDR10 with per-scene luminance values:
[mpv target-colorspace documentation](https://github.com/mpv-player/mpv/blob/1d15686142fd5d53c954aab7526cedab05ef9dc3/DOCS/man/options.rst#L7333-L7355).

The WebGPU player should similarly describe its route as client-side Dolby
Vision reconstruction and tone mapping, not Dolby Vision display passthrough.

### Profile 7 constraints

- Only LINEAR_DZ NLQ is supported.
- EL layer siting is an empirical left-sited assumption.
- Full Profile 7 support is new in the upstream development branches.
- A failed EL decoder or upload reduces fidelity but need not interrupt the
  compatible base-layer session.

## Current repository state and blockers

Line references in this section describe the repository on the research date.
Symbols are the durable reference if later edits move the lines.

### Encoded-packet ownership checkpoint

Both HEVC playback routes now own Mediabunny `EncodedPacketSink` packets before
decode. `DolbyVisionEncodedMetadataQueue`:

- derives the HVCC length size or Annex B mode from the decoder configuration;
- removes NAL types 62 and 63 from the base-layer packet;
- owns bounded copies of RPU and enhancement-layer access-unit data;
- joins those copies to decoded frames by exact integer-microsecond PTS;
- rejects unmatched output, silent packet loss, and unbounded metadata windows.

Packed RPU snapshots and enhancement dispositions cross the worker boundary
with schema version 3 and explicit transfer ownership. Raw RPU bytes and the
bounded encoded enhancement access unit remain worker-local for the future
second decoder. Session telemetry counts DV frames, parsed RPUs, and
enhancement access units. The bundled HEVC path passes repeated playback and
natural-EOF browser smoke tests after this refactor. The native HEVC path uses
one directly owned `VideoDecoder`, preserves Chromium's first-access-unit
sanitization and leading RASL handling, bounds its decode and decoded-sample
queues, and passes a natural-EOF Chrome smoke test with 240 decoded and
presented frames.

This completes packet ownership, decode-order parsing, exact-PTS metadata
transfer, single-layer shader consumption, MEL reconstruction, and explicit
FEL HDR10-base fallback. A missing, duplicate, stale, or incompatible RPU or
enhancement disposition causes the Dolby Vision presentation route to fail
closed.

### Dolby Vision routes are separately modeled and authorized

[`PresentationInput.ts`](./src/plugins/webGPUVideoPlayer/PresentationInput.ts)
returns dedicated descriptors for 10-bit Profile 5, Profile 7 with its required
enhancement layer, and supported single-layer Profile 8 compatibility IDs.
Ordinary color metadata remains limited to `sdr`, `pq`, and `hlg`; Dolby Vision
is not misrepresented as one of those standard transfers.

[`CustomPlaybackEligibility.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomPlaybackEligibility.ts)
selects native `VideoFrame` output for Profile 5 only when its external-texture
authorization is active, and selects raw I420P10 output only when the exact raw
Dolby Vision route is authorized. [`CustomDeviceProfile.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomDeviceProfile.ts)
then exposes `DOVI`, `DOVIWithHDR10`, and `DOVIWithHLG` only on the applicable
single-layer HEVC routes. Separately authorized Profile 7 support exposes only
`DOVIWithEL` and remains bounded by the measured raw HEVC limits. It does not
advertise `DOVIWithELHDR10Plus` or let a single-layer authorization enable an
enhancement-layer route.

[`DolbyVisionPresentationAuthorization.ts`](./src/plugins/webGPUVideoPlayer/validation/DolbyVisionPresentationAuthorization.ts)
runs bounded exact-device shader fixtures and records authorization telemetry.
The Profile 7 route validates both MEL reconstruction and the explicit FEL
HDR10-base fallback in 18 readback samples. Authorization is scoped to the GPU
device, target format, and route and is repeated after device loss. No live
Profile 7 media fixture has yet completed the browser smoke harness, so this is
not evidence for container-level or decoder-level Profile 7 interoperability.
During a Chrome 151 Wolfwalkers Profile 5 regression smoke, the prewarmed
Profile 7 route authorized all 18 samples on the active `bgra8unorm` device with
a maximum channel error of approximately `0.00198`. The same run independently
authorized the nine-sample external Profile 5 route and completed playback,
pause, resume, seek, fullscreen, resize, and stop checks without fallback or
browser errors.

[`ExternalDolbyVisionPresentationAuthorization.ts`](./src/plugins/webGPUVideoPlayer/validation/ExternalDolbyVisionPresentationAuthorization.ts)
constructs a software-backed 16x8 limited-range BT.709 I420P10 `VideoFrame`,
imports it through `GPUExternalTexture`, executes the production Profile 5 RPU
shader and bindings, and reads back nine output samples. Its route signature
includes the fixture, frame tuple, shader, target format, settings schema, and
tolerance. It closes the frame and destroys all temporary GPU resources on
every exit path.

### Chromium external-texture precision boundary

The local Chromium 153 source confirms the current implementation boundary.
WebCodecs maps `I420P10` in
`third_party/blink/renderer/modules/webcodecs/video_frame.cc`, while
`third_party/blink/renderer/modules/webgpu/external_texture_helper.cc` limits
the zero-copy path to NV12 at line 279. Its one-copy path explicitly notes at
line 397 that high-bit-depth formats should use F16 but do not yet; other
formats use the canvas N32 target. The same helper applies the source visible
rectangle and natural display size before WGSL sampling.

Consequently, current Chromium can import a decoded I420P10 frame and preserve
the encoded signal closely enough for reconstruction, but it quantizes the
one-copy RGB intermediate to 8 bits. The external authorization tolerance is
therefore `8 / 255`; the observed Chrome 151 test route produced a maximum
final-channel error of about `0.02876`. This authorizes the measured browser
behavior, not a claim of full 10-bit preservation. The raw I420P10 route
remains the higher-precision path. Revisit this gate when Chromium adds the
F16 high-bit-depth copy path or broader multiplanar zero-copy support.

### The HEVC decode path now exposes parsed Dolby Vision data

[`CustomDecode.worker.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomDecode.worker.ts)
uses `EncodedPacketSink` for every HEVC route. The worker splits RPU NAL type 62
and enhancement-layer NAL type 63 before dispatching the cleaned base-layer
packet to either `OwnedNativeHEVCVideoDecoder` or the bundled software decoder.
RPU NAL units are parsed before base-layer decode, and the resulting immutable
snapshot remains associated with the owned decoded output by exact
integer-microsecond PTS. Native output transfers its `VideoFrame` directly;
bundled output transfers independently owned raw planes. Encoded enhancement
data remains separately owned inside the worker for the later FEL decoder.

The pinned Mediabunny 1.52.2 package exposes `EncodedPacketSink` at
`node_modules/mediabunny/src/media-sink.ts:147`. It yields packets in decode
order and is the integration point for player-owned decoding. The metadata
queue is decoder-agnostic, so both owned native and bundled HEVC routes use the
same parse, association, and transfer behavior.

### The frame protocol carries parsed Dolby Vision metadata

[`RawVideoFrameCopy.ts`](./src/plugins/webGPUVideoPlayer/custom/RawVideoFrameCopy.ts)
defines `TransferableRawVideoFrame` at lines 58-71. It carries raw planes,
geometry, standard `VideoColorSpace`, and timestamps. The surrounding worker
frame response now carries schema-versioned packed RPU reconstruction snapshots
and the parsed EL disposition with explicit transfer ownership. Compressed EL
buffers and raw RPU bytes never cross this boundary.

[`WebGPUPresenter.ts`](./src/plugins/webGPUVideoPlayer/WebGPUPresenter.ts)
defines `DecodedRawPresentationFrame` at lines 142-147 and requires standard
raw-frame color fields to equal `InputColorMetadata` in `rawFrameColorMatches`,
lines 289-310. WebCodecs cannot represent Profile 5 semantics through those
standard fields.

The WebCodecs `VideoColorSpace` interface exposes only primaries, transfer,
matrix, and full-range fields. It has no RPU or enhancement-layer side-data API:
[WebCodecs VideoColorSpace](https://www.w3.org/TR/webcodecs/#videocolorspace).

Profile 5 must therefore use an explicit Dolby Vision descriptor and validate
that `VideoFrame.copyTo()` preserves the decoded component code values. It must
not trust `VideoFrame.colorSpace` to describe the RPU representation.

### The shader reconstructs before the ordinary HDR pipeline

[`DolbyVisionColorTransform.ts`](./src/plugins/webGPUVideoPlayer/color/DolbyVisionColorTransform.ts)
implements the fixed-schema CPU reference and equivalent WGSL reconstruction.
[`ColorPipelineShader.ts`](./src/plugins/webGPUVideoPlayer/color/ColorPipelineShader.ts)
branches before the conventional YUV matrix for raw Dolby Vision, reconstructs
BT.2020/PQ, and then reuses the existing linear-nits, gamut mapping, tone map,
display controls, and dither stages.

### Container metadata is incomplete

The installed Mediabunny 1.52.2 source contains no parsing for Dolby Vision
`dvcC`, `dvvC`, or HEVC enhancement configuration `hvcE`.

Its Matroska parser reads basic `BlockAdditions` at
`node_modules/mediabunny/src/matroska/matroska-demuxer.ts:1551`, but only exposes
the retained ID 1 data as alpha side data when `AlphaMode` is enabled at lines
2235-2238. It does not expose Dolby Vision `BlockAdditionMapping` records.

FFmpeg's reference Matroska handling parses `dvcC`/`dvvC` and `hvcE`, storing
the latter as EL HEVC configuration:
[FFmpeg matroskadec.c](https://github.com/FFmpeg/FFmpeg/blob/406c5a37aa666d648928a142d367483fe1acdd17/libavformat/matroskadec.c#L2507-L2571).

Profile 5 and 8.x can begin with RPU NAL data in the main HEVC access units.
Profile 7 FEL cannot be considered complete until the container-specific EL
configuration is available.

## Browser and WebGPU constraints

### What WebCodecs can provide

WebCodecs can provide standard HEVC layer decoding when the browser supports
the configuration. This repository's bundled HEVC decoder can remain the
software alternative. The Dolby Vision layer must own the packet inspection
and RPU association independently of which HEVC backend is selected.

`EncodedVideoChunk.timestamp` and `VideoFrame.timestamp` are signed
microsecond media timestamps. The new code should preserve the repository rule
that all internal time values are signed integer microseconds.

### What WebCodecs cannot provide

WebCodecs does not expose:

- Dolby Vision RPU metadata;
- Profile or BL signal compatibility fields;
- an enhancement-layer image associated with a base `VideoFrame`;
- Dolby target-display trim processing.

An `HTMLVideoElement` can remain a whole-session fallback. It cannot be used as
a component elementary-stream decoder because the web platform does not expose
an encoded-packet-in, raw-layer-out API for HTML media elements.

### Why the raw-plane path is required

The custom shader must see the unprocessed decoded component values. An
external-texture presentation path may already have browser color conversion
between the decoded video and shader sampling. The current
`VideoFrame.copyTo()` raw-plane path is the appropriate basis, subject to a new
per-runtime Dolby Vision code-value validation fixture.

### Bounded resource behavior

Profile 7 FEL can require two decoders, two raw frame pools, and two GPU plane
sets. The implementation must retain:

- bounded decode credits;
- bounded BL and EL PTS maps;
- generation invalidation on seek, stop, source change, and fallback;
- exact `VideoFrame`, sample, and buffer ownership;
- direct BL continuation when the EL path fails.

## Staged implementation plan

### Stage 1: Dolby Vision data model and packet ownership

Add a separate structured Dolby Vision input model. At minimum it must carry:

- profile, level, and version;
- BL signal compatibility ID;
- BL, EL, and RPU presence flags;
- parsed layer mode: single-layer, MEL, or FEL;
- decoded raw format and bit depth;
- parser and schema versions.

Do not force Dolby Vision into `InputColorMetadata.transfer`. That structure
describes the standard image after reconstruction, not the encoded DV input.

The following HEVC packet steps apply to both native and bundled decoders:

1. Replace `VideoSampleSink` with `EncodedPacketSink` and a directly owned
   decoder.
2. Preserve the existing native-versus-bundled backend selection.
3. Read the HEVC length-field size from decoder configuration and support both
   length-prefixed HVCC samples and Annex B samples.
4. Extract NAL type 62 for RPU parsing.
5. Remove NAL types 62 and 63 from chunks sent to the BL decoder.
6. Parse RPUs in decode order and keep immutable snapshots indexed by PTS.
7. Join each output `VideoFrame.timestamp` to the corresponding snapshot.
8. Bound all pending metadata and decoder-output queues.

All eight steps are implemented for the base-layer decoder. Enhancement-layer
decode and pairing are separate Stage 4 work.

A small WASM wrapper over MIT-licensed libdovi is the preferred parser starting
point. Its C API exposes the RPU header, mapping data, and display-management
data:
[libdovi capi.rs](https://github.com/quietvoid/dovi_tool/blob/38adec045bf183c24df38149836c920398072281/dolby_vision/src/capi.rs).

The wrapper should return a fixed packed structure rather than exposing Rust
allocation or pointer ownership to TypeScript. Parser behavior must be compared
against pinned FFmpeg output.

Seek behavior must reset the decoder and RPU parser, locate the preceding
verified key packet, and process all packets from that point. A stale parser
snapshot must never attach to a later generation.

### Stage 2: Profile 5 and 8.x WebGPU reconstruction

Status: implemented for Profile 5 and supported single-layer Profile 8
descriptors, with exact-device authorization and fail-closed per-frame RPU
validation.

Extend the decoded raw presentation protocol with an immutable per-frame DV
snapshot containing:

- nonlinear 3x3 matrix and three offsets;
- linear 3x3 matrix;
- up to nine pivots per component;
- per-segment polynomial or MMR method and coefficients;
- source minimum and maximum PQ;
- L1 maximum and average PQ;
- NLQ state, even though single-layer routes leave it inactive.

Use a fixed-size uniform or storage buffer. Update it with `queue.writeBuffer`
for each selected frame. Do not compile shaders when metadata or user controls
change.

Implement the reconstruction order recorded above, then feed reconstructed
BT.2020/PQ into the existing color pipeline. Initially enable:

1. Profile 5 single-layer reconstruction.
2. Profile 8.1 reconstruction with verified HDR10 BL fallback.
3. Profile 8.4 reconstruction with verified HLG BL fallback.

Profile 5 runtime authorization must validate raw decoded code values, parser
output, shader output, and the exact decoder backend as one route.

### Stage 3: Profile 7 MEL

Status: implemented through raw I420P10 base-layer reconstruction, exact-device
authorization, and separate `DOVIWithEL` capability gating. Live Profile 7
media validation remains pending.

The parser determines whether Profile 7 NLQ is trivial. For verified MEL:

- apply RPU reshape to the base image;
- skip the second decoder when the NLQ residual is trivial;
- retain HDR10 BL fallback if parsing or rendering fails.

Do not infer MEL only from Jellyfin's `ElPresentFlag`. Classification must use
the parsed NLQ values.

### Stage 4: Profile 7 FEL

Status: FEL is classified from active NLQ and uses an explicit HDR10-compatible
base-layer fallback. Compressed EL packets are worker-local and owned, but a
second decoder and residual composition are not implemented. Full FEL fidelity
therefore remains pending.

1. Extend container parsing for `dvcC`, `dvvC`, and `hvcE`.
2. Split NAL type 63 and remove its two-byte outer header.
3. Configure a second HEVC decoder with the EL configuration.
4. Pair BL and EL outputs by exact integer-microsecond PTS.
5. Use a maximum pending window of 16 frames, matching mpv's current design.
6. Upload the EL planes and left-site/upscale them to the BL grid.
7. Apply LINEAR_DZ residual composition before the nonlinear RPU matrix.
8. On EL decode, map, upload, or sample failure, release EL resources and
   continue BL-only without renegotiating or restarting playback.

If later evidence contradicts the left-siting assumption for a fixture, reject
that route rather than silently presenting a misaligned residual.

### Stage 5: Capability advertisement and rollout

Dolby Vision route keys must include enough state to prevent one successful
configuration from authorizing another. At minimum include:

```text
profile
BL signal compatibility ID
single-layer, MEL, or FEL mode
container configuration mode
video decoder backend
raw frame format
RPU parser version
shader signature
render settings version
GPU target format
```

Only after a route passes runtime validation may `CustomDeviceProfile` advertise
the corresponding `DOVI` range and constraints to Jellyfin.

Fallback policy:

- Profile 8.1: discard DV processing and render the HDR10 base.
- Profile 8.4: discard DV processing and render the HLG base.
- Profile 7: discard failed EL processing and render the HDR10 base; report FEL
  loss in telemetry.
- Profile 5: use only a separately qualified native HTML Dolby Vision route or
  server transcode. Never use generic PQ interpretation.

## Validation plan

### Parser conformance

Use libdovi's test RPUs:
[dovi_tool test assets](https://github.com/quietvoid/dovi_tool/tree/38adec045bf183c24df38149836c920398072281/assets/tests).

Required cases include:

- `profile5.bin` and `profile5-02.bin`;
- `profile8.bin`;
- `profile84.bin`;
- `mel_rpu.bin` and variable-length MEL metadata;
- `fel_rpu.bin`;
- RPU reuse, conversion, CRC, trailing-byte, and malformed cases.

Compare the packed WASM parser result field by field with FFmpeg
`AVDOVIMetadata` produced by the pinned FFmpeg revision.

### Demux and splitter conformance

Use the relevant FFmpeg FATE references:
[FFmpeg FATE references](https://github.com/FFmpeg/FFmpeg/tree/406c5a37aa666d648928a142d367483fe1acdd17/tests/ref/fate).

Required reference groups:

- `dovi_meta`;
- `hevc-bsf-dovi-split-bl`;
- `hevc-bsf-dovi-split-bl-rpu`;
- `hevc-bsf-dovi-split-el`;
- `hevc-bsf-dovi-split-el-rpu`;
- Matroska `hvcE` read/write cases;
- MP4 and Matroska Dolby Vision configuration cases.

Tests must verify both the bytes passed to each decoder and the RPU associated
with each presentation timestamp.

### Shader golden tests

The CPU reconstruction test parses the checked-in `profile84.bin` fixture and
compares six input triplets against `pl_shader_decode_color_ex` output from
libplacebo revision `4d82c6898551068d4ae6a6b5538efcddc2c7cf64`. The reference
was rendered into a Vulkan float target with 10-bit input representation. The
maximum absolute component error is `1e-5`, which covers the expected
JavaScript double-versus-GPU float evaluation difference without hiding a
10-bit code-value error.

Continue generating golden frames with the pinned mpv, FFmpeg, and libplacebo
revisions. Compare at these boundaries:

1. normalized BL components;
2. RPU reshape output;
3. FEL residual-composed output;
4. reconstructed BT.2020/PQ;
5. final linear RGB and tone-mapped output.

Define explicit numerical tolerances after 10-bit input quantization. A final
8-bit canvas comparison alone is insufficient because several incorrect
intermediate transforms can collapse to similar clipped output.

For FEL, verify that:

- the composed image differs measurably from BL-only output;
- the composed image matches the pinned reference;
- delayed or failed EL produces the expected BL-only frame without queue
  growth.

### Playback fixtures

The minimum playback matrix is:

1. Profile 5 single-layer with RPU reshape.
2. Profile 8.1 with both DV reconstruction and HDR10 fallback.
3. Profile 8.4 with both DV reconstruction and HLG fallback.
4. Profile 7 MEL.
5. Profile 7 FEL with interleaved NAL type 63.
6. Profile 7 with missing or malformed EL configuration.
7. Missing, malformed, reused, and scene-refresh RPU data.
8. B-frames and duplicate-nearby timestamps.
9. Seek to multiple random-access points.
10. Rapid seek, stop, source replacement, and next-item generation changes.

Dolby's official browser test kit can provide licensed Profile 5 and 8.4
coverage:
[Dolby browser test-kit resources](https://ott.dolby.com/browser_test_kit/help_files/topics/r_resources.html).

Profile 7 fixtures must have documented provenance and redistribution terms.

### Fallback tests

Explicitly inject:

- RPU parser initialization failure;
- malformed per-frame RPU;
- BL decoder failure;
- EL decoder creation and decode failure;
- BL/EL PTS mismatch and delayed EL;
- raw `VideoFrame.copyTo()` failure;
- GPU buffer creation and upload failure;
- shader pipeline creation failure;
- device loss during Profile 5 and Profile 7 playback.

Expected results:

- Profile 8 and Profile 7 continue through their compatible base layers.
- Profile 5 leaves the custom presentation path and is never presented with a
  generic HDR matrix.
- Every discarded BL or EL `VideoFrame` is closed exactly once.
- Metadata, frame, and buffer queues remain bounded.
- No fallback restarts or renegotiates an already-compatible BL session.

## Pinned upstream reference revisions

These revisions define the reference behavior for this record. Moving the
golden baseline requires an explicit review of upstream Dolby Vision changes.

| Project | Revision | Role |
| --- | --- | --- |
| mpv stable | `v0.41.0` | Stable Profile 5/8 and Profile 7 BL behavior |
| mpv master | `1d15686142fd5d53c954aab7526cedab05ef9dc3` | Profile 7 split, pairing, and rendering integration |
| libplacebo | `4d82c6898551068d4ae6a6b5538efcddc2c7cf64` | RPU reshape, NLQ composition, and color mapping |
| FFmpeg | `406c5a37aa666d648928a142d367483fe1acdd17` | RPU parser, metadata structures, container parsing, and NAL splitter |
| dovi_tool/libdovi | `38adec045bf183c24df38149836c920398072281` | Independent RPU parser and conformance assets |

Relevant feature commits are listed in the Profile 7 section and should remain
part of any implementation review even if the pinned branches advance.

## Licensing and intellectual-property boundary

Copyright licenses and Dolby intellectual-property rights are separate issues.

- libdovi is MIT licensed:
  [dovi_tool LICENSE](https://github.com/quietvoid/dovi_tool/blob/38adec045bf183c24df38149836c920398072281/LICENSE)
- The referenced FFmpeg, mpv, and libplacebo source files are licensed under
  LGPL-2.1-or-later in their file headers.
- This repository declares GPL-2.0-or-later.
- Copying or translating upstream implementation code still requires license
  compliance, notices, and preservation of relevant copyright attribution.
- Open-source copyright licenses do not grant Dolby patent rights, Dolby
  certification, or permission to use Dolby trademarks as a certification
  claim.

libplacebo deliberately has a build-time Dolby Vision switch because some
integrators may need it disabled for IP reasons:
[libplacebo PL_HAVE_DOVI commit](https://github.com/haasn/libplacebo/commit/3bdfb692ec4ba732f6791b1330bf96df7a1c99fb).

Until legal review is complete:

1. keep custom Dolby Vision reconstruction behind a separate feature flag;
2. keep distribution builds disabled by default;
3. do not describe the output as Dolby-certified;
4. preserve third-party notices for libdovi and any translated libplacebo or
   FFmpeg algorithms;
5. retain standard HDR10/HLG and server-transcode fallbacks.

This caveat is not a conclusion that implementation or distribution is
prohibited. It records that the open-source licenses alone do not answer the
patent, trademark, or certification questions.
