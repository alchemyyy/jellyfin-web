# WebGPU Player Plan 2

- Status: active implementation plan
- Recorded: 2026-08-02
- Branch: `webgpu-player`
- Committed baseline: `5550eba1b186dc5dd2c2154cf2017d6fe7dae597`
- Current state: the baseline is pushed; the native HEVC Main10 external-texture
  HDR route is implemented, built into the Jellyfin-served frontend, and
  live-qualified for generated PQ and HLG lifecycle fixtures in the worktree.
  Final local command gates pass and the evidence is recorded below.

## 1. Product target

Build a Jellyfin web player that minimizes server transcoding by owning the
client playback pipeline:

```text
Jellyfin source selection
  -> HTTP byte-range input
  -> Mediabunny demux
  -> native WebCodecs or a measured bundled decoder
  -> owned video frames and decoded/native-media audio
  -> WebGPU color reconstruction, gamut mapping, and tone mapping
  -> Jellyfin OSD and DOM subtitle surfaces
```

The finished player must:

1. Direct-play every codec/profile/container combination that has a complete,
   measured, legally distributable client route.
2. Advertise only capabilities proven on the current browser, GPU, output
   format, decoder backend, resolution, frame rate, audio layout, and route.
3. Reconstruct HDR10, HLG, and supported Dolby Vision profiles before applying
   configurable WebGPU tone and gamut mapping.
4. Preserve the existing HTML player as a permanent whole-session fallback.
5. Fall back without recursion, duplicate reporting, stale callbacks, or an
   unbounded resource queue.
6. Keep all internal media time in signed integer microseconds.
7. Ship with reproducible capability, conformance, integration, performance,
   fault-injection, and soak validation.

This is not yet a finished product. It is an advanced, working prototype with
substantial codec, HDR, audio, lifecycle, and validation infrastructure. Local
manual playback has looked excellent, but several observed library sessions
still used server HLS transcoding. Visual quality alone therefore does not prove
that a source used the owned custom decode route.

## 2. Current architecture and status

### 2.1 Implemented and committed

- Disabled-by-default priority-0 WebGPU player wrapper.
- Owned HTML player backend and permanent direct-video fallback.
- Complete player-contract delegation and stable event identity.
- Generation invalidation for play, seek, stop, source replacement, fallback,
  and GPU recovery.
- `requestVideoFrameCallback()` presentation for HTML-decoded video.
- Owned custom VOD input through HTTP byte ranges and Mediabunny demux.
- Native WebCodecs video and audio decode with exact decoded-output probes.
- Bundled `@hevcjs/core` HEVC Main/Main10 software decode with content-addressed
  worker assets and measured tiers.
- Raw I420/I420P10 GPU upload and WebGPU presentation.
- Fixed-stereo 48 kHz AudioWorklet output, 5.1-to-stereo downmix, bounded audio
  queues, underflow recovery, and A/V clock telemetry.
- Owned native-media MSE bridge for exactly qualified AC-3/E-AC-3 routes.
- Build-gated local AC-3/E-AC-3 software decoder integration.
- SDR identity, BT.2020 PQ, and BT.2020 HLG color paths.
- Exact-device raw HDR authorization and separate Dolby Vision route
  authorizations.
- Dolby Vision Profile 5 and 8 reconstruction, Profile 7 MEL reconstruction,
  and Profile 7 FEL residual paths for implemented interleaved and dual-layer
  container topologies.
- Runtime-qualified native Ultra HD video, native surround audio, raw HDR frame
  rates, and native Dolby Vision HEVC frame rates.
- Browser smoke, worker smoke, color readback, startup comparison, failure
  injection, artifact verification, and retention/soak tooling.
- Documentation of the unresolved intermittent Mediabunny `VideoSample`
  ownership warning.

### 2.2 Implemented in the current worktree, not checkpointed

- A distinct native HEVC Main10 HDR throughput capability.
- HEVC SPS/HVCC color-description neutralization for an owned native decoder.
- A production `GPUExternalTexture` HDR shader that reconstructs limited-range
  10-bit YUV after the deliberately neutral BT.709 browser conversion.
- Exact PQ and HLG external-HDR authorization fixtures.
- Per-device, target-format, transfer, and route-key authorization caching.
- Eligibility, device-profile, worker protocol, controller, player, and
  presenter integration for that route.
- Focused unit suites and TypeScript checking have passed once for this work.

The incomplete checkpoint work still needs lint, a development build, artifact
verification, deployment through Jellyfin on port 8096, exact browser
authorization evidence, DirectPlay negotiation evidence, visual comparison,
lifecycle/failure validation, and a final clean test pass.

### 2.3 Last observed local evidence

The latest recorded measurements on the development machine are useful for
planning but are not portable capability claims:

- Native 4K HEVC Main10 decode measured about 75.9 fps and qualified the 60 fps
  tier.
- Bundled 4K HEVC Main10 measured about 28.75 fps and correctly failed the 30
  fps qualification floor.
- Bundled 1080p Main10 measured about 120 fps and had sufficient 60 fps
  headroom.
- Manual playback quality was reported as excellent.
- Earlier Wolfwalkers PlaybackInfo screenshots still showed HLS transcoding,
  so those screenshots validate presentation quality, not owned DirectPlay.
- The uncommitted native external-HDR route has not yet been installed into the
  authoritative port-8096 frontend. Dark Knight Main10/FLAC DirectPlay remains
  the immediate live negotiation test.

### 2.4 Global restrictions

These restrictions apply even where a codec row below says "implemented":

- Custom decode is VOD-only. Live and infinite streams remain unsupported.
- The source must be HTTP(S), byte-range addressable, and directly accessible.
- DRM/encrypted media is unsupported by the custom pipeline.
- Chrome's internal codec implementations cannot be imported as libraries. A
  codec is usable through WebCodecs only when the browser exposes it. Otherwise
  use a bundled decoder or fall back the whole session to an HTML media element;
  do not attempt an unsynchronized per-track HTML decode side channel. The owned
  AC-3/E-AC-3 MSE audio backend is a deliberately bounded and qualified special
  route, not a generic decoder escape hatch.
- A listed native codec is used only after exact output and, where applicable,
  throughput probes succeed. `isConfigSupported()` alone is insufficient.
- HDR is used only after the exact production presentation route passes GPU
  readback authorization on the active device and canvas format.
- The fixed PCM output is stereo 48 kHz. Other sample rates and arbitrary
  layouts are rejected rather than silently misrepresented.
- Playback rate other than 1.0 is rejected while custom decoded audio is active.
- PiP, AirPlay, Remote Playback, DRM, and SyncPlay rate control are not claimed
  for custom decode.
- Subtitles remain on Jellyfin's existing DOM/HTML surface. Custom-decode
  subtitle selection and timing still require full end-to-end qualification.
- The source and all selected tracks must satisfy one implemented container rule.
- Feature flags remain disabled in source `src/config.json`.

### 2.5 Known `VideoSample` ownership defect

Repeated paused-device-loss runs with bundled HEVC can intermittently emit
Mediabunny's warning that a `VideoSample` reached finalization without an
explicit close. The adapter, worker, iterator-retirement, and decoder-shutdown
paths already attempt exact close/acknowledgement, and temporary counters have
balanced in clean runs. One unproven candidate is a range-filter seek-preroll
sample that predates the requested start after another sample is queued.

The defect remains open. Keep the console assertion and ownership telemetry,
reduce it to a deterministic case, inspect retained objects and upstream
Mediabunny behavior, and fix the ownership boundary. Do not suppress the warning
or claim a leak-free long soak until both finalizer and memory evidence pass.
Group H owns the investigation so codec and lifecycle work do not duplicate it.

### 2.6 Mediabunny-first decoder and container policy

Mediabunny core and official Mediabunny decoder extensions are approved project
dependencies. Their licensing review is complete. Use them by default whenever
they provide the required container, decoder, sample format, and lifecycle:

