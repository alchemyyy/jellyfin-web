# WebGPU Dolby Vision Implementation Record

Status: research complete, bounded packet-splitting implementation started

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

### Dolby Vision is deliberately rejected

[`PresentationInput.ts`](./src/plugins/webGPUVideoPlayer/PresentationInput.ts)
currently detects Dolby Vision but does not model it:

- `resolveTransfer`, lines 196-228, rejects a Dolby Vision transfer.
- `hasDolbyVisionMetadata`, lines 252-262, detects all Jellyfin DV fields and
  flags.
- `parseVideoStreamColorMetadata`, lines 268-319, returns `null` for any Dolby
  Vision stream.

This is correct until the RPU path exists. Removing the rejection alone would
make Profile 5 render incorrectly.

[`ColorMetadata.ts`](./src/plugins/webGPUVideoPlayer/color/ColorMetadata.ts)
defines only `sdr`, `pq`, and `hlg`. Dolby Vision requires a separate structured
input model rather than another transfer-string value.

[`CustomPlaybackEligibility.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomPlaybackEligibility.ts)
uses `getPresentationInputColorMetadata` in `selectVideoOutput`, lines 587-660.
The current Dolby Vision rejection becomes `metadata-unsupported`.

[`CustomDeviceProfile.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomDeviceProfile.ts)
maps authorized raw HDR routes only to `HLG` and `HDR10` in
`getAuthorizedRawHDRVideoRangeTypes`, lines 116-134.

[`RawHDRPresentationAuthorization.ts`](./src/plugins/webGPUVideoPlayer/validation/RawHDRPresentationAuthorization.ts)
defines only these raw routes at lines 53-60:

```text
I420P10:bt2020-ncl:bt2020:limited:pq
I420P10:bt2020-ncl:bt2020:limited:hlg
```

No `DOVI` range should be added to the Jellyfin device profile until the exact
profile, container, decoder, parser, and shader route passes validation.

### The current decode abstraction hides the RPU

[`CustomDecode.worker.ts`](./src/plugins/webGPUVideoPlayer/custom/CustomDecode.worker.ts)
uses Mediabunny's `VideoSampleSink` in `streamVideoFrames`, lines 620-666.
Mediabunny owns demux and `VideoDecoder`; the worker sees a decoded
`VideoSample`, not the encoded HEVC access unit. RPU NAL type 62 and EL NAL type
63 are therefore unavailable when `takeVideoFrame` runs.

The pinned Mediabunny 1.52.2 package exposes `EncodedPacketSink` at
`node_modules/mediabunny/src/media-sink.ts:147`. It yields packets in decode
order and is the required integration point for a player-owned `VideoDecoder`.

The HEVC route must be refactored to:

1. retrieve encoded packets;
2. inspect and split their NAL units;
3. parse and snapshot RPU state;
4. feed cleaned BL chunks to the selected native or bundled HEVC decoder;
5. join decoder output to RPU snapshots by integer-microsecond PTS.

### The frame protocol has no Dolby Vision metadata

[`RawVideoFrameCopy.ts`](./src/plugins/webGPUVideoPlayer/custom/RawVideoFrameCopy.ts)
defines `TransferableRawVideoFrame` at lines 58-71. It carries raw planes,
geometry, standard `VideoColorSpace`, and timestamps, but no RPU state or EL.

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

### The current shader starts with a conventional YUV matrix

[`ColorPipelineShader.ts`](./src/plugins/webGPUVideoPlayer/color/ColorPipelineShader.ts)
generates conventional range normalization and BT.709/BT.2020 YUV-to-RGB
matrices in `createRawYUVRangeWGSL` and `createRawYUVMatrixWGSL`, around lines
268-313. Dolby Vision reconstruction must branch before that conventional
matrix and consume the per-frame RPU reshape and matrices instead.

The existing raw-frame upload, standard PQ EOTF, linear-nits working space,
gamut conversion, tone map, display controls, and dither stages remain useful
after Dolby Vision has been reconstructed to BT.2020/PQ.

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

For HEVC Dolby Vision routes:

1. Replace `VideoSampleSink` with `EncodedPacketSink` and a player-owned
   `VideoDecoder`.
2. Preserve the existing native-versus-bundled backend selection.
3. Read the HEVC length-field size from decoder configuration and support both
   length-prefixed HVCC samples and Annex B samples.
4. Extract NAL type 62 for RPU parsing.
5. Remove NAL types 62 and 63 from chunks sent to the BL decoder.
6. Parse RPUs in decode order and keep immutable snapshots indexed by PTS.
7. Join each output `VideoFrame.timestamp` to the corresponding snapshot.
8. Bound all pending metadata and decoder-output queues.

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

Parse Profile 7 RPU and determine whether NLQ is trivial. For verified MEL:

- apply RPU reshape to the base image;
- skip the second decoder when the NLQ residual is trivial;
- retain HDR10 BL fallback if parsing or rendering fails.

Do not infer MEL only from Jellyfin's `ElPresentFlag`. Classification must use
the parsed NLQ values.

### Stage 4: Profile 7 FEL

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

Generate golden frames with the pinned mpv, FFmpeg, and libplacebo revisions.
Compare at these boundaries:

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