1. Use Mediabunny for every supported container/input instead of duplicating its
   demux, range, packet, track, timestamp, and seek implementation.
2. Use Mediabunny's ordinary sample sinks for native WebCodecs decode when their
   output and ownership contract satisfies the route.
3. Prefer an official Mediabunny custom decoder extension over a project-local
   decoder adapter. Promote `@mediabunny/ac3` to ordinary builds and use
   `@mediabunny/prores` for future ProRes support.
4. Use Mediabunny's built-in PCM decoders for its supported integer, float,
   mu-law, and A-law variants; add only the player-side resample/layout stage.
5. Keep exact output, profile, throughput, presentation, lifecycle, and resource
   probes. Library availability alone still does not authorize a Jellyfin route.
6. Retain owned packet/decode code only where Dolby Vision RPU/EL processing,
   HEVC parameter-set rewriting, raw-plane guarantees, exact device behavior, or
   a codec absent from Mediabunny requires it.

This policy replaces any backlog wording that implies reimplementing a
Mediabunny-supported demuxer or decoder. Integrate and qualify first; write new
codec/container code only for a demonstrated gap.

## 3. Capability terminology

| Term | Meaning |
| --- | --- |
| Implemented | A complete code route exists, including decode, ownership, presentation, and fallback. |
| Runtime-qualified | The current browser/device passed the exact output, dimensions, profile, throughput, layout, and/or GPU readback probes required by that route. |
| Partial | Useful support exists, but profiles, layouts, containers, deployment, or end-to-end evidence remain incomplete. |
| Not implemented | The codec is not in the custom capability model and must not be advertised. |
| Build-gated | Code exists but ordinary distributable builds intentionally exclude it. |

No table entry is a static promise that every Chrome or Edge installation can
decode that codec. The server profile is widened only from measured evidence.

## 4. Current video codec support

### 4.1 Implemented video routes

| Codec/profile | Decode and presentation route | Current qualified envelope | Status and remaining limits |
| --- | --- | --- | --- |
| H.264/AVC Constrained Baseline, Baseline, Main, High, 8-bit 4:2:0 | Exact-profile native WebCodecs decode -> owned `VideoFrame` -> WebGPU | Each profile is independently output-probed at 1920x1080. | Implemented and runtime-gated. No 4K tier, High 10, 4:2:2, 4:4:4, interlaced-output, or unusual profile claim. |
| HEVC Main, 8-bit 4:2:0 SDR | Native WebCodecs, or exact-tier `@hevcjs/core` fallback -> `VideoFrame` -> WebGPU | Native 1080p plus a separate exact 3840x2160 tier. Bundled Main tier is 1920x1080, Level 120, up to 12 Mbps, and must pass its throughput/fingerprint probe. | Implemented and runtime-gated. Bundled distribution still requires HEVC patent/jurisdiction review. |
| HEVC Main10, 10-bit 4:2:0 PQ/HLG | Native `VideoFrame.copyTo()` or bundled decoder -> I420P10 -> raw YUV WebGPU HDR pipeline | Raw capability is probed at 3840x2160 and assigned only a measured 24/30/60 fps tier with 1.25x headroom. Bundled tiers are 1080p Level 120/12 Mbps and 4K Level 153/40 Mbps. | Implemented and runtime-gated. A slow bundled 4K decoder is correctly rejected. |
| HEVC Main10, 10-bit 4:2:0 PQ/HLG through `GPUExternalTexture` | Owned native decoder with SPS/HVCC color neutralization -> external texture -> code-value recovery shader -> HDR pipeline | 3840x2160, Level 153, up to 40 Mbps, and a measured 24/30/60 fps tier. Exact PQ or HLG fixture authorization is scoped to device, target format, and route. | Implemented, live-qualified on generated PQ and HLG lifecycle fixtures, and through final local checkpoint verification. |
| Dolby Vision Profile 5 | HEVC BL decode + libdovi RPU parse/reconstruction; raw-plane route and an independently authorized native external-texture route | Up to the exact measured native/bundled HEVC and presentation limits. Every selected frame requires matching RPU metadata. | Implemented, fail-closed, and route-authorized. Broader real-title/browser/GPU validation remains. No Dolby certification or passthrough is claimed. |
| Dolby Vision Profile 7 MEL | HEVC base-layer decode + RPU reconstruction on the HDR10-compatible BL | Raw I420P10 route with exact device authorization. | Implemented. Must expand end-to-end disc/container and fallback coverage. |
| Dolby Vision Profile 7 FEL | BL and EL decode, exact-PTS pairing, LINEAR_DZ residual composition, then WebGPU tone mapping | Implemented for qualified interleaved EL, Matroska `hvcE`/separate-track, legacy dual-track ISO BMFF, and separate-PID MPEG-TS/M2TS discovery routes. | Partial product qualification. Dual-decoder performance, BDMV demux behavior, malformed topologies, real-title coverage, and sustained ownership/soak evidence remain. |
| Dolby Vision Profile 8.x | HEVC BL decode + RPU reconstruction; verified HDR10 or HLG-compatible base fallback where applicable | Raw I420P10 route under the applicable exact authorization. | Implemented for supported single-layer descriptors. Expand the Profile 8.1/8.4 and malformed-metadata matrix before release. |
| VP8, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact output at up to the ordinary 1920x1080 envelope. | Implemented and runtime-gated. No Ultra HD or higher-bit-depth route. |
| VP9 Profile 0, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact 1080p output plus independent 3840x2160 output qualification. | Implemented and runtime-gated. |
| VP9 Profile 2, 10-bit 4:2:0 PQ/HLG | Native WebCodecs -> exact `copyTo()` fingerprint -> I420P10 WebGPU | Exact 3840x2160 raw-output probe and measured 24/30/60 fps tier. | Implemented and runtime-gated. Profiles 1/3 and 12-bit are not supported. |
| AV1 Main, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact 1080p output plus independent 3840x2160 output qualification. | Implemented and runtime-gated. |
| AV1 Main, 10-bit 4:2:0 PQ/HLG | Native WebCodecs -> exact `copyTo()` fingerprint -> I420P10 WebGPU | Exact 3840x2160 raw-output probe and measured 24/30/60 fps tier. | Implemented and runtime-gated. High/Professional, 12-bit, 4:2:2, and 4:4:4 are not supported. |

### 4.2 Unsupported video codecs and implementation procedures

Priority indicates implementation order, not a claim that every niche format is
required for the first release.

| Unsupported codec/profile | Priority | Procedure |
| --- | --- | --- |
| MPEG-2 Video | P0 legacy library coverage | First test future native WebCodecs with an exact decoded-output fixture. If unavailable, integrate a legally reviewed WASM decoder behind the common adapter. Add MPEG-TS and, if demux support is added, MPEG-PS packet/extradata mapping. Implement field order and an explicit deinterlace stage before advertising interlaced sources. Add Main Profile fixtures at SD/720p/1080i, cadence and seek tests, throughput tiers, and device-profile limits. |
| MPEG-4 Part 2, including DivX/Xvid | P0 legacy library coverage | Add a bundled decoder adapter unless exact native output becomes available. Validate VOL/extradata, packed B-frames, decode-vs-presentation timestamp reordering, quarter-pixel/global-motion variants, and MP4/MKV carriage. Add AVI only after the demux layer has a bounded, tested AVI path. Qualify profile, resolution, bitrate, and throughput before profile widening. |
| VC-1 and WMV3 | P0 legacy disc/library coverage | Select and license-review a WASM decoder, add VC-1 sequence-header mapping for MKV and MPEG-TS/M2TS, then add ASF only through a separate demux task. Implement interlace/field handling, B-frame timestamp tests, 8-bit I420 output, exact fingerprints, and hardware/reference comparisons. Never infer support from the HTML media element. |
| H.264 High 10, High 4:2:2, High 4:4:4 | P1 advanced AVC | Add exact WebCodecs probes per profile/chroma/bit depth. If Chrome does not expose output, add a bundled decoder. Extend the raw-frame protocol, buffer pool, and shader from I420/I420P10 to required 10-bit 4:2:2 and 4:4:4 plane formats. Add chroma siting, range/matrix, crop, and throughput fixtures before advertising any profile. |
| HEVC Main12, Main 4:2:2 10/12, Main 4:4:4 8/10/12 | P1 advanced HEVC | Extend or replace the bundled HEVC backend only after decoder and patent review. Add I420P12 plus explicit 4:2:2/4:4:4 raw formats, row-stride validation, texture upload formats, chroma reconstruction shaders, exact output fingerprints, and per-profile tier probes. Add native probes independently; do not let Main10 evidence authorize these formats. |
| VP9 Profiles 1 and 3, 12-bit output | P1 advanced VP9 | Add exact profile codec strings and fixtures, then implement 4:2:2/4:4:4 and 12-bit raw plane formats. Require `copyTo()` fingerprints and GPU readback authorization for each distinct raw format. If raw values are inaccessible, keep the route unsupported unless an external-texture preservation test can prove exact reconstruction. |
| AV1 High/Professional, 12-bit, 4:2:2, 4:4:4 | P1 advanced AV1 | Follow the VP9 procedure with exact AV1 sequence-header/profile fixtures. Add raw formats and shader sampling once for all codecs, then bind AV1 to that shared implementation. Qualify film-grain behavior, crop, high-resolution memory pressure, and throughput. |
| Motion JPEG and JPEG 2000 video | P1 cameras/archives | Add exact native probes first. Otherwise adapt a JPEG/JPEG 2000 decoder to the common frame contract. Implement full/limited range and common YUV/RGB sampling, orientation/crop, high-resolution intraframe throughput, and bounded allocation tests. `MJ2` being an accepted container token does not currently mean MJPEG/JPEG 2000 video is supported. |
| Theora | P1 open legacy media | Add Ogg demux/track mapping if Mediabunny cannot already supply exact packets, then add a reviewed software decoder adapter. Produce I420 frames, validate granule-position timestamp/seek behavior, add Ogg fixtures, and gate profile widening on output fingerprints and throughput. |
| ProRes | P1 professional media | Integrate the official `@mediabunny/prores` decoder through Mediabunny's ordinary sample path. Add 10/12-bit 4:2:2/4:4:4 and alpha-capable raw formats only where its returned sample formats require them, plus a high-bandwidth upload path. Validate cross-origin-isolation and fallback performance, color metadata, clean aperture, rotation, alpha policy, memory ceilings, and sustained 4K throughput. |
| DNxHD/DNxHR | P1 professional media | Reuse the ProRes raw-format/upload work. Add codec-specific extradata, profile/bit-depth mapping, MOV/MXF/MKV demux support as available, deterministic reference frames, and resolution/bitrate/memory tiers. |
| VVC/H.266 | P2 emerging | Prefer a future exact native WebCodecs route. Otherwise select a SIMD/threaded WASM decoder only after license/patent review. Add VVC configuration-record and Annex B transforms, 10/12-bit and chroma formats, conformance streams, capability timeouts, and realistic 4K throughput gates. |
| AVS, AVS2, AVS3 | P2 regional/emerging | Add demux identifiers and extradata parsing, a reviewed decoder backend, exact profile/level fixtures, raw-format support, and measured tiers. Keep each generation independent because their bitstreams and licensing differ. |
| MPEG-1 Video, VP6, RealVideo | P2 long-tail legacy | Implement only from measured library demand. Each requires demux support, a reviewed software decoder, timestamp/seek conformance, exact output fingerprints, a bounded tier, and negative malformed-stream tests. Do not enlarge the central capability model until a complete route exists. |

### 4.3 Shared video-codec implementation procedure

Every new video codec must follow this sequence. Codec-specific work above is a
delta on this procedure, not a separate architecture.

1. **Demand and dependency gate**
   - Record expected library coverage and release priority.
   - Prefer an official Mediabunny decoder extension. Mediabunny dependencies
     are approved; record separate licensing only for non-Mediabunny backends.
2. **Container and packet gate**
   - Confirm Mediabunny exposes encoded packets, codec private data, timestamps,
     keyframe status, crop, color metadata, and duration.
   - Add one bounded packet transform for Annex B/config-record or codec-private
     conversion. Do not parse packets with ad hoc string operations.
3. **Decoder adapter gate**
   - Prefer Mediabunny's exact native WebCodecs sample path when exposed.
   - Next prefer an official Mediabunny custom decoder extension.
   - Otherwise implement one concrete owned decoder adapter in the worker.
   - Define flush, reset, destroy, error, timestamp, and frame ownership
     behavior. Close all rejected/stale frames and samples.
4. **Raw format gate**
   - Reuse existing I420/I420P10 where correct.
   - Add structured formats for new bit depth/chroma/alpha combinations once,
     with validated strides, pool sizes, transfer ownership, and GPU upload.
5. **Capability gate**
   - Add deterministic encoded fixtures and expected decoded fingerprints.
   - Probe exact profile, bit depth, chroma, dimensions, and output format.
   - Measure representative multi-frame throughput with at least 1.25x
     presentation-rate headroom and assign explicit resolution/fps tiers.
6. **Presentation gate**
   - Prove SDR identity or exact HDR code-value preservation through the
     production shader and GPU readback path.
   - Add color range, matrix, primaries, transfer, crop, and chroma-siting cases.
7. **Eligibility and negotiation gate**
   - Add aliases and legal container combinations.
   - Add exact stream constraints to custom eligibility and the Jellyfin device
     profile only after all prior gates pass.
8. **Validation gate**
   - Add unit, worker integration, live DirectPlay, seek, stream-switch,
     malformed-input, fallback, device-loss, startup, and soak cases to the
     shared validation manifest.
9. **Packaging gate**
   - Content-address worker/runtime assets, verify exact package bytes and
     licenses, test disabled-build absence, and keep source feature flags off.

## 5. Current audio codec support

### 5.1 Implemented audio routes

| Codec | Decode/output route | Current qualified envelope | Status and remaining limits |
| --- | --- | --- | --- |
| AAC-LC | Native WebCodecs -> planar float PCM -> AudioWorklet | Exact stereo 48 kHz output. Six-channel 48 kHz is used only after its separate output probe, then downmixed to stereo. | Implemented and runtime-gated. HE-AAC/xHE-AAC are not independently qualified. |
| Opus | Native WebCodecs -> PCM -> AudioWorklet | Stereo and exact-qualified six-channel input at 48 kHz, output as stereo 48 kHz. | Implemented and runtime-gated. |
| FLAC | Native WebCodecs -> PCM -> AudioWorklet | Stereo and exact-qualified six-channel input at 48 kHz, output as stereo 48 kHz. | Implemented and runtime-gated. This is the intended owned audio route for the pending Main10 DirectPlay test. |
| MP3 | Native WebCodecs -> PCM -> AudioWorklet | Stereo 48 kHz only. | Implemented and runtime-gated. Mono, 44.1 kHz, and surround are currently rejected by policy. |
| Vorbis | Native WebCodecs -> PCM -> AudioWorklet | Stereo and exact-qualified six-channel input at 48 kHz, output as stereo 48 kHz. | Implemented and runtime-gated. |
| AC-3 | Preferred exact-qualified native-media MSE bridge, otherwise Mediabunny `@mediabunny/ac3` software decode -> PCM | Native bridge probes 2/6 channels at 48 kHz. The current checkpoint still includes the software decoder only when `ENABLE_BUNDLED_AC3_SOFTWARE_DECODER=1`. | Implemented but temporarily build-gated. Licensing is approved; promote the Mediabunny decoder to ordinary builds in the next audio checkpoint. Native availability still varies. |
| E-AC-3 | Preferred exact-qualified native-media MSE bridge, otherwise Mediabunny `@mediabunny/ac3` software decode -> PCM | Native bridge probes 2/6 channels at 48 kHz. The current software route shares the AC-3 build gate. | Implemented but temporarily build-gated. Promote it to ordinary builds; Dolby Atmos object rendering/passthrough remains unimplemented. |

### 5.2 Unsupported audio codecs and implementation procedures

| Unsupported codec/feature | Priority | Procedure |
| --- | --- | --- |
| Arbitrary sample rates, including 44.1/88.2/96/192 kHz | P0 shared prerequisite | Add one high-quality streaming resampler before adding per-codec exceptions. It must preserve signed-microsecond timestamps, expose deterministic latency, reset on seek/generation, bound its history, and have impulse/sine/sweep reference tests. Then expand exact capability fixtures and eligibility by source rate. |
| Mono, 7.1, and arbitrary channel layouts | P0 shared prerequisite | Introduce an explicit channel-layout model and channel labels, not just a count. Add remap/downmix matrices with normalization and LFE policy, validate against FFmpeg/mpv reference PCM, and decide whether output remains stereo or can use qualified multichannel Web Audio. Reuse this for every codec. |
| DTS Core, DTS-ES, DTS-HD HR/MA | P0 common disc libraries | Complete legal review, then add a Mediabunny decoder registration or worker adapter backed by a reviewed decoder. Add MKV/M2TS packet mapping, core-vs-extension behavior, 48/96 kHz and 2/6/8-channel fixtures, resampling/layout integration, exact PCM hashes, seek/switch tests, and device-profile constraints. DTS:X object rendering and passthrough must be a separate feature. |
| TrueHD/MLP | P0 common disc libraries | Add a reviewed software decoder and Matroska/M2TS packet mapping, including major-sync recovery. Feed decoded channel-labeled PCM through the shared resampler/layout stage. Validate 48/96/192 kHz, 6/8 channels, lossless PCM hashes, seek preroll, and sustained CPU use. Dolby Atmos objects/passthrough remain a separate route. |
| ALAC | P1 Apple/lossless libraries | Probe future native WebCodecs exactly; otherwise add a small reviewed decoder. Implement MP4 magic-cookie/extradata mapping, 44.1-192 kHz and multichannel fixtures, resampling/layout integration, lossless PCM hashes, and seek tests. |
| PCM families, including signed/unsigned integer, float, little/big endian, mu-law, A-law, DVD/BD LPCM | P0 foundation | Integrate Mediabunny's built-in PCM decoders and sample sinks rather than implementing duplicate converters. Map Mediabunny sample formats to explicit channel layouts, then add resampling and deterministic PCM hash tests. Add only genuinely missing container-specific LPCM unpacking. |
| WMA/WMAPRO/WMALOSSLESS | P1 legacy Windows libraries | Add ASF demux first, then a reviewed decoder adapter. Validate codec private data, block alignment, seek timestamps, common rates/layouts, PCM hashes, resampling, and malformed packet handling. |
| xHE-AAC, HE-AAC v1/v2 | P1 AAC completion | Add distinct AudioDecoder configurations and exact output fixtures, including SBR/PS sample-rate and channel expansion. Confirm timestamps and output rate rather than treating AAC-LC evidence as sufficient. Then add resampling/layout coverage and exact profile constraints. |
| Atmos, DTS:X, and bitstream passthrough | P2 output feature | First decide the browser output API and platform policy. Web Audio PCM does not preserve object metadata or compressed passthrough. Implement only behind an exact sink/output capability with user consent, latency/clock integration, exclusive-mode failure handling, and codec/legal review. Never label decoded E-AC-3 or TrueHD PCM as Atmos. |

## 6. Container and source support

| Container family | Current accepted video | Current accepted audio | Status/gaps |
| --- | --- | --- | --- |
| MP4/M4V/MOV/3GP/3G2/MJ2 | H.264, HEVC, VP8, VP9, AV1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3 | Implemented eligibility rule, subject to actual demux and codec probes. Add negative brand/extradata/edit-list tests. |
| MKV/Matroska | H.264, HEVC, VP8, VP9, AV1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3 | Implemented; includes several Dolby Vision BL/EL topologies. Expand ordered chapters, attachments, codec delay, and unusual timestamp tests. |
| WebM | VP8, VP9, AV1 | Opus, Vorbis | Implemented and deliberately narrow. |
| TS/MTS/M2TS | H.264, HEVC | AAC, MP3, AC-3, E-AC-3 | Implemented for bounded VOD/range input; Profile 7 PID dependency discovery exists. Live transport streams remain unsupported. Expand discontinuity, wraparound, PAT/PMT change, and BDMV end-to-end tests. |
| AVI | None | None | Not implemented. Add demux, index/seek, timestamp, OpenDML, and malformed-chunk handling before enabling MPEG-4 Part 2/MJPEG/legacy audio. |
| ASF | None | None | Not implemented. Required before WMA/WMV coverage. |
| Ogg | Mediabunny container support exists; no currently supported Ogg video codec | Opus and Vorbis are available after eligibility/profile integration | Not enabled in custom eligibility. Reuse Mediabunny's Ogg reader and qualify range/seek/timestamp behavior; do not implement another Ogg demuxer. Theora still needs a decoder. |
| MPEG-PS/VOB | None | None | Not implemented. Required for broad MPEG-2/DVD coverage. |
| MXF | None | None | Not implemented. Consider only with ProRes/DNx demand. |
| HLS | Mediabunny HLS input exists but is not connected to custom playback | Same | Integrate Mediabunny only after VOD segment, discontinuity, cancellation, credential, buffering, and live-clock policy are defined. Do not write another HLS parser. HTML/server playback remains the fallback meanwhile. |
| DASH/live manifests | No owned custom route | No owned custom route | DASH remains unsupported. Live playback requires a clock/buffering policy even when the container parser exists. HTML/server playback remains the fallback. |
| DRM/encrypted media | None | None | Explicitly unsupported by custom decode. Use the existing browser/HTML EME path as a whole-session fallback. |

Adding a container follows one shared procedure: first enable Mediabunny's
existing reader, then validate exact sniffing, bounded parsing, track metadata,
codec-private data, signed-microsecond PTS/DTS, keyframe index, range-seek
behavior, and a malformed/fuzz corpus. Implement parser code only for missing
behavior, and expose eligibility/device profiles only after the route passes.

## 7. Encompassing validation matrix

### 7.1 Objective

Replace separate hand-maintained smoke instructions with one versioned case
manifest that drives fixtures, unit tests, worker tests, GPU authorization,
live Jellyfin tests, failure injection, performance gates, soak tests, and
reports. Production capability probes should use minimized fixtures derived
from the same cases, not unrelated samples with duplicated expected values.

### 7.2 Canonical case model

Each case must contain at least:

```text
id and schema version
fixture URI, SHA-256, provenance, generator command, and redistribution license
container and packetization
video codec/profile/level/bit depth/chroma/range/primaries/transfer/matrix
resolution, crop, sample aspect ratio, and frame rate
audio codec/profile/rate/layout and expected output route
Dolby Vision profile/layers/RPU mode when applicable
expected decoder backend, frame mode, presentation route, and fallback
lifecycle script and injected failures
pixel/PCM fingerprints and tolerances
startup, throughput, queue, drift, memory, and event thresholds
required browser/GPU/OS coverage
expected Jellyfin play method and permitted transcode reasons
```

One case ID must have one authoritative expected result. Unit tests may consume
a reduced artifact, but they must not redefine the expected color or PCM data.

### 7.3 Matrix axes

| Axis | Required values |
| --- | --- |
| Browser | Chrome stable and Edge stable on the primary Windows release gate; Chrome Beta/Canary for regression warning; other Chromium builds recorded separately. |
| Operating system | Windows 11 first. Add Linux and macOS only when the product claims them; do not merge their evidence with Windows. |
| GPU | At least current AMD, NVIDIA, and Intel hardware/driver families; integrated and discrete where available; record adapter ID, driver, canvas format, and HDR display state. |
| Presentation | Direct HTML reference; HTML decode + WebGPU external texture; custom native `VideoFrame`; custom native raw planes; bundled raw planes; native external HDR; Dolby Vision raw; Dolby Vision external. |
| Video codec | Every implemented row in section 4, plus one negative fixture for every advertised-nearby unsupported profile. |
| Container | MP4/MOV, MKV, WebM, TS, M2TS; length-prefixed and Annex B HEVC where applicable; valid and malformed codec private data. |
| Resolution | 480p, 720p, 1080p, 2160p, odd/cropped dimensions, and the exact maximum of each tier. |
| Frame rate | 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, plus just-over-limit negative cases. |
| Color | BT.709 limited/full SDR; BT.2020 limited PQ; BT.2020 limited HLG; metadata missing/conflicting; 8/10/12-bit negatives; chroma siting and crop. |
| Dolby Vision | Profile 5; 7 MEL; 7 FEL; 8.1; 8.4; interleaved, Matroska dual-track, ISO BMFF dual-track, TS dual-PID, M2TS dependency; absent/corrupt/stale RPU; missing/mismatched EL. |
| Audio | Every implemented codec in stereo 48 kHz; qualified 5.1 cases; native-media vs decoded-PCM AC-3/E-AC-3; unsupported 44.1/96 kHz and 7.1 negatives; audio-free video. |
| Network/source | Correct ranges; server ignores range; truncated response; retry; slow/chunked transfer; authentication; expired URL; redirect; 404/416; source replacement. |
| Lifecycle | Start, pause/resume, single seek, seek storm, next item, repeat sessions, natural EOF/audio-tail drain, audio switch, subtitle switch, stop(false), stop(true), destroy, background/foreground. |
| Display | Window resize, DPR change, fullscreen enter/exit, crop/aspect, monitor/output change, canvas format change where observable. |
| Failure | WebGPU/WebCodecs absent; adapter/device/pipeline/import/copy/readback failure; device loss while playing/paused; worker crash/timeout/protocol corruption; decoder error; audio worklet/MSE failure; authorization rejection. |
| Performance | Time to first audio/frame, decode fps/headroom, dropped/corrupt frames, CPU/GPU time, upload bandwidth, A/V drift, queue depth, underflows, heap/backing storage, object/listener/worklet/worker retention, power where measurable. |
| Negotiation | DirectPlay accepted, DirectStream selected only when intended, server transcode reasons exact, profile retry after probe completion, unsupported routes never advertised, HTML fallback does not renegotiate after presentation-only failure. |
| Security/robustness | Credentials and signed URLs absent from reports, bounded metadata and worker messages, content hashes, malicious dimensions/strides/timestamps, parser/WASM memory ceilings, fuzz corpus. |

The complete Cartesian product is wasteful. Use pairwise generation for ordinary
combinations, then explicit full cross-products at architectural boundaries:

- each codec x each legal container;
- each HDR transfer x each decoder/presentation route;
- each Dolby Vision profile/topology x success/fallback;
- each audio route x layout x seek/switch;
- each active GPU route x device loss;
- each software decoder x soak and worst qualified tier.

### 7.4 Validation layers

| Layer | Purpose | Required artifact |
| --- | --- | --- |
| Static/unit | Parsers, timestamps, profile limits, queue bounds, generation invalidation, shader source, protocol validation | Vitest result linked to case IDs |
| Decoder conformance | Exact decoded dimensions, pixel/PCM fingerprints, timestamps, flush/reset/close, malformed input | JSON result and fixture hash |
| GPU authorization | Execute the production renderer and compare readback samples for the exact device/format/route | Authorization decision plus diagnostic pixels |
| Worker integration | Real content-addressed worker, demux, decoder backend, ownership acknowledgements, EOF | Worker telemetry and console log |
| Live Jellyfin negotiation | Real port-8096 frontend/server, device profile, PlaybackInfo, DirectPlay/DirectStream/transcode decision | Server playback response, sanitized network trace, screenshot, telemetry |
| Lifecycle/fault | Seek storms, switching, stop/reuse, presentation failure, device loss, fallback | Event ledger, generation ledger, queue endpoints |
| Visual/audio reference | Compare production output to pinned FFmpeg/mpv/libplacebo-derived reference data and direct HTML SDR | Pixel deltas, PCM hashes, screenshots |
| Performance | Startup, steady-state throughput, drops, drift, CPU/GPU/memory | Machine-readable metrics with thresholds |
| Retention/soak | Repeated sessions, GC snapshots, worker/worklet/device retirement, ownership warnings | Trend analysis and pass/fail report |

### 7.5 Framework implementation

1. Add `scripts/webgpu/validation/manifest.json` with a checked schema and stable
   case IDs.
2. Add one fixture registry that validates hashes, metadata, provenance, and
   licenses before a run.
3. Refactor existing fixture generators to emit manifest records instead of
   standalone undocumented filenames.
4. Add adapters for Vitest, worker smoke, GPU readback, CDP/Jellyfin 8096, server
   API/log capture, and FFmpeg/mpv reference generation.
5. Add common failure-injection hooks keyed by case ID. Do not implement a
   separate injection vocabulary in each smoke script.
6. Emit one versioned JSON result format containing commit, dirty state,
   browser, OS, GPU/driver, server version, flags, fixture hashes, thresholds,
   telemetry, artifacts, and sanitized errors.
7. Generate Markdown/HTML summaries and a manual checklist from that JSON. A
   manual observation must cite a case ID and environment.
8. Add baseline comparison with explicit tolerances and a reviewed update
   command. Baselines must never update implicitly.
9. Add matrix selectors such as `checkpoint`, `release`, `codec:<name>`,
   `route:<name>`, `gpu:<vendor>`, and `soak`.
10. Make the release runner fail on missing required cases, unknown capability
    results, unexpected transcodes, console errors, finalizer warnings, leaked
    resources, or unsanitized credentials.

### 7.6 Minimum gates

**Every change**

- TypeScript check.
- Focused Vitest files.
- ESLint on changed source/test files.
- Development build if runtime code or assets changed.

**Every codec/route checkpoint**

- Exact capability positive, negative, timeout, exception, and mismatch tests.
- Decoder conformance and ownership tests.
- One legal container per route through real worker artifacts.
- Live Jellyfin DirectPlay plus intentional fallback.
- Pause, seek, seek storm, stop, reuse, and natural EOF.
- Production GPU readback for color routes.
- Device loss for GPU routes.
- Startup comparison and at least three repeated sessions.

**Release candidate**

- Full test/lint/style/build production suite.
- Artifact and license verification for ordinary and optional builds.
- Required browser/GPU matrix.
- Thirty-session native and worst-software-route retention gates.
- Long-duration real-title playback with no unbounded queues, decoder stalls,
  A/V drift, finalizer warnings, or retained resources.
- Negotiation audit proving every advertised profile has a passing case and
  every unsupported profile remains absent.

## 8. Remaining work grouped to minimize duplication

Each group owns a coherent code surface and produces artifacts consumed by the
others. Avoid assigning multiple groups simultaneous edits to
`CustomDecodeCapabilities.ts`, `CustomPlaybackEligibility.ts`, or
`CustomDeviceProfile.ts`; one integration owner should apply registry/profile
changes after route work and evidence are complete.

Each group is a bounded workstream suitable for one subagent. A subagent should
own its modules, fixtures, and tests end to end, then hand a measured route
record to the integration owner instead of independently changing shared
Jellyfin capability files.

### Group A: Finish the native external HDR checkpoint

**Owns:** HEVC color neutralizer, native HDR capability, external HDR fixture and
authorization, shader, presenter, protocol, eligibility, profile integration.

**Deliverable:** a committed, pushed, port-8096-qualified HEVC Main10 PQ/HLG
native external-texture route with exact fallback.

**Do not combine with:** new codecs, audio resampling, or validation-framework
refactoring before this checkpoint is closed.

### Group B: Unified validation framework

**Owns:** manifest/schema, fixture registry, runners, failure vocabulary, CDP and
server evidence adapters, reports, baselines, matrix selection.

**Deliverable:** one command can run a selected matrix and produce a sanitized,
reproducible report. Existing smoke/color/retention tools become adapters rather
than competing frameworks.

**Why grouped:** fixture metadata, environment capture, failure injection, and
reporting are shared by every codec and should be implemented once.

### Group C: Shared video decoder and raw-format expansion

**Owns:** decoder adapter contract, packet transforms, frame/sample ownership,
raw plane formats, buffer pools, worker protocol, generic exact-output and
throughput probes.

**Deliverable:** adding a codec requires a small adapter, fixtures, and route
descriptor rather than copying HEVC-specific lifecycle logic.

**First consumers:** official Mediabunny decoders and sample paths, then MPEG-2,
MPEG-4 Part 2, VC-1, high-bit-depth/chroma variants, and codecs Mediabunny does
not provide.

**Boundary:** color reconstruction remains in Group E; negotiation changes are
applied by Group F only after Group B evidence passes.

### Group D: Audio normalization, layout, and codecs

**Owns:** streaming resampler, channel-layout model, remap/downmix, optional
multichannel output policy, audio decoder adapters, PCM conversion, AudioWorklet
clock integration, native-media audio bridge.

**Deliverable:** arbitrary common rates/layouts are normalized once, allowing
DTS, TrueHD, ALAC, PCM, and WMA adapters without per-codec output hacks.

**Order:** resampler -> layout model -> Mediabunny PCM -> standard-build
`@mediabunny/ac3` -> ALAC -> DTS/TrueHD -> WMA. Separate legal review remains
necessary only for non-Mediabunny decoder dependencies.

### Group E: HDR and Dolby Vision correctness

**Owns:** color metadata, transfer functions, gamut/tone mapping, dithering,
RPU parsing, BL/EL composition, HDR/DV GPU authorization, golden references,
renderer controls.

**Deliverable:** mpv/libplacebo-level reconstruction for the claimed profiles,
with exact-device authorization and documented graceful degradation.

**Remaining concentration:** real-title Profile 5/7/8 matrix, BDMV behavior,
FEL dual-decoder performance, HLG and HDR metadata conflicts, display controls,
golden thresholds, and device/display changes.

### Group F: Negotiation and capability safety

**Owns:** structured codec/container route descriptors, capability aggregation,
Jellyfin device-profile constraints, profile refresh/retry, PlaybackInfo naming,
and exact transcode-reason tests.

**Deliverable:** Jellyfin never transcodes a passing route for a false capability
reason and never DirectPlays a route without complete evidence.

**Boundary:** this group does not implement decoders. It consumes passing route
records from Groups C/D/E and validation evidence from Group B.

### Group G: Playback lifecycle and Jellyfin integration

**Owns:** session controller, clock, event cardinality, audio/subtitle switching,
playlist reuse, SyncPlay behavior, OSD/fullscreen/accessibility, backgrounding,
HTML fallback and source continuity.

**Deliverable:** custom decode behaves like a Jellyfin media player, including
rapid user actions and fallback, without duplicated events or a source restart
for presentation-only failure.

**Remaining concentration:** subtitle route qualification, audio switching across
all backends, non-1.0 rate policy/implementation, next-item reuse, remote/PiP
policy, and real SyncPlay testing.

### Group H: Resource, performance, and recovery hardening

**Owns:** queue/credit ceilings, ownership accounting, device/worker/worklet
recovery, startup prewarm, memory snapshots, decoder throughput, A/V drift,
long-play and repeated-session gates.

**Deliverable:** bounded operation at every advertised tier and a clean stop
baseline.

**Immediate defect:** causally resolve the intermittent unclosed Mediabunny
`VideoSample` warning. Do not suppress it, and do not claim a leak-free soak
until retained-object or memory evidence closes the defect.

### Group I: Packaging, distribution, security, and rollout

**Owns:** content-addressed assets, build flags, artifact byte verification,
CSP/worker loading, URL/credential sanitization, feature rollout, browser/GPU
whitelist policy, documentation, and licensing for non-Mediabunny dependencies.

**Deliverable:** ordinary builds contain only reviewed assets; optional local
decoder builds are unmistakable; feature flags remain safe; reports contain no
credentials; rollout can be disabled without changing playback negotiation.

### Group J: Container expansion

**Owns:** integration and qualification of every Mediabunny-supported container,
plus genuinely missing AVI, ASF, MPEG-PS/VOB, and later MXF demux/seek behavior.

**Deliverable:** one tested container contract producing the existing encoded
packet/audio packet structures. Codec groups consume it without embedding
container parsing in decoder adapters.

**Order:** enable and qualify Mediabunny Ogg and HLS where product policy permits,
then MPEG-PS for MPEG-2/DVD, AVI for MPEG-4 Part 2/MJPEG, ASF for VC-1/WMA, and
MXF only if professional-codec demand justifies it.

### Group K: Source transport and buffering

**Owns:** authenticated HTTP range reads, redirects, retry policy, read-ahead,
backpressure, cancellation, source replacement, cache bounds, and network
telemetry.

**Deliverable:** predictable startup and recovery on local and remote Jellyfin
servers without duplicate downloads, stale credentials, decoder starvation, or
unbounded buffering.

**Boundary:** this group produces byte ranges and structured transport errors.
Container parsing remains in Group J, decoder queues remain in Groups C/D, and
fallback policy remains in Group G.

## 9. Dependency and parallel execution plan

```text
Group A: current native HDR checkpoint
  -> stable checkpoint

Group B: validation schema/framework ------------------------------+
Group I: legal/package audits -------------------------------------+-- parallel
Group J: container contracts --------------------------------------+
Group K: source transport/buffering -------------------------------+
                                                                    |
Group C: shared video formats/adapters <- B + J + K where required -+
Group D: audio normalization/codecs <- B + I + K -------------------+
Group E: HDR/DV qualification <- B + stable A ----------------------+
                                                                    |
Group F: capability/profile integration <- C + D + E evidence -------+
Group G: lifecycle integration <- C + D + E -------------------------+
Group H: performance/soak <- B + C + D + E + G ----------------------+
                                                                    |
Release gate <- B + F + G + H + I ----------------------------------+
```

Rules that prevent duplicated work:

1. Group B defines the sole validation case/result schemas before new codec
   teams create fixtures.
2. Group C defines all new video plane/chroma formats once; codec adapters may
   not invent private frame payloads.
3. Group D owns all resampling/layout logic; codec adapters output labeled PCM
   and do not downmix independently.
4. Group E owns all color math and route authorization; decoder code carries
   metadata but does not implement tone curves.
5. Group F is the sole writer of final Jellyfin profile widening for concurrent
   codec work.
6. Group J owns container parsing; codec adapters receive structured packets.
7. Group H turns ownership/performance requirements into shared assertions, not
   codec-specific console checks.
8. Group K owns range/retry/cache behavior; demuxers and decoders may not create
   independent network fetch policies.
9. A route is merged only with its negative/fallback cases and documented
   capability bounds. "Decoder works on one file" is not a merge criterion.

## 10. Product completion checklist

### Codec and container coverage

- [x] H.264 8-bit Baseline/Main/High exact native routes.
- [x] HEVC Main/Main10 native and bundled route infrastructure.
- [x] VP8, VP9 Profile 0/2, and AV1 Main 8/10 route infrastructure.
- [x] AAC, Opus, FLAC, MP3, Vorbis, and conditional AC-3/E-AC-3 routes.
- [x] Finish and qualify native HEVC external HDR.
- [ ] Add shared video decoder adapter/raw-format expansion.
- [ ] Add MPEG-2, MPEG-4 Part 2, and VC-1 priority routes.
- [ ] Decide and implement the required P1/P2 codec subset from sections 4.2
  and 5.2 using actual library inventory and legal review.
- [ ] Add streaming audio resampling and explicit channel layouts.
- [ ] Promote `@mediabunny/ac3` to ordinary builds and delete the obsolete local
  validation-only build policy while retaining exact runtime qualification.
- [ ] Integrate Mediabunny's built-in PCM decoders.
- [ ] Add `@mediabunny/prores` through the shared video route.
- [ ] Add DTS family, TrueHD/MLP, and ALAC priority routes.
- [ ] Enable and qualify Mediabunny Ogg and applicable HLS paths.
- [ ] Add only missing MPEG-PS, AVI, and ASF containers as their codecs require.
- [ ] Harden authenticated range input, redirects, cancellation, retries,
  read-ahead/backpressure, and bounded caching for remote-server latency.
- [ ] Validate every legal codec/container pair and nearby negative pair.

### HDR and Dolby Vision

- [x] Raw PQ/HLG WebGPU reconstruction and tone mapping.
- [x] Dolby Vision Profile 5/8, Profile 7 MEL, and implemented FEL code paths.
- [x] Complete native external PQ/HLG checkpoint.
- [ ] Build the complete HDR/DV golden and live-title matrix.
- [ ] Validate Profile 7 FEL for all claimed container topologies and sustained
  dual-decoder playback.
- [ ] Complete BDMV/M2TS end-to-end qualification.
- [ ] Validate metadata conflicts, missing metadata, corrupt/stale RPU, EL loss,
  and exact fallback/degradation behavior.
- [ ] Validate device loss, adapter changes, canvas format changes, fullscreen,
  DPR, and display changes for every HDR/DV route.
- [ ] Define final renderer controls, defaults, persistence, and live uniform
  updates without shader recompilation.
- [ ] Define color-delta thresholds and approve golden references.

### Audio

- [x] Owned decoded-PCM AudioWorklet clock/output.
- [x] Stereo 48 kHz and qualified 5.1-to-stereo paths.
- [x] Native-media AC-3/E-AC-3 bridge.
- [ ] Implement resampling with deterministic latency.
- [ ] Implement channel labels, mono/7.1 policy, and reference downmix tests.
- [ ] Qualify audio switching among native-media, native WebCodecs, and bundled
  decoder routes without restarting video.
- [ ] Decide supported playback-rate behavior and implement rate-adjusted PCM or
  retain an explicit 1.0-only product limitation.
- [ ] Decide multichannel PCM output and compressed passthrough policy.
- [x] Approve Mediabunny and official Mediabunny decoder-extension licensing.
- [ ] Make AC-3/E-AC-3 software decode part of the ordinary verified build.
- [ ] Ensure Atmos/DTS:X UI never overstates decoded base-channel output.

### Jellyfin behavior

- [x] Stable wrapper identity, HTML fallback, and generation invalidation.
- [ ] Prove DirectPlay negotiation for every advertised route on port 8096.
- [ ] Audit all PlaybackInfo player/decoder/stream labels and transcode reasons.
- [ ] Constrain audio profile claims to the exact probed variants, especially
  AAC-LC versus HE-AAC/xHE-AAC, rather than treating a codec-family probe as
  evidence for every profile.
- [ ] Validate profile refresh after asynchronous probes without playback loops.
- [ ] Validate pause/resume, seek storms, EOF, repeat, next item, stop modes,
  destroy, and rapid source replacement across all route families.
- [ ] Validate audio and subtitle track switching, external/text subtitles,
  subtitle offset, and secondary subtitles.
- [ ] Validate SyncPlay clock/event semantics and document rate limitations.
- [ ] Validate OSD stacking, pointer input, accessibility, fullscreen, resize,
  DPR, background/foreground, and screen wake behavior.
- [ ] Define PiP, AirPlay, Remote Playback, casting, and DRM fallback behavior.
- [ ] Add live/infinite-stream support or explicitly retain HTML/server fallback
  as the final product policy.

### Validation and release

- [ ] Implement the unified validation manifest and result schema.
- [ ] Migrate existing color, worker, browser, startup, artifact, and soak tools
  into the shared framework.
- [ ] Record deterministic fixtures, hashes, generators, provenance, and license.
- [ ] Add automated FFmpeg/mpv reference generation from pinned revisions.
- [ ] Add required Windows Chrome/Edge and AMD/NVIDIA/Intel matrix runners.
- [ ] Add pairwise generation plus the explicit boundary cross-products.
- [ ] Establish startup, frame-drop, A/V drift, queue, CPU/GPU, memory, and
  color/audio thresholds.
- [ ] Resolve the known `VideoSample` ownership defect.
- [ ] Pass native and worst-software-route long-play and 30-session retention
  gates without finalizer warnings or growth.
- [ ] Complete decoder/patent/license/security review for every shipped asset.
- [ ] Verify ordinary and optional build contents byte-for-byte.
- [ ] Synchronize with Jellyfin upstream through inspected changes without
  merging the fork's old HDR branch wholesale; resolve player-contract and build
  conflicts with focused tests.
- [ ] Define dependency update, decoder-fixture regeneration, and browser
  regression procedures.
- [ ] Keep source feature flags disabled until the release matrix passes.
- [ ] Define staged browser/GPU rollout, telemetry privacy, rollback, and support
  documentation.

## 11. Checklist before the next commit

The next commit should contain only the current native HEVC Main10 external-HDR
checkpoint plus the required HTML startup, validation-harness, tests, and
documentation changes. The approved Mediabunny AC-3/E-AC-3 standard-build
change is the immediately following audio checkpoint; keeping it separate
preserves review and live-validation isolation.

### 11.1 Already completed in the worktree

- [x] Add a separate native Main10 4K HEVC output/throughput capability.
- [x] Assign only measured 24/30/60 fps tiers with 1.25x headroom.
- [x] Parse and rewrite HEVC SPS/HVCC color metadata to the neutral BT.709
  limited signal used by the external-texture recovery route.
- [x] Carry explicit neutralization state through worker/session/controller
  protocol instead of inferring it in the renderer.
- [x] Add the production external HDR shader branch and code-value recovery.
- [x] Add exact embedded PQ and HLG authorization fixtures.
- [x] Scope authorization by GPU device, canvas target format, transfer, and
  route key.
- [x] Connect authorization and capability limits to eligibility and Jellyfin
  device-profile widening.
- [x] Add focused capability, protocol, worker/session/controller/player,
  presenter, shader, eligibility, profile, fixture, and authorization tests.
- [x] Pass `npm run build:check` once after the implementation.
- [x] Pass the affected focused Vitest suites once after the implementation.
- [x] Record the known `VideoSample` ownership warning as unresolved rather than
  blocking unrelated feature work.

### 11.2 Code review and missing automated coverage

- [x] Review every tracked and untracked diff for stale experiments, duplicate
  branches, inconsistent route names, and accidental source flag changes.
- [x] Confirm every switch over decoder backend, video output mode, HDR route,
  fallback reason, and telemetry handles the new route exhaustively.
- [x] Add or confirm negative tests for unsupported profile/bit depth/level,
  over-limit dimensions/bitrate/frame rate, missing metadata, and unqualified
  transfer.
- [x] Add or confirm authorization tests for pixel mismatch, decoder config
  rejection, decoder error, timeout, target-format rejection, device change,
  stale generation, and cancellation during teardown.
- [x] Add or confirm presenter tests for authorization rejection, device loss
  during playback, device loss while paused, replacement-device reauthorization,
  canvas format/resize change, and direct-video fallback.
- [x] Verify neutralization for length-prefixed HVCC and Annex B packets, SPS
  replacement, packets without SPS, malformed NAL lengths, and source changes.
- [x] Verify Dolby Vision packet splitting remains byte-correct and is not
  accidentally neutralized on an incompatible route.
- [ ] Verify all imported `VideoFrame`, GPU buffer/texture, decoder, iterator,
  and authorization-fixture ownership paths close exactly once.
- [x] Update `WEBGPU_PLAYER.md` with the native external HDR route, capability
  bounds, telemetry, exact authorization, manual procedure, and fallback.
- [ ] Update `WEBGPU_DOLBY_VISION.md` only if the shared HEVC changes alter a
  documented DV route or limitation.

### 11.3 Required local command gates

- [x] Run `npm run build:check` again from the final diff.
- [x] Run all affected WebGPU Vitest files, not only the newly added tests.
- [x] Run the complete `src/plugins/webGPUVideoPlayer` Vitest suite.
- [x] Run ESLint on every changed TypeScript/JavaScript file; it reports zero
  errors and only four pre-existing HTML-player warnings.
- [x] Confirm stylelint is not applicable because no SCSS/CSS changed.
- [x] Run the Node tests under `scripts/webgpu` that cover worker naming,
  artifacts, browser helpers, fixtures, and release metrics.
- [x] Build with `npm run build:development` using Node 24/npm 11.
- [x] Run `node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 disabled`.
- [x] Confirm the optional AC-3 build is not touched by this checkpoint, so the
  separate `--ac3 enabled` gate is not applicable here.
- [x] Run `git diff --check`.

### 11.4 Port-8096 browser qualification

- [x] Install/serve the current development build through the existing Jellyfin
  server on `http://localhost:8096`; do not substitute a separate 8080 frontend
  for the authoritative manual check.
- [x] Enable feature flags only in the locally served ignored `dist/config.json`.
- [x] Confirm the exact native Main10 capability reports decoded output,
  measured fps, selected tier, 4K/Level 153/40 Mbps bounds, and no bundled route
  substitution.
- [x] Confirm the exact external PQ authorization passes and telemetry records
  device, target format, route key, transfer, and accepted readback.
- [x] Confirm the exact external HLG authorization independently passes.
- [ ] Play the Dark Knight Main10/FLAC case and require Jellyfin `DirectPlay`,
  not HLS transcoding or a false "codec/level/resolution/bitrate/range" reason.
- [ ] Confirm PlaybackInfo identifies `WebGPU Video Player` and the telemetry
  identifies native video-frame/external-HDR plus owned FLAC audio.
- [ ] Visually compare representative dark, bright, saturated, skin-tone, and
  gradient scenes against the raw-HDR/reference path; capture screenshots and
  readback evidence.
- [ ] Play a generated PQ fixture and a generated HLG fixture through start,
  pause/resume, seek, seek storm, natural EOF, explicit stop, and replay.
- [x] Play 30-second generated PQ and HLG fixtures through start, pause/resume,
  seek, seek storm, fullscreen, resize/DPR, and explicit stop. Natural EOF and
  replay remain in the broader lifecycle item above.
- [x] Validate resize, DPR change, and fullscreen enter/exit without canvas
  mis-sizing or a second session. OSD/subtitle stacking still requires a manual
  visual pass.
- [ ] Inject presentation authorization rejection and require the intended
  bounded fallback without a playback negotiation loop.
- [ ] Inject device loss while playing and paused; require one replacement
  device, reauthorization, correct exact-time repaint, and no source restart.
- [ ] Run an SDR H.264/HEVC/VP9/AV1 identity regression set.
- [ ] Run Wolfwalkers/Dolby Vision regression cases for every route currently
  claimed by its source topology; distinguish actual custom DirectPlay from an
  HTML-transcoded source in the evidence.
- [ ] Exercise one native-media audio case and one decoded-PCM case to ensure the
  new video route did not change audio clocks or track selection.
- [x] Inspect browser console, Jellyfin PlaybackInfo, worker retirement,
  dropped/corrupt frames, queue bounds, A/V drift, and fallback count for both
  generated PQ/HLG runs. Both completed without unexpected output.

### 11.5 Resource and regression gates

- [ ] Run at least three consecutive native external-HDR sessions and verify
  stable workers, listeners, GPU resources, frames, and AudioWorklet state.
- [ ] Run the checkpoint startup comparison against direct HTML, HTML+WebGPU,
  and the existing raw custom route; investigate any threshold regression.
- [ ] Run a short retention snapshot after clean stop.
- [x] Record whether the known Mediabunny `VideoSample` finalizer warning occurs.
  It did not occur in either controlled PQ/HLG lifecycle run. Its causal fix
  remains deferred, but new deterministic leaks or per-session growth block
  later release qualification.
- [ ] Verify fallback still plays the same selected source/session where the
  failure is presentation-only and does not duplicate Jellyfin reporting.
- [ ] Verify ordinary HTML playback with all WebGPU flags disabled is unchanged.

### 11.6 Final checkpoint hygiene

- [x] Re-run TypeScript, focused/full plugin tests, lint, development build, and
  artifact verification after the last fix.
- [x] Confirm `src/config.json` keeps all WebGPU feature flags false.
- [x] Confirm generated worker/runtime filenames are content-addressed and all
  referenced assets exist in `dist`.
- [x] Confirm no credentials, machine-specific paths, generated media, logs,
  screenshots, or ignored local `dist/config.json` changes are staged.
- [x] Confirm the diff contains only native external HDR and its required HTML
  startup, integration, validation, tests, and documentation changes.
- [x] Record the exact browser, GPU/driver, Jellyfin server, fixture hashes,
  commands, and results in the checkpoint notes.
- [x] Prepare the checkpoint for a focused imperative commit and push on
  `webgpu-player`.

### 11.7 Native external HDR checkpoint evidence

- Runtime: Chrome `151.0.7922.72`, NVIDIA GeForce RTX 4080 SUPER, driver
  `596.60`, WebGPU adapter vendor `nvidia` and architecture `lovelace`.
- Server/build: Jellyfin `10.11.6` on `http://localhost:8096`, Node `24.17.0`,
  npm `11.13.0`, development webpack build.
- PQ fixture: `pq-main10-1080p24-aac.mkv`, item
  `5002955f082b6eb589c2cd8c28812342`, SHA-256
  `bda7653938b6ce8e667b7abae70ce1c19b95c1e6d0b2fcdc0e0deb7c55f85cb7`.
- HLG fixture: `hlg-main10-1080p24-aac.mkv`, item
  `370e9984e4c8cfdf7b4abe00f0b5a0b3`, SHA-256
  `0e10f3d0a599a9afaffda6ebf3db6da4643379d059a4282305e4cfd2e410a018`.
- Both runs selected owned native HEVC `video-frame` decode, SPS/HVCC color
  neutralization, external-HDR presentation, HDR-to-SDR tone mapping, and
  decoded AAC PCM. Exact device-scoped PQ and HLG authorization settled with
  maximum channel errors `0.038635925399808646` and
  `0.014985933885669156`, respectively.
- PQ first presentation was approximately `124.7 ms`; pause held with zero
  clock/frame delta, resume advanced `314782 us` and seven frames, and seek
  reached `8540100 us` for target `8537131 us`.
- HLG first presentation was approximately `120.9 ms`; pause held with zero
  clock/frame delta, resume advanced `315528 us` and eight frames, and seek
  reached `8603700 us` for target `8596064 us`.
- Both runs completed fullscreen enter/exit, resize/DPR, seek storm, one clean
  explicit stop, zero dropped/corrupt frames, zero fallback, zero browser
  console/log/runtime errors, and no observed `VideoSample` finalizer warning.
- Final gates: `npm run build:check`; focused HTML/WebGPU Vitest (`125` tests);
  complete WebGPU Vitest (`81` files, `1181` tests); all WebGPU Node tests
  (`109` tests); changed-file ESLint; `npm run build:development`; ordinary
  artifact verification with AC-3 disabled; and `git diff --check`.

## 12. Definition of final completion

The project is complete only when all claimed codec/profile/container/audio
routes have passing manifest cases and Jellyfin negotiation evidence; HDR/DV
routes have exact production readback authorization; ordinary playback and all
fallbacks are correct; lifecycle, startup, long-play, and retention gates pass;
the `VideoSample` ownership defect is closed; shipped decoder licensing and
artifact obligations are reviewed; and the required browser/GPU matrix passes
with source feature flags enabled only by an intentional rollout decision.
