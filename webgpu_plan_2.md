# WebGPU Player Plan 2

- Status: active implementation plan
- Recorded: 2026-08-03
- Branch: `webgpu-player`
- Parent checkpoint: `0a9b489bd4249e5c6b0276f088c68bf6b19ef12c`
- Current state: the JPEG 2000, progressive MPEG-2 Matroska, DTS, TrueHD/MLP,
  downmix, artifact-provenance, HDR, normalization, no-bitrate High Tier,
  unified-validation, dynamic-HDR, generalized-audio, hardware-matrix,
  persistent-player-preference, and exact Profile 7 HDR10-base checkpoints are
  committed and pushed. The current integration adds owned ASS/SSA and PGS
  custom-clock subtitle surfaces, target-neutral bounded audio sample-rate
  negotiation, stereo E-AC-3 authorization, exact unsupported-video routing to
  the HTML player, Matroska DTS timestamp-quantization correction, and terminal
  fallback containment. Current-host evidence remains fail-closed for Chrome
  retention and unresolved for Edge live custom-playback entry; AMD and Intel
  were not available. Per-route real-media qualification and long-run resource
  validation remain before a general rollout.
- Authoritative current integration runtime: Jellyfin 12 nightly serving this
  repository's current built bundle on port 8096. Jellyfin 10.11.6 evidence in
  sections explicitly labeled historical does not qualify the current worktree.

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
3. Reconstruct HDR10, supported HEVC HDR10+, HLG, and supported Dolby Vision
   profiles before applying configurable WebGPU tone and gamut mapping.
4. Preserve the existing HTML player as a permanent whole-session fallback.
5. Fall back without recursion, duplicate reporting, stale callbacks, or an
   unbounded resource queue.
6. Keep all internal media time in signed integer microseconds.
7. Ship with reproducible capability, conformance, integration, performance,
   fault-injection, and soak validation.

For WebGPU playback, source, container, audio, and video bitrate are telemetry
only. They must never select DirectPlay versus DirectStream/transcode, native
versus bundled decode, HDR presentation route, or decoded output format.
Capability gating uses explicit codec/profile/tier/level, decoded geometry and
format, measured decode throughput, memory bounds, and exact presentation
authorization. A saved network bitrate may size an encoded output only after a
bitrate-free request has already fixed the session to transcode.

Decoded audio uses one source-rate rule rather than a list of common rates:
every safe integer from 3000 through 192000 Hz may enter the shared resampler.
The source codec, container, profile, and channel layout still require a
supported route, ordinary Mediabunny/WebCodecs tracks still run their exact
`canDecode()` check, bundled decoders still validate their actual output, and
all decoded-PCM output remains 48 kHz. Encoded audio bitrate never participates
in any of these decisions. The separate native AC-3/E-AC-3 MSE bridge remains
exactly 48 kHz because that is the qualified encoded-media route.

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
- Runtime-gated stereo, 5.1, or 7.1 decoded-PCM AudioWorklet output with complete
  bed requirements, deterministic stereo downmix fallback, bounded audio queues,
  underflow recovery, and A/V clock telemetry.
- Owned native-media MSE bridge for exactly qualified AC-3/E-AC-3 routes.
- Official Mediabunny AC-3/E-AC-3 software decode in ordinary builds.
- SDR identity, BT.2020 PQ, and BT.2020 HLG color paths.
- Renderer settings version 7, retaining the version 6 libplacebo-derived static
  spline tone mapping in IPTPQc4 and adding bounded per-frame HEVC HDR10+
  controls. Static processing is shared by
  external HDR, raw HDR, and Dolby Vision routes, with libplacebo-compatible PQ
  and SDR black points plus bounded analytic perceptual BT.709 chroma
  compression. This does not claim exact equivalence to libplacebo's generated
  3D gamut LUT.
- Bounded HEVC mastering-display and content-light SEI extraction from up to 16
  startup access units, validated propagation through the custom
  worker/session/controller boundary, and source-peak application before the
  first ordinary PQ frame.
- Bounded HEVC prefix/suffix SEI parsing for HDR10+ ST 2094-40 application
  version 0/1 with one whole-frame window, exact-PTS metadata propagation, and
  frame-local static HDR10 fallback for absent, malformed, conflicting, or
  unsupported dynamic metadata.
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

The new output and metadata routes are implemented but remain disabled by the
source feature flags. Native 5.1/7.1 requires physical speaker qualification,
HDR10+ requires real-media mpv/libplacebo temporal comparison, and the complete
hardware release matrix has not passed. See `WEBGPU_AUDIO_MULTICHANNEL.md`,
`WEBGPU_DYNAMIC_HDR.md`, and `WEBGPU_HARDWARE_MATRIX.md`.

### 2.2 Latest committed PCM normalization checkpoint

- Mediabunny built-in decode for signed/unsigned integer PCM, float PCM, mu-law,
  and A-law across each exact container mapping exposed by Mediabunny.
- One explicit mono/stereo/5.1-side channel-layout model and shared stereo
  mixer, replacing per-codec count-only branching.
- One bounded 64-tap, 2048-phase Blackman-windowed sinc streaming resampler for
  every integer source rate from 3 through 192 kHz into 48 kHz output.
- Signed-microsecond source/output timestamp accounting, bounded resampler
  history, bounded worker chunks, exact audio credits, and final filter flush.
- Exact eligibility and device-profile claims for supported PCM codec,
  container, and channel-count combinations plus the shared bounded source-rate
  contract.
- Source/output audio-shape telemetry and browser-harness assertions.
- Unit round trips through Mediabunny's public MOV writer, demuxer, track probe,
  and `AudioSampleSink` for all fourteen supported PCM/G.711 codec identifiers.
- A deterministic AAC-to-PCM switch fixture and clean port-8096 lifecycle run.

The checkpoint passed its production build/artifact gate, final diff review,
documentation reconciliation, commit, and push. The current integration
supersedes that checkpoint's discrete sample-rate list with the shared bounded
contract. DVD/BD LPCM framing and 7.1/arbitrary input layouts remain separate
follow-up work rather than hidden claims.

### 2.2.1 Current volume and user-normalization slice

- Jellyfin slider strings and numeric API values are normalized at the player
  boundary, validated from 0 through 100, and sent numerically to the HTML
  backend plus cubically to the active custom controller.
- `TrackGain`, `AlbumGain`, and `Off` follow `HtmlAudioPlayer` metadata
  precedence. Their linear multiplier remains independent from slider volume
  and mute and is exposed in bounded telemetry.
- Decoded PCM can apply gain above unity. Owned native-media AC-3/E-AC-3 caps
  the combined value at one because `HTMLMediaElement.volume` cannot amplify.
- Every custom-audio browser lifecycle now changes volume using a slider-shaped
  string, verifies the cubic value and invariant normalization gain, toggles
  mute, and restores the original state.
- Normalization remains metadata driven. Jellyfin's stock LUFS task populates
  audio-library items, not ordinary movie/video items; a sanitized live catalog
  probe confirmed that the current video items expose no track or album gain.
  Those sessions intentionally use unity and are not evidence of normalized
  movie loudness.
- The portable High Tier regression now has a generated 12-second 4K24 PQ
  Main10 Level 5.1 Matroska/FLAC source. Generation verifies the SPS high-tier
  bit directly, injects valid 4000-nit static metadata, and emits a path-free,
  bitrate-free live record. Its Jellyfin 12/Chrome 151 lifecycle passed native
  external-HDR DirectPlay, decoded FLAC, server-log, volume, and privacy gates.

### 2.3 Current JPEG 2000 and MPEG-2 slice

- Pinned OpenJPEG WASM decodes only exact Mediabunny `mjp2` packets from `MJ2`
  or QuickTime `MOV`. The advertised route is progressive unsigned 8-bit
  sRGB/gray, at most 960x540 and 24 fps, with an exact RGBA fingerprint and at
  least 30 decode/output fps.
- A focused MPEG-2-only FFmpeg WASM decoder consumes Mediabunny Matroska
  `V_MPEG2` packets. The advertised route is Main Profile, progressive 8-bit
  SDR, at most 1920x1080 and 24 fps, with exact reordered I420 output and at
  least 30 fps.
- VC-1 and WMV3 are not implemented. MPEG-2 interlace, non-Main profiles,
  TS/MTS/M2TS, PS/VOB, MOV, MP4, and every non-Matroska MPEG-2 route are not
  advertised.
- Both routes use the existing generation-safe worker credits, owned
  `VideoFrame` transfer, WebGPU presentation, and fallback contract.

### 2.4 Current DTS slice

- Pinned LGPL-2.1-or-later libdcadec codec-only WebAssembly, reproducible with
  Emscripten 4.0.13 and distributed with exact source/license/revision artifacts.
- Exact output and throughput qualification for Core, 96/24, ES, DTS-HD HRA,
  DTS-HD MA at 48/96 kHz, and 16-bit 5.1 DTS-HD MA at 192 kHz.
- Sample-exact public-domain MA reference comparison plus exact WAVE-mask
  mappings for stereo, 5.1-back/side, 6.1, and 7.1.
- Deterministic 7.1 WAVE-extensible corpus at 48/96 kHz, byte-identical pinned
  mpv/FFmpeg external references, and exact DTS HRA/MA downmix fingerprints. The
  selected bounded matrix is explicitly mpv's opt-in normalized policy; the
  default matrix remains documented as an overload-prone counterfactual.
- Mediabunny Matroska `A_DTS` packet integration into one owned worker decoder,
  shared downmix/resampler, bounded credits, AudioWorklet, and clock path.
- Fail-closed capability, eligibility, and device-profile claims limited to MKV
  and the profile/layout pairs proven by the seven fixtures. Each pair accepts
  the shared 3000-192000 Hz integer source-rate contract; above 96 kHz only a
  5.1 MA or MA+DTS:X bed is admitted.
- DTS-HD MA carrying DTS:X is explicitly channel-bed-only. Object rendering and
  passthrough are false and must not appear as supported in UI or telemetry.
- MPEG-TS/M2TS remains unadvertised because Mediabunny 1.52.2 drops Blu-ray DTS
  PMT stream types before track creation. `WEBGPU_DTS.md` records the exact
  completion procedure.

### 2.5 Current TrueHD/MLP slice

- Pinned FFmpeg `libavcodec` TrueHD/MLP-only WebAssembly, configured as
  LGPL-2.1-or-later with GPL, version-3, and nonfree code disabled and shipped
  with exact source, license, revision, and runtime-hash artifacts.
- Mediabunny remains the Matroska demux, range, track, packet, timestamp, and
  seek layer. `A_TRUEHD` and `A_MLP` packets feed one owned focused decoder.
- Exact deterministic 24-bit PCM fingerprints cover TrueHD stereo 48 kHz,
  TrueHD 5.1-side 96/192 kHz, and MLP stereo 48 kHz. The runtime probe also
  requires major-sync recovery and at least 2x real-time decode throughput.
- The qualified route accepts only Matroska, TrueHD stereo/5.1, and MLP stereo.
  The four exact rate fixtures validate the decoder and layout families rather
  than forming a sample-rate whitelist; supported pairs use the shared
  3000-192000 Hz integer contract. The route performs one second of seek
  preroll, then discards PCM before the requested signed-microsecond boundary.
- Atmos metadata may be detected, but output is explicitly the lossless
  channel bed only. Object rendering and compressed passthrough are false.
- Eight-channel decode plumbing exists, but it is not advertised because
  FFmpeg's clean synthetic TrueHD encoder cannot generate a 7.1 qualification
  source. M2TS and 7.1 remain fail-closed pending exact fixtures and demux proof.

### 2.6 Integration evidence

These measurements combine earlier baselines with current checkpoint evidence.
They qualify only the exact route stated and are not portable capability claims:

- The current headless Chrome run measured native 4K HEVC Main10 at about
  55.9 fps and qualified its conservative 30 fps tier.
- Bundled 4K HEVC Main10 measured about 29.9 fps and correctly failed the 30
  fps qualification floor with required headroom.
- Bundled 1080p Main10 measured about 125.7 fps and had sufficient 60 fps
  headroom.
- A 44.1 kHz mono signed 24-bit PCM track decoded through Mediabunny, normalized
  to stereo 48 kHz, survived pause/resume, fullscreen, resize/DPR, a primary
  seek, a three-seek storm, and exact stop with no fallback or browser errors.
- Manual playback quality was reported as excellent.
- Earlier Dolby Vision Playback Info screenshots still showed HLS transcoding,
  so those screenshots validate presentation quality, not owned DirectPlay.
- The local High Tier HDR10 regression source is a progressive HEVC Main10 High Tier
  Level 153 HDR10 stream at 3840x2160 and 23.976025 fps with selected stereo
  48 kHz 24-bit FLAC. Its source bitrate is recorded only as telemetry. The
  port-8096 acceptance smoke now selects the original custom DirectPlay route,
  native `VideoFrame` decode, external PQ presentation, and decoded FLAC with no
  fallback or runtime error.
- The current production bundle is served by Jellyfin 12 nightly itself on port
  8096; the separate 8080 development frontend is not used for authoritative
  tests.
- Chrome 151 exposed that external-texture quantization can be amplified by the
  version 6 Profile 5 tone/gamut path. Authorization fixture version 2 now first
  requires the recovered 10-bit base signal to remain within 8/1023 per channel,
  then drives the CPU output reference from that measured signal without widening
  the existing 8/255 output tolerance. The exact route authorized with maximum
  normalized input/output errors of 0.00497875 and 0.00253959 respectively in
  the recorded renderer-settings-version-6 live matrix. Renderer settings
  version 7 retains that static path and adds frame-local HDR10+ state.
- The ordinary CDP browser smoke now applies the same request-scoped WebGPU flag
  overlay as startup comparison and mpv A/B capture. A live Chrome 151 high-tier
  HDR10 custom DirectPlay run passed with the exact Profile 5 fixture-version-2
  telemetry above, external PQ authorization, decoded FLAC, and no fallback or
  browser error while source feature flags remained disabled.
- The final production checkpoint passed a two-session replay and one injected
  device-loss recovery. The device was replaced exactly once without fallback,
  playback restart, browser errors, or an observed `VideoSample` ownership
  warning.

### 2.7 Global restrictions

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
- Decoded PCM remains 48 kHz. Complete 5.1 and 7.1 beds may retain six and eight
  channels only when the exact playback `AudioContext` destination exposes the
  full count; otherwise the existing qualified stereo downmix is used. There is
  no partial 7.1-to-5.1 route. All decoded routes accept integer source rates
  from 3000 through 192000 Hz after their independent codec, container,
  profile, layout, and decoder checks pass. DTS retains its fixture-derived
  profile/layout pairs and the stricter above-96-kHz 5.1 MA rule; TrueHD retains
  stereo/5.1 and MLP retains stereo. The native AC-3/E-AC-3 MSE bridge remains
  exactly 48 kHz.
- Playback rate other than 1.0 is rejected while custom decoded audio is active.
- PiP, AirPlay, Remote Playback, DRM, and SyncPlay rate control are not claimed
  for custom decode.
- Subtitles remain on Jellyfin's existing DOM/HTML surface. Custom-decode
  subtitle selection and timing still require full end-to-end qualification.
- The source and all selected tracks must satisfy one implemented container rule.
- Feature flags remain disabled in source `src/config.json`.

### 2.8 Known `VideoSample` ownership defect

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

### 2.9 Mediabunny-first decoder and container policy

Mediabunny core and official Mediabunny decoder extensions are approved project
dependencies. Their licensing review is complete. Use them by default whenever
they provide the required container, decoder, sample format, and lifecycle:

1. Use Mediabunny for every supported container/input instead of duplicating its
   demux, range, packet, track, timestamp, and seek implementation.
2. Use Mediabunny's ordinary sample sinks for native WebCodecs decode when their
   output and ownership contract satisfies the route.
3. Prefer an official Mediabunny custom decoder extension over a project-local
   decoder adapter. Use `@mediabunny/ac3` in ordinary builds. ProRes is
   explicitly skipped by current product direction; do not add
   `@mediabunny/prores` or schedule ProRes work without a new user decision.
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

### 2.10 P0 acceptance target: High Tier HDR10 direct playback

The first local real-media gate is a private UHD High Tier HDR10 source.
Its Jellyfin item ID belongs in a private harness manifest, not this portable
plan. Its relevant source contract is:

| Field | Required value |
| --- | --- |
| Container/source | MKV VOD, 69,007,285,982 bytes, HTTP byte-range input |
| Video | HEVC Main10, High Tier (`general_tier_flag=1`), Level 153 |
| Geometry/rate | 3840x2160 progressive, 23.976025 fps |
| Video bitrate | 60,451,462 bit/s; 73,683,537 bit/s total source bitrate |
| Pixel/color | 10-bit 4:2:0, limited BT.2020 non-constant, PQ, HDR10 |
| Initial audio | FLAC, stereo, 48 kHz, 24-bit, 1,372,791 bit/s |
| Deferred tracks | DTS-HD MA alternatives and PGS subtitles are not required for the first video/FLAC gate |

The bitstream is explicitly High Tier Level 5.1 because its SPS reports
`general_tier_flag=1`; this is not inferred from bitrate. Source bitrate is not
a decoder capability dimension and is not present in custom eligibility or the
augmented Jellyfin profile. The player strips Jellyfin global, container, video,
and audio bitrate constraints, and the first PlaybackInfo request omits the
saved network limit. The exact real-title stream itself now provides runtime
evidence that the current Chrome/device route accepts this configuration. A
small deterministic High Tier fixture remains useful for portable regression,
but it cannot authorize support by comparing source bitrate with a threshold.

The final negotiation failure was unrelated to decoder speed: Jellyfin combines
conditions from every applicable codec profile. Advertising the narrower raw
HDR route beside the valid native external-HDR route therefore contaminated the
native 4K result with raw-route 1080p limits. Item-scoped negotiation now prefers
the authorized external route and exposes raw HDR only when that route is
unavailable.

Acceptance requires all of the following on `http://localhost:8096`:

1. PlaybackInfo reports `WebGPU Video Player (Direct Play)` and no HLS target,
   FFmpeg transcode, or level/resolution/bitrate transcode reason.
2. Network evidence shows range reads from the original MKV source rather than
   generated HLS playlists or fragments.
3. Telemetry identifies the source's explicit HEVC High Tier/Level fields, the
   runtime-qualified native decoder, authorized external PQ presentation, and
   owned FLAC decode/audio output.
4. Start, pause/resume, representative seeks, a three-seek storm, fullscreen,
   resize/DPR, explicit stop, replay, and natural EOF preserve one session and
   bounded queues with no fallback or duplicate events.
5. Representative IMAX and 2.39:1 geometry changes preserve crop/aspect and do
   not resize the decoded surface incorrectly.
6. Console, runtime exception, worker retirement, frame ownership, dropped or
   corrupt frame, A/V drift, and retained-resource checks remain clean.
7. Bundled HEVC, SDR, Dolby Vision, and generated PQ/HLG routes retain their
   explicit format, geometry, level, frame-rate, throughput, and presentation
   constraints and pass regression tests.

### 2.11 Current Profile 7 and FLAC negotiation checkpoint

Dolby Vision Profile 7 with base-layer signal compatibility ID 6 has an HDR10-
compatible base. Item-scoped negotiation now exposes that base through the
independently qualified native HEVC/external-PQ route when the full raw Dolby
Vision route cannot accept the source geometry, level, or frame rate. The
fallback additionally requires exact limited-range BT.2020 non-constant/PQ
metadata and the exact external-PQ device authorization. Full Profile 7
reconstruction remains preferred whenever its raw-output route accepts the
source; this fallback does not widen the measured raw route.

The base route strips RPU and enhancement NAL units before native decode, does
not start the enhancement decoder or invoke the RPU parser, and presents the
same playback session through the ordinary static-HDR pipeline. Static
mastering-display/content-light metadata may still update the tone-mapping
peak. Profile 5 and non-HDR10-compatible Profile 8 signals cannot enter this
route.

Compatibility ID 6 is currently a fail-closed metadata-integrity requirement,
not a decode-performance requirement. Profile 7 is defined around an HDR10-
compatible base, so this exact container/API field may be redundant for a valid
bitstream and may reject an otherwise usable remux when the field is merely
absent. A future widening may accept missing or noncanonical compatibility
metadata only after an encoded-source preflight independently proves the
Profile 7 BL/EL/RPU topology and the base layer's 10-bit limited BT.2020 non-
constant/PQ signaling. Explicitly contradictory compatibility or color metadata
must remain rejected. The `.6` shown in a `Profile 7.6` UI label is the Dolby
Vision level and must not be mistaken for this separate compatibility field.

Custom decoded-PCM profile splitting now removes inherited HTML-player
`AudioBitDepth` constraints alongside inherited channel, sample-rate, and
secondary-track constraints. The original restrictions remain attached to
non-custom containers. Stereo FLAC regression coverage includes source bit
depth metadata of 8, 16, 20, 24, and 32 bits; representative and unusual rates
from 3000 through 192000 Hz; and missing through extreme encoded bitrates.
Only rates outside the bounded source-rate contract are rejected by these
generic rules, while the exact track decoder check remains authoritative.

Five focused suites pass 440 tests for the Profile 7 and audio negotiation
changes. A user-deployed Jellyfin 12 nightly bundle has been reported as
playing successfully. That is a manual smoke result; exact client/server
DirectPlay, selected presentation route, server-log, lifecycle, and mpv frame
evidence remain required before this checkpoint becomes release qualification.

### 2.12 Current subtitle, selection, and failure-containment checkpoint

The current worktree closes four defects exposed by the library-title matrix:

1. Custom sessions now drive owned ASS/SSA and PGS canvases from Jellyfin's
   playback clock. Play, pause, wait, seek, offset, selection, aspect, resize,
   stop, destroy, and generation retirement are covered by focused tests. The
   existing DOM VTT surface and ordinary HTML renderer paths remain intact.
2. External VTT, ASS/SSA, and PGS device claims are rebuilt from the renderers
   available to the custom runtime. Server Encode profiles are preserved,
   unsupported External entries are removed, duplicates are collapsed, and
   retry negotiation remains conservative. This removes the obsolete
   dependency on the HTML player's experimental PGS user checkbox.
3. Bounded decoded-audio profiles no longer turn their upper source-rate bound
   into a 192 kHz AAC transcode target. The normal profile is target-neutral,
   complementary profiles reject rates outside 3000-192000 Hz, and stereo
   48 kHz E-AC-3 is explicitly authorized through the bundled decoder.
4. Complete item metadata routes known unsupported video to the separately
   registered HTML player before negotiation. VC-1, interlaced or
   out-of-envelope MPEG-2, and AV1 Main10 SDR are current regression cases.
   Missing initial metadata is left undecided until the exact negotiated-source
   gate rather than guessed from bitrate or title characteristics.

Archer exposed 512-frame DTS packets at 48 kHz whose Matroska PTS values follow
the millisecond-quantized sequence `0, 10000, 21000, 31000, 42000, 53000`
microseconds instead of retaining every fractional 10.666... ms boundary. The
resampler now accepts at most 1 ms of container quantization plus one source
sample, records the correction, and emits the exact sample-count timeline. A
missing access unit remains well outside that envelope and still fails. On any
real terminal failure, custom decode/audio is retired before one source retry;
a partially started HTML fallback is stopped before its error is exposed, and
stale errors cannot leave background audio or start a duplicate session.

These routes are implemented but not live-qualified. The next manual gate must
capture Fight Club PGS output, Infinity Train stereo E-AC-3, HTML selection for
the AV1 Main10 SDR/VC-1/interlaced MPEG-2 examples, and Archer DTS playback.
Archer passes only if it remains on the playback page with one session, no
resampler discontinuity, no duplicate HLS request, and no background audio.

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
| HEVC Main, 8-bit 4:2:0 SDR | Native WebCodecs, or exact-tier `@hevcjs/core` fallback -> `VideoFrame` -> WebGPU | Native 1080p plus a separate exact 3840x2160 tier. Bundled Main is constrained to 1920x1080, Level 120, qualified frame rate, and a passing throughput/fingerprint probe. | Implemented and runtime-gated. Source bitrate is not a route constraint. Bundled distribution still requires HEVC patent/jurisdiction review. |
| HEVC Main10, 10-bit 4:2:0 PQ/HLG | Native `VideoFrame.copyTo()` or bundled decoder -> I420P10 -> raw YUV WebGPU HDR pipeline | Raw capability is probed at 3840x2160 and assigned only a measured 24/30/60 fps tier with 1.25x headroom. Bundled tiers retain independent geometry, level, output-fingerprint, and throughput bounds. | Implemented and runtime-gated. A slow bundled 4K decoder is correctly rejected without consulting source bitrate. |
| HEVC Main10, 10-bit 4:2:0 PQ/HLG through `GPUExternalTexture` | Owned native decoder with SPS/HVCC color neutralization -> external texture -> code-value recovery shader -> HDR pipeline | 3840x2160, Level 153, and a measured 24/30/60 fps tier. Exact PQ or HLG fixture authorization is scoped to device, target format, and route. | Implemented and live-qualified on generated PQ/HLG fixtures and a local High Tier HDR10 regression source. |
| Dolby Vision Profile 5 | HEVC BL decode + libdovi RPU parse/reconstruction; raw-plane route and an independently authorized native external-texture route | Up to the exact measured native/bundled HEVC and presentation limits. Every selected frame requires matching RPU metadata. | Implemented, fail-closed, and route-authorized. One private 4K real title passes DirectPlay lifecycle plus active/paused device-loss recovery with decoded 5.1 E-AC-3. Broader title/browser/GPU validation remains. No Dolby certification or passthrough is claimed. |
| Dolby Vision Profile 7 MEL | HEVC base-layer decode + RPU reconstruction on the HDR10-compatible BL | Raw I420P10 route with exact device authorization. | Implemented. Must expand end-to-end disc/container and fallback coverage. |
| Dolby Vision Profile 7 HDR10-compatible base | Strip RPU/EL NAL units -> owned native HEVC decode -> external PQ recovery -> static HDR WebGPU pipeline | Exact Profile 7 compatibility-ID-6 descriptor with limited BT.2020 non-constant/PQ metadata, native HDR HEVC capability, and exact external-PQ authorization. Full raw Profile 7 remains preferred inside its independently measured envelope. | Implemented and fail-closed. It prevents weaker raw-Dolby-Vision caps from forcing server transcode for a valid higher-tier HDR10 base. Structured real-title DirectPlay and mpv comparison evidence remain. |
| Dolby Vision Profile 7 FEL | BL and EL decode, exact-PTS pairing, LINEAR_DZ residual composition, then WebGPU tone mapping | Implemented for qualified interleaved EL, Matroska `hvcE`/separate-track, legacy dual-track ISO BMFF, and separate-PID MPEG-TS/M2TS discovery routes. | Partial product qualification. The exact native HDR10-base route is the bounded degradation path when full reconstruction is outside its measured envelope. Dual-decoder performance, BDMV demux behavior, malformed topologies, real-title coverage, and sustained ownership/soak evidence remain. |
| Dolby Vision Profile 8.x | HEVC BL decode + RPU reconstruction; verified HDR10 or HLG-compatible base fallback where applicable | Raw I420P10 route under the applicable exact authorization. | Implemented for supported single-layer descriptors. Expand the Profile 8.1/8.4 and malformed-metadata matrix before release. |
| VP8, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact output at up to the ordinary 1920x1080 envelope. | Implemented and runtime-gated. No Ultra HD or higher-bit-depth route. |
| VP9 Profile 0, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact 1080p output plus independent 3840x2160 output qualification. | Implemented and runtime-gated. |
| VP9 Profile 2, 10-bit 4:2:0 PQ/HLG | Native WebCodecs -> exact `copyTo()` fingerprint -> I420P10 WebGPU | Exact 3840x2160 raw-output probe and measured 24/30/60 fps tier. | Implemented and runtime-gated. Profiles 1/3 and 12-bit are not supported. |
| AV1 Main, 8-bit 4:2:0 SDR | Native WebCodecs -> `VideoFrame` -> WebGPU | Exact 1080p output plus independent 3840x2160 output qualification. | Implemented and runtime-gated. |
| AV1 Main, 10-bit 4:2:0 PQ/HLG | Native WebCodecs -> exact `copyTo()` fingerprint -> I420P10 WebGPU | Exact 3840x2160 raw-output probe and measured 24/30/60 fps tier. | Implemented and runtime-gated. High/Professional, 12-bit, 4:2:2, and 4:4:4 are not supported. |
| MPEG-2 Video Main, 8-bit progressive SDR | Mediabunny unknown Matroska track/packets -> focused MPEG-2-only FFmpeg `libavcodec` WASM -> owned I420 `VideoSample` -> `VideoFrame` -> WebGPU | Exact Matroska, Main Profile, progressive 1920x1080 at up to 24 fps. Runtime must reproduce all 12 reordered qualification frames, 37,324,800 decoded bytes, and the aggregate I420 fingerprint while sustaining at least 30 fps. | Implemented and fail-closed. Source bitrate is irrelevant. Interlaced content, MPEG-TS/M2TS, MPEG-PS/VOB, MPEG-1, non-Main profiles, and dimensions/frame rates above the qualified tier are explicitly out of scope. |
| JPEG 2000 Part 1, 8-bit progressive sRGB/gray | Mediabunny `mjp2` packets -> pinned OpenJPEG WASM -> owned RGBA `VideoFrame` -> WebGPU | Exact `MJ2`/`MOV`, 960x540, 24 fps route. Runtime must reproduce the qualification RGBA fingerprint and sustain at least 30 decode/output fps. | Implemented and fail-closed. Source bitrate is irrelevant. High bit depth, HDR/XYZ, DCI 2K/4K, MXF, JPX/HTJ2K, alpha, non-zero origins/crops, and ambiguous component/color layouts remain unsupported. See `WEBGPU_JPEG2000.md`. |

### 4.2 Decoded video output-format roadmap

Consumer Blu-ray, UHD Blu-ray, and HDR web delivery are overwhelmingly 4:2:0.
The existing renderer accepts `I420`, `NV12`, `I420P10`, and `I420P12`, while
the custom worker/session negotiation currently exposes only `I420P10` and
`I420P12`, and the production HDR capability model qualifies only `I420P10`.
The immediate consumer gaps are therefore route negotiation and codecs, not a
missing UHD/HDR pixel layout.

| Format family | Typical sources | Current state | Priority and procedure |
| --- | --- | --- | --- |
| `I420`, 8-bit planar 4:2:0 | Blu-ray AVC/MPEG-2, DVD, legacy web | Copy, layout validation, buffer pooling, and GPU rendering exist. The focused MPEG-2 decoder now emits owned I420 `VideoSample` objects through the `VideoFrame` route; ordinary software-decoder worker negotiation still does not expose I420 as a reusable raw route. | **P1 shared infrastructure.** Retain the qualified MPEG-2 path. Add a general raw I420 contract only when another in-scope decoder needs it; do not expand MPEG-2 beyond the qualified progressive Matroska route. |
| `NV12`, 8-bit semiplanar 4:2:0 | Native browser/OS decoder surfaces | Copy and rendering exist, but it is not a negotiated custom decode output. | **P1 optimization.** Add only when a backend can supply it without an extra conversion and measurements show lower copy/upload cost than I420 or external texture. |
| `I420P10`, 10-bit planar 4:2:0 | UHD Blu-ray HEVC Main10, HDR10/HDR10+, Dolby Vision layers, HDR VP9/AV1 | Implemented and production-qualified for exact native/bundled HDR routes. | **P0 hardening.** A local High Tier Level 153 HDR10 route passes without a bitrate cap. Add a compact deterministic High Tier fixture, then expand real-title, peak-throughput, crop, ownership, and soak evidence without changing the format. |
| `I420P12`, 12-bit planar 4:2:0 | Rare VP9 Profile 2, HEVC Main12, AV1 Professional | Layout/copy/render plumbing exists, but no production codec capability authorizes it. | **P1.** Add exact native or bundled 12-bit fixtures, fingerprints, shader readback, throughput tiers, and profile constraints before advertising it. |
| `I422`, `I422P10`, `I422P12` | H.264 High 4:2:2, HEVC 4:2:2, cameras and mezzanine/archive media | Not implemented. Not required for ordinary Blu-ray or HDR streaming. | **P1 shared expansion.** Add structured plane geometry, odd-dimension rules, aligned buffer sizing, transfer validation, two-axis chroma reconstruction, chroma siting, GPU upload, fingerprints, and SDR/HDR readback once for every codec. |
| `I444`, `I444P10`, `I444P12` | VP9 Profiles 1/3, AV1 High/Professional, H.264/HEVC 4:4:4, screen/archive media | Not implemented. Not required for ordinary Blu-ray or HDR streaming. | **P1 after 4:2:2.** Reuse the generalized chroma path with full-resolution U/V planes, exact range/matrix handling, memory ceilings, fingerprints, and per-codec qualification. |
| `P010`-style 10-bit semiplanar 4:2:0 | Native Windows/GPU decode surfaces | Not represented by the raw-frame protocol; current WebCodecs paths can request I420P10 or keep an external `VideoFrame`. | **P1 optimization, not a coverage gate.** Add only for a backend that exposes stable P010 semantics and only if avoiding planar conversion materially improves 4K throughput or power. Define bit packing explicitly and never infer it from a null `VideoFrame.format`. |
| `I420A`/`I422A`/`I444A` and 10/12-bit alpha variants | Transparent professional/graphics media | Not implemented. | **P2.** Add a separately pooled alpha plane, straight-versus-premultiplied policy, blend pipeline, exact compositing references, and memory limits only after a supported codec requires it. |
| Packed YUV (`YUY2`, `UYVY`, `v210`) | Capture, broadcast, and professional archives | Not implemented. | **P2 adapter formats.** Prefer one bounded conversion into the canonical planar contract. Add direct GPU sampling only if profiling proves the conversion is a bottleneck. |
| RGB/RGBA/BGRA and float RGB | RGB codecs, lossless graphics, intermediate processing | External `VideoFrame` presentation may handle browser-owned RGB, but no raw custom route exists. | **P2.** Keep decoded YUV canonical for consumer media. Add explicit RGB routes only for a decoder that cannot provide YUV; distinguish decoded input from the existing `rgba16float` internal render target. |

Implementation order is fixed to minimize duplicated code:

1. Keep `I420P10` as the consumer UHD/HDR route and retain the completed High
   Tier title acceptance in section 2.10 as a regression gate.
2. Keep the qualified MPEG-2 `VideoSample` route as the exact I420 decoder
   proof. General raw I420 is deferred until another approved codec requires
   it. Deinterlacing is not part of the MPEG-2 route and cannot widen it.
3. Generalize subsampling once for I422/P10/P12, then reuse that work for
   I444/P10/P12.
4. Add P010, alpha, packed YUV, or RGB only when a selected decoder supplies a
   concrete zero-copy or coverage benefit. Do not add speculative formats.

### 4.3 Unsupported video codecs and implementation procedures

Priority indicates implementation order, not a claim that every niche format is
required for the first release.

| Unsupported codec/profile | Priority | Procedure |
| --- | --- | --- |
| MPEG-2 Video expansion | Skipped | Keep only the implemented progressive Main Profile Matroska route. Do not add interlacing, deinterlacing, MPEG-TS/M2TS, MPEG-PS/VOB, MOV/MP4, or any other container in this checkpoint. |
| VC-1 and WMV3 | P0 legacy disc coverage | Not implemented and not present in the MPEG-2 artifact. First qualify a mature reviewed decoder and a bounded Mediabunny or equivalent Matroska packet route. Add exact Simple/Main/Advanced profile fixtures as applicable, decoded I420 output fingerprints, B-frame timestamp ordering, pulldown/interlace rejection, seek, malformed-stream, throughput, memory, and licensing evidence. Add M2TS or ASF only after separately qualifying those demux routes; never infer VC-1 support from MPEG-2. |
| MPEG-4 Part 2, including DivX/Xvid | P0 legacy library coverage | Add a bundled decoder adapter unless exact native output becomes available. Validate VOL/extradata, packed B-frames, decode-vs-presentation timestamp reordering, quarter-pixel/global-motion variants, and MP4/MKV carriage. Add AVI only after the demux layer has a bounded, tested AVI path. Qualify profile, decoded geometry/format, throughput, and memory bounds before profile widening. |
| H.264 High 10, High 4:2:2, High 4:4:4 | P1 advanced AVC | Add exact WebCodecs probes per profile/chroma/bit depth. If Chrome does not expose output, add a bundled decoder. Extend the raw-frame protocol, buffer pool, and shader from I420/I420P10 to required 10-bit 4:2:2 and 4:4:4 plane formats. Add chroma siting, range/matrix, crop, and throughput fixtures before advertising any profile. |
| HEVC Main12, Main 4:2:2 10/12, Main 4:4:4 8/10/12 | P1 advanced HEVC | Extend or replace the bundled HEVC backend only after decoder and patent review. Add I420P12 plus explicit 4:2:2/4:4:4 raw formats, row-stride validation, texture upload formats, chroma reconstruction shaders, exact output fingerprints, and per-profile tier probes. Add native probes independently; do not let Main10 evidence authorize these formats. |
| VP9 Profiles 1 and 3, 12-bit output | P1 advanced VP9 | Add exact profile codec strings and fixtures, then implement 4:2:2/4:4:4 and 12-bit raw plane formats. Require `copyTo()` fingerprints and GPU readback authorization for each distinct raw format. If raw values are inaccessible, keep the route unsupported unless an external-texture preservation test can prove exact reconstruction. |
| AV1 High/Professional, 12-bit, 4:2:2, 4:4:4 | P1 advanced AV1 | Follow the VP9 procedure with exact AV1 sequence-header/profile fixtures. Add raw formats and shader sampling once for all codecs, then bind AV1 to that shared implementation. Qualify film-grain behavior, crop, high-resolution memory pressure, and throughput. |
| Motion JPEG | P1 cameras/archives | Add exact native probes first. Otherwise adapt a reviewed decoder to the common frame contract. Implement full/limited range and common YUV/RGB sampling, orientation/crop, high-resolution intraframe throughput, and bounded allocation tests. Do not infer Motion JPEG support from the independent OpenJPEG route. |
| Theora | P1 open legacy media | Add Ogg demux/track mapping if Mediabunny cannot already supply exact packets, then add a reviewed software decoder adapter. Produce I420 frames, validate granule-position timestamp/seek behavior, add Ogg fixtures, and gate profile widening on output fingerprints and throughput. |
| ProRes | Skipped | Explicitly excluded by current product direction. Do not add `@mediabunny/prores`, raw-format work solely for ProRes, fixtures, or capability claims unless the user reverses this decision. |
| DNxHD/DNxHR | P2 professional media | Reuse the shared I422/I444 raw-format and upload work if later library demand justifies it. Add codec-specific extradata, profile/bit-depth mapping, MOV/MXF/MKV demux support as available, deterministic reference frames, and decoded-resolution/throughput/memory tiers. Do not use DNx as a reason to revive ProRes work. |
| VVC/H.266 | P2 emerging | Prefer a future exact native WebCodecs route. Otherwise select a SIMD/threaded WASM decoder only after license/patent review. Add VVC configuration-record and Annex B transforms, 10/12-bit and chroma formats, conformance streams, capability timeouts, and realistic 4K throughput gates. |
| AVS, AVS2, AVS3 | P2 regional/emerging | Add demux identifiers and extradata parsing, a reviewed decoder backend, exact profile/level fixtures, raw-format support, and measured tiers. Keep each generation independent because their bitstreams and licensing differ. |
| MPEG-1 Video, VP6, RealVideo | P2 long-tail legacy | Implement only from measured library demand. Each requires demux support, a reviewed software decoder, timestamp/seek conformance, exact output fingerprints, a bounded tier, and negative malformed-stream tests. Do not enlarge the central capability model until a complete route exists. |

### 4.4 Shared video-codec implementation procedure

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
| AAC-LC | Native WebCodecs -> planar float PCM -> AudioWorklet | Stereo or six-channel input at any integer 3000-192000 Hz rate accepted by the exact track decoder check. Complete 5.1 may retain six output channels when the playback destination exposes at least six; otherwise it uses the qualified stereo downmix. | Implemented and runtime-gated; physical speaker qualification remains. HE-AAC/xHE-AAC are not independently qualified. |
| Opus | Native WebCodecs -> PCM -> AudioWorklet | Stereo or six-channel input at any integer 3000-192000 Hz rate accepted by the exact track decoder check; complete 5.1 may retain six output channels, otherwise stereo. | Implemented and runtime-gated; physical speaker qualification remains. |
| FLAC | Native WebCodecs -> PCM -> AudioWorklet | Stereo or six-channel input at any integer 3000-192000 Hz rate accepted by the exact track decoder check; complete 5.1 may retain six output channels, otherwise stereo. Inherited HTML `AudioBitDepth` and encoded-bitrate ceilings do not constrain this custom PCM route; regression metadata covers 8/16/20/24/32-bit stereo FLAC. | Implemented and runtime-gated; physical speaker qualification remains. The actual decoder probe remains authoritative. This is the intended owned audio route for Main10 DirectPlay. |
| MP3 | Native WebCodecs -> PCM -> AudioWorklet | Stereo input at any integer 3000-192000 Hz rate accepted by the exact track decoder check. | Implemented and runtime-gated. Mono and surround remain rejected by layout policy. |
| Vorbis | Native WebCodecs -> PCM -> AudioWorklet | Stereo or six-channel input at any integer 3000-192000 Hz rate accepted by the exact track decoder check; complete 5.1 may retain six output channels, otherwise stereo. | Implemented and runtime-gated; physical speaker qualification remains. |
| AC-3 | Preferred exact-qualified native-media MSE bridge, otherwise Mediabunny `@mediabunny/ac3` software decode -> PCM | Native bridge probes 2/6 channels at exactly 48 kHz. Software stereo/5.1 accepts bounded 3000-192000 Hz source metadata only when the actual decoder configuration succeeds; complete 5.1 may retain six output channels, otherwise stereo. | Standard stereo route is automated, artifact, production-build, and port-8096 live qualified. Native availability varies; native decoded-PCM 5.1 needs physical qualification. |
| E-AC-3 | Preferred exact-qualified native-media MSE bridge, otherwise Mediabunny `@mediabunny/ac3` software decode -> PCM | Native bridge probes 2/6 channels at exactly 48 kHz. Software stereo/5.1 accepts bounded 3000-192000 Hz source metadata only when the actual decoder configuration succeeds; complete 5.1 may retain six output channels, otherwise stereo. | Standard stereo route is automated, artifact, production-build, and port-8096 live qualified. Dolby Atmos objects/passthrough remain unimplemented; native decoded-PCM 5.1 needs physical qualification. |
| DTS Core, 96/24, ES, DTS-HD HRA/MA | Mediabunny Matroska `A_DTS` demux -> pinned bounded `libdcadec` WebAssembly -> explicit layout/resampler -> AudioWorklet | Fixture-proven profile/layout pairs at integer 3000-192000 Hz source rates. Above 96 kHz only a 5.1 MA or MA+DTS:X bed is admitted. Complete 5.1/7.1 may retain the full output bed and otherwise falls back to stereo; DTS-ES 6.1 retains stereo. | Implemented and exact-probed for MKV; physical 5.1/7.1 speaker qualification remains. DTS-HD MA carrying DTS:X is channel-bed-only. DTS:X objects/passthrough are never claimed. TS/M2TS remains blocked because Mediabunny 1.52.2 does not surface Blu-ray DTS PMT stream types. See `WEBGPU_DTS.md`. |
| TrueHD/MLP | Mediabunny Matroska `A_TRUEHD`/`A_MLP` demux -> pinned TrueHD/MLP-only FFmpeg `libavcodec` WebAssembly -> exact WAVE layout/resampler -> AudioWorklet | TrueHD stereo/5.1 and MLP stereo at integer 3000-192000 Hz source rates. Four exact fixtures prove decoder/layout behavior; they are not a rate whitelist. Complete 5.1 may use six outputs, otherwise stereo. | Implemented and exact-probed for MKV; physical 5.1 speaker qualification remains. Atmos is decoded only as its lossless bed. 7.1 and M2TS remain unadvertised pending exact fixtures and bounded demux proof. See `WEBGPU_TRUEHD.md`. |
| PCM/G.711 | Mediabunny built-in PCM decoder -> explicit channel map -> streaming sinc resampler -> AudioWorklet | `pcm-s16`, `pcm-s16be`, `pcm-s24`, `pcm-s24be`, `pcm-s32`, `pcm-s32be`, `pcm-f32`, `pcm-f32be`, `pcm-f64`, `pcm-f64be`, `pcm-u8`, `pcm-s8`, `ulaw`, and `alaw`; mono/stereo/5.1-side; every integer 3000-192000 Hz source rate. Complete 5.1 may use six outputs, otherwise stereo. | Implemented and port-8096 live-qualified for mono/stereo output; physical 5.1 speaker qualification remains. Container claims are deliberately narrower than the decoder list. DVD/BD LPCM and 7.1 remain unsupported. |

### 5.2 Unsupported audio codecs and implementation procedures

| Unsupported codec/feature | Priority | Procedure |
| --- | --- | --- |
| Additional codec/profile/layout evidence within the bounded source-rate contract | P1 hardening | Do not restore per-rate whitelists. Add boundary and representative-rate decoder/output fixtures, confirm decoder-reported rate, delay, timestamp continuity, seek reset, PCM references, and CPU headroom, while keeping exact runtime decoder checks and the shared 3000-192000 Hz profile bound. |
| Additional 7.1 and arbitrary channel layouts | P0 shared expansion | Retain the implemented complete-bed runtime-gated Web Audio output. Extend non-DTS inputs beyond mono/stereo/5.1-side only with exact layout/remap, normalization, LFE, FFmpeg/mpv PCM, and physical speaker evidence. Never infer 7.1 support from destination channel count alone. Reuse this evidence for every codec. |
| DTS in MPEG-TS/M2TS | P0 disc-container completion | Extend Mediabunny upstream or integrate an equivalently bounded reviewed demux library for Blu-ray stream types `0x82`, `0x85`, and `0x86`. Require complete access units, signed-microsecond PTS, exact track metadata, 192/204-byte packet strides, PES/discontinuity handling, random seek, malformed PMT/PES tests, and Core/HRA/MA fixtures before adding DTS to TS/M2TS eligibility or device profiles. Reuse the implemented libdcadec/layout/resampler path unchanged. |
| TrueHD/MLP 7.1 and M2TS | P0 disc completion | Keep the implemented TrueHD stereo/5.1 and MLP stereo Matroska route unchanged. Obtain or generate a license-clean 7.1 TrueHD fixture, add exact PCM/layout/throughput evidence, and only then authorize eight channels. Extend Mediabunny or integrate an equivalently bounded reviewed M2TS packet route with major-sync, PES/discontinuity, random-seek, malformed-input, and timestamp tests before advertising disc containers. Dolby Atmos objects/passthrough remain a separate route. |
| ALAC | P1 Apple/lossless libraries | Probe future native WebCodecs exactly; otherwise add a small reviewed decoder. Implement MP4 magic-cookie/extradata mapping, 44.1-192 kHz and multichannel fixtures, resampling/layout integration, lossless PCM hashes, and seek tests. |
| DVD/BD LPCM | P0 disc-media completion | Keep the implemented Mediabunny PCM conversion and shared normalization stage. Add only the missing VOB/MPEG-PS and M2TS LPCM packet/framing adapters, explicit channel assignments, 16/20/24-bit references, 48/96/192 kHz cases, seek/discontinuity tests, and exact device-profile constraints. |
| WMA/WMAPRO/WMALOSSLESS | P1 legacy Windows libraries | Add ASF demux first, then a reviewed decoder adapter. Validate codec private data, block alignment, seek timestamps, common rates/layouts, PCM hashes, resampling, and malformed packet handling. |
| xHE-AAC, HE-AAC v1/v2 | P1 AAC completion | Add distinct AudioDecoder configurations and exact output fixtures, including SBR/PS sample-rate and channel expansion. Confirm timestamps and output rate rather than treating AAC-LC evidence as sufficient. Then add resampling/layout coverage and exact profile constraints. |
| Atmos, DTS:X, and bitstream passthrough | P2 output feature | First decide the browser output API and platform policy. Web Audio PCM does not preserve object metadata or compressed passthrough. Implement only behind an exact sink/output capability with user consent, latency/clock integration, exclusive-mode failure handling, and codec/legal review. Never label decoded E-AC-3 or TrueHD PCM as Atmos. |

## 6. Container and source support

| Container family | Current accepted video | Current accepted audio | Status/gaps |
| --- | --- | --- | --- |
| MP4/M4V | H.264, HEVC, VP8, VP9, AV1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3; signed 16/24/32-bit and float 32/64-bit PCM in both endiannesses | Implemented eligibility/profile rules, subject to exact codec/runtime probes. Add negative brand/extradata/edit-list tests. |
| MOV/QuickTime | H.264, HEVC, VP8, VP9, AV1 | MP4/M4V set plus unsigned/signed 8-bit PCM, mu-law, and A-law | Implemented with all fourteen Mediabunny PCM identifiers. Keep QuickTime-only codecs out of MP4 claims. |
| 3GP/3G2/MJ2 | H.264, HEVC, VP8, VP9, AV1 | Compressed ISO-base audio set only | Parser eligibility exists, but the custom device profile does not yet advertise these containers. Qualify brands, range/seek, and server negotiation before claiming DirectPlay. |
| MKV/Matroska | H.264, HEVC, VP8, VP9, AV1, progressive MPEG-2 Main | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3; fixture-proven DTS and TrueHD/MLP profile/layout pairs in section 5.1; U8, signed 16/24/32-bit LE/BE, F32LE, and F64LE PCM | Implemented; MPEG-2 is exact-probe-gated to progressive 8-bit Main at 1920x1080/24. DTS and TrueHD/MLP retain explicit profile/layout rules while using the common bounded source-rate contract. DTS:X and Atmos are channel-bed-only; object rendering and passthrough fail closed. Includes several Dolby Vision BL/EL topologies. Big-endian float, S8, and G.711 are intentionally not claimed for Matroska because Mediabunny does not map them there. |
| WebM | VP8, VP9, AV1 | Opus, Vorbis | Implemented and deliberately narrow. |
| TS/MTS/M2TS | H.264, HEVC | AAC, MP3, AC-3, E-AC-3 | Implemented for bounded VOD/range input; Profile 7 PID dependency discovery exists. Live transport streams remain unsupported. Expand discontinuity, wraparound, PAT/PMT change, and BDMV end-to-end tests. |
| AVI | None | None | Not implemented. Add demux, index/seek, timestamp, OpenDML, and malformed-chunk handling before enabling MPEG-4 Part 2/MJPEG/legacy audio. |
| ASF | None | None | Not implemented. Required before WMA/WMV coverage. |
| Ogg | Mediabunny container support exists; no currently supported Ogg video codec | Opus and Vorbis are available after eligibility/profile integration | Not enabled in custom eligibility. Reuse Mediabunny's Ogg reader and qualify range/seek/timestamp behavior; do not implement another Ogg demuxer. Theora still needs a decoder. |
| MPEG-PS/VOB | None | None | Not implemented. Required for broad MPEG-2/DVD coverage. |
| MXF | None | None | Not implemented. Consider only if later DNx or other professional-media demand justifies it; ProRes remains skipped. |
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
| Audio | Every implemented codec/profile/layout route at the 3000/192000 Hz boundaries and representative 8000/12345/44100/48000/96000 rates, plus 2999/192001 negatives; PCM/G.711 mono/stereo/5.1-side; native-media exact-48-kHz versus bounded decoded-PCM AC-3/E-AC-3; TrackGain/AlbumGain/Off, positive/negative/missing gain, numeric/string slider input, mute, and native-media amplification cap; all fixture-derived DTS profile/layout pairs including the 96000/96001 transition and DTS:X bed-only labels, MKV positives and TS/M2TS negatives; TrueHD stereo/5.1 and MLP stereo with major-sync recovery, seek preroll, Atmos bed-only labels, MKV positives and 7.1/TS/M2TS negatives; arbitrary encoded bitrates including missing and extreme values; audio-free video. |
| Network/source | Correct ranges; server ignores range; truncated response; retry; slow/chunked transfer; authentication; expired URL; redirect; 404/416; source replacement. |
| Lifecycle | Start, volume/mute/restore, pause/resume, single seek, seek storm, next item, repeat sessions, natural EOF/audio-tail drain, audio switch, subtitle switch, stop(false), stop(true), destroy, background/foreground. |
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

### 7.5.1 Implemented Group B foundation

The version 1 foundation now lives under `scripts/webgpu/validation/` and is
driven by `scripts/webgpu/validation_matrix.py`:

- checked manifest, overlay, failure-vocabulary, and result schemas;
- 15 content-addressed exact-codec fixtures and 15 authoritative case IDs for
  the current JPEG 2000, progressive MPEG-2, DTS, and TrueHD/MLP checkpoint;
- repository and environment-backed fixture resolution with byte-length,
  SHA-256, provenance, generator, and redistribution-license validation;
- fixed no-shell adapters for TypeScript, Vitest, Node/Python tests, lint,
  Webpack, artifact verification, Vite Node, browser/worker smoke, runtime
  readiness, and mpv/browser A/B capture;
- dependency ordering and explicit supersession, so a release matrix does not
  rerun focused Vitest when the full suite already covers it;
- `case`, `codec`, `route`, `gpu`, tag, and soak selection with OR inside one
  axis and AND across axes;
- bounded sanitized JSON evidence plus canonical JSON, Markdown, HTML, and
  manual-checklist reports under the ignored artifact root;
- shared classification for missing inputs, unknown capability, unexpected
  transcode, console error, ownership warning, resource leak, and secret leak.
- separate reviewed baseline approval and read-only comparison. Approval
  requires a clean passing result, reviewer acknowledgement, and explicit
  timing tolerance; a normal run cannot create or update a baseline.
- four generator-owned registry fragments containing the exact JPEG 2000,
  progressive MPEG-2, DTS, and TrueHD/MLP fixture records. The effective
  manifest digest covers their ordered hashes without duplicating records in
  the hand-maintained manifest.
- one checked live-case catalog containing 18 exact SDR/HDR/Dolby Vision
  presentation routes and eight shared lifecycle, fault, startup, and retention
  exercises. An ignored source specification generates a content-addressed
  private overlay without copying paths, item IDs, URLs, or credentials;
- exact browser-smoke route assertions and live environment evidence for the
  browser, WebGPU adapter, CDP GPU/driver, display HDR state, Jellyfin version,
  and request-intercepted feature flags;
- exact browser-smoke Jellyfin play-method assertions backed by both the
  player-selected stream record and the matching active server session. The
  bounded evidence includes no private identifiers or URLs, and DirectPlay
  rejects active transcoding or any transcode reason;
- bounded Jellyfin server-log capture for generated browser cases. It snapshots
  retained primary/FFmpeg file sizes, reads at most 8 MiB appended during the
  exercise, resolves private match values only in memory, and retains only the
  exact start/stop sequence, policy booleans, counts, and transcode activity.
  DirectPlay rejects any new or changed FFmpeg transcode log.
- route-aware startup comparison. SDR identity measures HTML,
  presentation-only WebGPU, and custom decode; HDR/Dolby Vision measures HTML
  and custom decode because the native-media external texture is already
  browser color-converted and is not a valid raw HDR presentation input.

The generated-registry checkpoint matrix passed all 15 fixture hashes and cases,
50 Python tests, 135 standalone Node tests, 383 focused Vitest tests, and
TypeScript. This is static exact-codec evidence, not a substitute for live
DirectPlay cases.

The first generated private record passed the complete live High Tier HDR10
browser matrix on Jellyfin 12.0.0/port 8096 and Chrome 151. Its lifecycle,
five-session reuse, active/paused device-loss, startup, and 30-session retention
cases cover 62 exact DirectPlay sessions with paired server starts/stops, zero
server/transcode/browser errors, and passing private-value scans. It selected
the exact native external-PQ route and decoded PCM audio. The retention case
ended with zero live GPU, `VideoFrame`, custom worker, or WASM objects and zero
listener/node growth. This is still one source/route and does not close the
broader route matrix.
The corresponding static checkpoint passed 15 canonical cases, 57 Python
tests, 143 standalone Node tests, 383 focused Vitest tests, TypeScript,
runtime-toolchain readiness, and a development build.

The Profile 5 negotiation checkpoint passed the same 15 canonical fixtures and
cases plus all 10 checks, with 384 focused Vitest tests, 143 standalone Node
tests, 57 Python tests, TypeScript, runtime-toolchain readiness, and a
development build. Separate private live runs passed the HDR10 lifecycle
regression and Profile 5 lifecycle, active device loss, and paused device loss.

Remaining Group B work is populating and executing the generated private
HDR/color/startup/soak/mpv records, one case-ID failure-injection vocabulary
across the smoke tools, manual-observation ingestion, and pairwise/boundary
matrix generation. Bounded active-session API and server-log evidence are
complete. Full PlaybackInfo/network capture remains separate because it must
redact request profiles, signed URLs, and identifiers.

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

### Group A: No-bitrate negotiation and High Tier direct-play gate

**Owns:** the rule that bitrate never selects a WebGPU playback route, exact
HEVC Main10 tier/level evidence, native-versus-raw HDR route isolation,
device-profile constraints, PlaybackInfo evidence, and port-8096 title
acceptance.

**Deliverable:** complete in the committed no-bitrate checkpoint. The exact section 2.10
MKV/HEVC High Tier/HDR10/FLAC source uses the original file through the owned
custom route. Source bitrate remains telemetry, saved network limits are absent
from selection, raw/native capability envelopes do not contaminate each other,
and a genuine codec incompatibility can still receive a bounded transcode output
after the play method is already fixed.

**Do not combine with:** new codecs, ProRes, broad raw-format expansion, or
validation-framework refactoring before this real-title gate is closed.

### Group B: Unified validation framework

**Owns:** manifest/schema, fixture registry, runners, failure vocabulary, CDP and
server evidence adapters, reports, baselines, matrix selection.

**Deliverable:** one command can run a selected matrix and produce a sanitized,
reproducible report. Existing smoke/color/retention tools become adapters rather
than competing frameworks.

**Why grouped:** fixture metadata, environment capture, failure injection, and
reporting are shared by every codec and should be implemented once.

The current subtitle slice extends the existing browser-smoke controller rather
than adding another runner. It preflights private inputs, records sanitized
route/surface/worker evidence, runs media-time cue/pause/seek/offset/switch/
deselect/delayed-fetch exercises, restores state, and checks post-stop cleanup.
Remaining shared-framework work is the paired HTML/custom result join, reviewed
browser/GPU visual baselines and private artifact storage, checked subtitle
fault IDs, 30-session retention integration, and expected private-input digests.

### Group C: Shared video decoder and raw-format expansion

**Owns:** decoder adapter contract, packet transforms, frame/sample ownership,
raw plane formats, buffer pools, worker protocol, generic exact-output and
throughput probes.

**Deliverable:** first expose raw 8-bit I420 through the complete worker/session/
presenter/capability contract, then generalize subsampling once for I422 and
I444 families. Adding a codec must require a small adapter, fixtures, and route
descriptor rather than copying HEVC-specific lifecycle logic.

**First consumers:** only a separately approved codec may justify general raw
I420. The completed progressive MPEG-2 Matroska route remains isolated as the
adapter and exact-output reference and must not be widened. P010 is an optimization;
alpha, packed YUV, and RGB remain deferred until a selected backend requires
them. ProRes is excluded.

**Boundary:** color reconstruction remains in Group E; negotiation changes are
applied by Group F only after Group B evidence passes.

### Group D: Audio normalization, layout, and codecs

**Owns:** streaming resampler, channel-layout model, remap/downmix, optional
multichannel output policy, audio decoder adapters, PCM conversion, AudioWorklet
clock integration, native-media audio bridge.

**Deliverable:** common rates/layouts are normalized once, allowing DTS,
TrueHD, ALAC, PCM, and WMA adapters without per-codec output hacks.

**Completed order:** standard-build `@mediabunny/ac3` -> streaming resampler ->
mono/stereo/5.1-side layout model -> Mediabunny PCM/G.711 -> explicit
5.1-back/6.1/7.1 channel layouts -> bounded exact-probed libdcadec DTS family
for the fixture-proven Matroska profile/layout pairs -> bounded exact-probed
FFmpeg TrueHD/MLP route for TrueHD stereo/5.1 and MLP stereo -> one shared
3000-192000 Hz integer source-rate contract -> pinned mpv/FFmpeg 7.1 downmix and loudness
reference at 48/96 kHz -> player slider-string repair and user-selected
track/album normalization gain -> runtime-gated complete-bed six/eight-channel
AudioWorklet output with deterministic stereo fallback.

**Remaining order:** physical 5.1/7.1 channel-isolation, device-switch, volume,
mute, and normalization qualification in Chrome/Edge -> live non-unity
track/album normalization A/B -> extend reference PCM/loudness evidence to the
remaining layouts/codecs -> DTS live seek and long-run qualification -> bounded
DTS/TrueHD TS/M2TS demux -> TrueHD 7.1 exact fixture -> ALAC -> WMA.
Separate legal review remains necessary only
for non-Mediabunny decoder dependencies.

The current DTS hardening also accepts only the measured 1 ms Matroska packet-
timestamp quantization plus one source-sample rounding interval. Accepted input
is canonicalized to the sample-count timeline; larger gaps or overlaps still
fail. Bounded device-profile sample-rate rules are target-neutral and use
complementary rejection profiles so they cannot accidentally request a 192 kHz
AAC transcode output.

### Group E: HDR and Dolby Vision correctness

**Owns:** color metadata, transfer functions, gamut/tone mapping, dithering,
RPU parsing, BL/EL composition, HDR/DV GPU authorization, golden references,
renderer controls.

**Deliverable:** mpv/libplacebo-level reconstruction for the claimed profiles,
with exact-device authorization and documented graceful degradation.

**Remaining concentration:** decodable real-title HDR10+ temporal A/B against
mpv/libplacebo, broader real-title Profile 5/7/8 and HLG matrices, BDMV behavior,
FEL dual-decoder performance, HDR10+ multiwindow/grid handling only if justified
by real content, display controls, golden thresholds, and device/display changes.

**Current evidence:** all seven generated HDR/Dolby Vision WGSL variants compile
and create render pipelines in Chrome 151. The exact five-frame private HDR10
A/B against mpv's static spline records mean/minimum SSIM of
0.9938272/0.990991 and mean/minimum PSNR of 39.421/37.965 dB. Dynamic-reference
mean/minimum SSIM is 0.992474/0.989412. These are descriptive display-code
deltas, not universal perceptual pass thresholds. The run parsed and used the
source's 4000-nit mastering maximum with native HEVC `VideoFrame`, authorized
external PQ presentation, decoded FLAC PCM, settings version 6, and no browser
error or ownership warning. Ten-second pacing presented 238 changed frames with
42 ms media median/p95/max and 41.7/41.8 ms wall median/p95; browser-minus-mpv
PCM RMS differed by 0.00032 dB with identical peaks. Residual visual difference
is concentrated in chroma/gamut behavior because the current analytic gamut
compression is not libplacebo's generated 3D perceptual LUT.

Renderer settings version 7 adds exact-PTS HEVC HDR10+ ST 2094-40 handling for
application version 0/1 with one whole-frame processing window and no luminance
grid. The parser, queue, worker protocol, uniforms, shader compilation probe,
and failure-state telemetry are implemented. Absent, malformed, conflicting,
unsupported, or stale metadata clears the dynamic state and uses static HDR10
for that frame. This is not yet product-qualified without decodable real-media
temporal comparisons and an HDR-capable visual-output run.

One private 4K Profile 5 title now passes lifecycle, active device loss, and
paused device loss through native HEVC `VideoFrame` decode, matching RPU
delivery, external-texture reconstruction, and decoded 5.1 E-AC-3. Both client
and Jellyfin report DirectPlay with no transcode reasons. The negotiation fix
uses a non-blocking shared authorized envelope because Jellyfin cumulatively
evaluates matching profiles, while range-scoped measured profiles retain every
exact per-route cap. This is initial real-title evidence, not the complete
Profile 5 title/browser/GPU matrix.

The ordinary PQ worker now scans a bounded startup prefix rather than only the
first access unit. It merges consistent partial static fields, reports exact
`absent`, `malformed`, `conflicting`, or `valid` states, and discards all values
on malformed or conflicting input. Focused parser/protocol/session tests cover
late metadata and every rejection state. A private 4K HDR10 lifecycle retained
`valid`, 16 scanned access units, first metadata index 0, and the 4000-nit
mastering peak with zero fallback. Its paired ten-round startup gate passed with
first-visible median/p95 regression of -81.9/7.1 ms and first-audio regression
of 9.9/97.2 ms versus direct HTML.

Generated ordinary-PQ live sources can now bind that state to an exact expected
scan status and tone-mapping peak. Lifecycle validation rejects status, scan
bound, first-index, or peak mismatches. Every custom startup sample applies the
same contract and retains the bounded scan evidence. The current High Tier HDR10
source passed both generated lifecycle and paired-startup selectors with
`valid`, first access unit 0 of 16, and 4000 nits.

The generated negative matrix now constructs 12-second PQ Main10/FLAC
Matroska fixtures for `absent`, structurally malformed, internally conflicting,
and valid 4000-nit metadata. A mandatory Mediabunny plus production-parser
preflight verifies all four exact states before browser execution. All four
Jellyfin 12 nightly/Chrome 151 lifecycle cases passed exact client/server
DirectPlay, scan-state, scan-bound, first-index, peak, and sanitized server-log
contracts. The conflict case also exposed and fixed TypeScript's ES5 custom
`Error` prototype loss in the emitted decode worker. This closes the generated
negative-state gate on the current browser/GPU host; broader malformed real
titles and cross-browser/GPU execution remain part of the release matrix.

### Group F: Negotiation and capability safety

**Owns:** structured codec/container route descriptors, capability aggregation,
Jellyfin device-profile constraints, profile refresh/retry, PlaybackInfo naming,
and exact transcode-reason tests.

**Deliverable:** Jellyfin never transcodes a passing route for a false capability
reason and never DirectPlays a route without complete evidence.

**Immediate case:** preserve the completed High Tier HDR10 regression: remove
all global and per-profile bitrate inputs, make the first PlaybackInfo request
bitrate-free, prefer the exact native external-HDR route over narrower raw
fallback routes, and keep a separate post-selection transcode-output request.
Async capability/profile refresh must not race the first request or create a
negotiation loop.

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

Owned custom-clock ASS/SSA and PGS surfaces plus terminal fallback containment
are implemented in the current worktree. Live visible-output, track-switch,
offset, seek, cleanup, HTML-parity, and Archer single-session evidence remain
the integration gate rather than additional renderer architecture. The exact
matrix and evidence contract are in `WEBGPU_SUBTITLE_VALIDATION.md`.

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
then AVI for MPEG-4 Part 2/MJPEG, ASF for WMA, and
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
Group A: no-bitrate negotiation / High Tier HDR10 gate
  -> exact tier/level and decoded-output evidence
  -> profile isolation and bitrate-free selection
  -> port-8096 real-title regression

Group B: validation schema/framework ------------------------------+
Group I: legal/package audits -------------------------------------+-- parallel
Group J: container contracts --------------------------------------+
Group K: source transport/buffering -------------------------------+
                                                                    |
Group C: reusable I420 route -> I422/I444 expansion ----------------+
         shared adapters <- B + J + K where required                |
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
- [x] Add the exact-runtime-gated OpenJPEG JPEG 2000 Part 1 route for
  progressive 8-bit sRGB/gray `MJ2`/`MOV` through 960x540 at 24 fps.
- [x] AAC, Opus, FLAC, MP3, Vorbis, and standard AC-3/E-AC-3 routes.
- [x] Finish and qualify native HEVC external HDR.
- [x] Direct-play the exact local High Tier Level 153 HDR10/FLAC
  source on port 8096 with no false level/resolution/bitrate transcode reason.
- [x] Remove source bitrate from custom capability, eligibility, native fallback,
  device-profile, and first-request playback selection. Retain exact decoded
  format, dimensions, level, frame rate, measured throughput, and route evidence.
- [x] Add a compact generated native HEVC Main10 High Tier fixture so the
  actual-title evidence has a portable regression counterpart. Verify the SPS
  tier bit directly and never infer tier or support from source bitrate.
- [ ] Expose raw 8-bit `I420` through worker negotiation, capability,
  presentation authorization, telemetry, and reusable buffer pools.
- [x] Keep MPEG-2 interlacing and deinterlacing out of scope; reject interlaced
  metadata and decoded frames without advertising a fallback route.
- [ ] Add shared I422/I422P10/I422P12, then I444/I444P10/I444P12 formats only
  once and reuse them across codecs.
- [ ] Add P010 only for a demonstrated zero-copy/performance benefit; defer
  alpha, packed YUV, and raw RGB until a selected decoder requires them.
- [ ] Add the shared video decoder adapter around those canonical formats.
- [x] Add an exact-probe-gated progressive MPEG-2 Main Matroska route.
- [x] Keep the focused legacy-video decoder limited to progressive MPEG-2 Main
  Profile Matroska.
- [x] Explicitly exclude VC-1/WMV3 and every MPEG-2 container except Matroska;
  do not add MPEG-2 TS/M2TS, PS/VOB, MOV/MP4, or interlaced routes.
- [ ] Decide and implement the required P1/P2 codec subset from sections 4.3
  and 5.2 using actual library inventory and legal review.
- [x] Add shared streaming audio resampling and explicit mono/stereo/5.1-side
  channel layouts; 7.1/arbitrary layout expansion remains separate.
- [x] Promote `@mediabunny/ac3` to ordinary builds and delete the obsolete local
  validation-only build policy while retaining exact runtime qualification.
- [x] Integrate Mediabunny's built-in PCM/G.711 decoders for exact supported
  codec/container/layout combinations and the shared bounded source-rate
  contract.
- [x] Skip ProRes and keep `@mediabunny/prores` absent unless product direction
  explicitly changes.
- [x] Add an exact-probed bounded DTS Core/96-24/ES/HD-HRA/HD-MA Matroska
  route through libdcadec and the owned PCM pipeline.
- [ ] Add the missing DTS MPEG-TS/M2TS demux route before advertising Blu-ray
  DTS container combinations.
- [x] Add an exact-probed TrueHD stereo/5.1 and MLP stereo Matroska priority
  route with four decoder/layout fixtures and the shared bounded source-rate
  contract.
- [ ] Add TrueHD/MLP 7.1 and M2TS only after exact fixture and demux evidence.
- [ ] Enable and qualify Mediabunny Ogg and applicable HLS paths.
- [ ] Add only missing MPEG-PS, AVI, and ASF containers as their codecs require.
- [ ] Harden authenticated range input, redirects, cancellation, retries,
  read-ahead/backpressure, and bounded caching for remote-server latency.
- [ ] Validate every legal codec/container pair and nearby negative pair.

### HDR and Dolby Vision

- [x] Raw PQ/HLG WebGPU reconstruction and tone mapping.
- [x] Add the version 6 static spline, libplacebo-compatible PQ/SDR black-point
  handling, and shared IPTPQc4 perceptual gamut stage to every external/raw HDR
  and Dolby Vision shader route.
- [x] Parse HEVC mastering-display/content-light SEI, propagate validated static
  metadata through the custom pipeline, and select the mastering maximum or
  MaxCLL before presenting the first ordinary PQ frame.
- [x] Scan a bounded startup prefix, merge consistent late fields, reject
  malformed/conflicting values, retain explicit scan telemetry, and preserve the
  1000-nit default for every non-valid state.
- [x] Bind generated ordinary-PQ live cases to an exact static scan state and
  tone-mapping peak, including per-sample startup assertions and bounded scan
  evidence.
- [x] Compile all seven generated HDR/Dolby Vision shaders in real Chrome WebGPU
  and complete an exact five-frame browser/mpv static-and-dynamic spline A/B.
- [x] Dolby Vision Profile 5/8, Profile 7 MEL, and implemented FEL code paths.
- [x] Add an exact item-scoped Profile 7 compatibility-ID-6 HDR10-base route
  through native HEVC/external PQ when full raw Dolby Vision is outside its
  measured envelope. Preserve full reconstruction when it is qualified, strip
  unused RPU/EL data for base playback, and retain static HDR peak handling.
- [ ] Evaluate a bitstream-proven Profile 7 HDR10-base route for remuxes with a
  missing or noncanonical BL compatibility field. Require an encoded preflight
  to prove Profile 7 BL/EL/RPU topology plus limited 10-bit BT.2020 non-
  constant/PQ base signaling; continue rejecting contradictory metadata.
- [x] Complete native external PQ/HLG checkpoint.
- [x] Pass one real-title Profile 5 DirectPlay lifecycle plus active and paused
  device-loss recovery with decoded 5.1 E-AC-3 and no transcode reasons.
- [x] Parse bounded HEVC HDR10+ prefix/suffix SEI for application version 0/1,
  one full-frame processing window, and no peak-luminance grid.
- [x] Propagate HDR10+ through an exact-PTS bounded queue and renderer settings
  version 7, clear stale state on every absence/error/generation boundary, and
  retain static HDR10 fallback per frame.
- [x] Add deterministic parser/queue/uniform/shader tests and compile the emitted
  dynamic shader in Chrome/Edge WebGPU.
- [ ] Qualify decodable real HDR10+ material with temporal browser captures,
  pinned mpv/libplacebo comparisons, playback controls, device loss, and soak.
- [ ] Decide whether real-title evidence warrants multiwindow or peak-luminance
  grid support; do not approximate unsupported metadata.
- [ ] Build the complete HDR/DV golden and live-title matrix.
- [ ] Validate Profile 7 FEL for all claimed container topologies and sustained
  dual-decoder playback.
- [ ] Complete BDMV/M2TS end-to-end qualification.
- [x] Run generated live fixture cases for absent, malformed, conflicting, and
  valid static HDR metadata with exact DirectPlay, scan, peak, and server-log
  assertions. Broader malformed real-title coverage remains in the release
  matrix.
- [ ] Validate corrupt/stale RPU, EL loss, metadata beyond the bounded startup
  prefix, and exact fallback/degradation behavior. HEVC HDR10+ has unit-level
  malformed/conflict/stale coverage; broader real-title coverage remains.
- [ ] Validate device loss, adapter changes, canvas format changes, fullscreen,
  DPR, and display changes for every HDR/DV route.
- [ ] Define final renderer controls, defaults, persistence, and live uniform
  updates without shader recompilation.
- [ ] Define color-delta thresholds and approve golden references.

### Audio

- [x] Owned decoded-PCM AudioWorklet clock/output.
- [x] Accept Jellyfin's slider-shaped numeric strings, preserve the 0-100 player
  contract, and apply the existing cubic volume curve to custom output.
- [x] Honor `TrackGain`, `AlbumGain`, and `Off` with HtmlAudioPlayer-compatible
  fallback order, independent slider/mute state, and explicit telemetry.
- [x] Add a live custom-audio lifecycle gate for string volume, cubic gain,
  mute, invariant normalization gain, and exact state restoration.
- [x] Stereo 48 kHz and qualified 5.1-to-stereo paths.
- [x] Native-media AC-3/E-AC-3 bridge.
- [x] Implement bounded streaming sinc resampling with deterministic latency
  and signed-microsecond timestamp accounting.
- [x] Replace discrete source-rate whitelists with one integer 3000-192000 Hz
  contract across negotiation, eligibility, worker protocol, decoder output,
  telemetry, and resampling. Keep encoded bitrate irrelevant, preserve exact
  codec/profile/layout rules, and retain runtime decoder checks.
- [x] Keep bounded decoded-audio device profiles target-neutral and reject
  out-of-envelope source rates with complementary profiles, preventing the
  upper bound from becoming a requested 192 kHz AAC transcode output.
- [x] Authorize stereo 48 kHz E-AC-3 through the ordinary bundled-decoder route
  without consulting encoded bitrate.
- [x] Accept bounded Matroska millisecond timestamp quantization for compressed
  audio, canonicalize accepted input to the sample-count timeline, retain
  correction telemetry, and continue rejecting genuine packet gaps/overlaps.
- [x] Remove inherited HTML `AudioBitDepth` ceilings only from custom decoded-
  PCM containers and regression-test stereo FLAC at 8/16/20/24/32-bit source
  metadata, unusual bounded rates, and missing/extreme encoded bitrates.
- [x] Validate the selected source rate during user-activation-time audio
  prewarm but always create the fixed 48 kHz decoded-PCM output context. A
  96 kHz or nonstandard source rate must not create and discard a mismatched
  AudioContext before custom playback starts.
- [x] Implement explicit channel labels and mono/stereo/5.1-side policy.
- [x] Add explicit 5.1-back, 6.1, and 7.1 WAVE-order channel layouts and bounded
  stereo downmixes required by the DTS family.
- [x] Qualify the 7.1 matrix at 48/96 kHz against pinned mpv/FFmpeg output,
  exact DTS HRA/MA fingerprints, gain/peak/RMS/crest metrics, clipping bounds,
  LFE policy, and arbitrary decode/resampler chunk boundaries.
- [x] Implement runtime-gated complete-bed 5.1/7.1 decoded-PCM output using the
  exact playback destination, with deterministic stereo fallback and no partial
  7.1-to-5.1 route.
- [ ] Physically validate 5.1/7.1 speaker isolation and ordering, output-device
  changes, volume, mute, normalization, seek, and fallback in Chrome and Edge.
- [ ] Add any remaining codec-specific layouts and extend the FFmpeg/mpv
  reference downmix/loudness corpus beyond the qualified DTS 7.1 route.
- [ ] Run non-unity TrackGain and AlbumGain A/B cases against HtmlAudioPlayer on
  a generated audio-library fixture. For WebGPU movie playback, first define a
  legitimate video loudness-metadata or client-analysis policy; do not inject
  fabricated gains and call that product coverage.
- [x] Pin and reproduce the bounded LGPL libdcadec WebAssembly module with source,
  license, revision, exact-output fixtures, and runtime throughput probe.
- [x] Wire MKV `A_DTS` packets through one owned decoder context, the shared
  resampler/AudioWorklet path, fixture-derived profile/layout eligibility, the
  bounded source-rate contract, and MKV-only device claims.
- [x] Pin a TrueHD/MLP-only LGPL FFmpeg WebAssembly module and wire Mediabunny
  MKV `A_TRUEHD`/`A_MLP` packets through exact PCM, major-sync, throughput,
  downmix, resampler, bounded-rate eligibility, device-profile, and packaging
  gates.
- [ ] Add a license-clean 7.1 TrueHD fixture and bounded M2TS demux route before
  advertising eight-channel or disc-container TrueHD.
- [ ] Live-test Core, 96/24, ES, HRA, MA, and DTS:X-bed sources for seek, switch,
  EOF, repeated sessions, A/V drift, queue stability, and mpv PCM/loudness A/B.
- [ ] Add a bounded, reviewed MPEG-TS/M2TS DTS demux route and its malformed,
  discontinuity, multi-track, random-seek, and PMT/PES fixture matrix.
- [ ] Qualify audio switching among native-media, native WebCodecs, and bundled
  decoder routes without restarting video.
- [ ] Decide supported playback-rate behavior and implement rate-adjusted PCM or
  retain an explicit 1.0-only product limitation.
- [x] Decide and implement native multichannel decoded-PCM policy.
- [ ] Decide compressed passthrough policy separately. No passthrough capability
  is currently claimed.
- [x] Approve Mediabunny and official Mediabunny decoder-extension licensing.
- [x] Make AC-3/E-AC-3 software decode part of the ordinary verified build.
- [x] Encode DTS:X capability semantics as MA channel-bed-only with object audio
  explicitly false; never advertise DTS:X object rendering or passthrough.
- [ ] Verify every Playback Info/UI surface preserves the DTS:X channel-bed-only
  wording with licensed live media.

### Jellyfin behavior

- [x] Stable wrapper identity, HTML fallback, and generation invalidation.
- [x] Route complete known-unsupported video metadata to the separately
  registered HTML player before WebGPU negotiation, with regression coverage
  for VC-1, interlaced/out-of-envelope MPEG-2, and AV1 Main10 SDR. Keep missing
  selection metadata conservative until exact negotiated-source validation.
- [x] Tear down custom decode/audio before one renegotiation signal, stop any
  partially started failed HTML fallback, and ignore stale terminal errors so
  navigation cannot leave background audio or a duplicate session.
- [x] Add owned custom-clock ASS/SSA and PGS canvases while preserving forced
  DOM text subtitles and the ordinary HTML renderer paths.
- [x] Advertise only the custom runtime's external VTT/ASS/SSA/PGS surfaces,
  preserve Encode profiles, deduplicate entries, and keep retry profiles
  conservative.
- [x] Regression-test the augmented device profile and exact route isolation for
  the local High Tier HDR10 source; no bitrate capability cap was added or raised.
- [x] Make WebGPU DirectPlay/DirectStream/transcode selection independent of
  saved network, source, container, audio, and video bitrate.
- [ ] Add a focused PlaybackManager API test for the two-request fallback rule:
  bitrate-free play-method selection followed by transcode-output sizing only.
- [x] Make every generated live browser case assert the exact player and server
  play method; DirectPlay fails on active transcoding or any transcode reason,
  and the report retains no private item/media-source/device identifier or URL.
- [x] Require bounded server-log evidence for every generated browser case;
  retain only exact lifecycle/policy/count evidence and reject DirectPlay when
  any FFmpeg transcode log is created or changed.
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
- [ ] Live-qualify Fight Club PGS, Infinity Train stereo E-AC-3, HTML selection
  for the AV1 Main10 SDR/VC-1/interlaced MPEG-2 cases, and Archer DTS playback
  with no resampler error, navigation, duplicate HLS, or background audio.
- [ ] Validate SyncPlay clock/event semantics and document rate limitations.
- [ ] Validate OSD stacking, pointer input, accessibility, fullscreen, resize,
  DPR, background/foreground, and screen wake behavior.
- [ ] Define PiP, AirPlay, Remote Playback, casting, and DRM fallback behavior.
- [ ] Add live/infinite-stream support or explicitly retain HTML/server fallback
  as the final product policy.

### Validation and release

- [x] Make browser/mpv A/B capture inject the custom feature flags at request
  time, independent of disabled source and built `config.json` values, for both
  root and `/web/` frontend URLs.
- [x] Implement the unified validation manifest and result schema foundation.
- [x] Add a single-sourced private live-case generator covering exact HDR/Dolby
  Vision route selection, lifecycle, failure recovery, startup, retention,
  worker, and mpv A/B adapter records.
- [x] Add source-bound static-HDR status and peak contracts to generated
  ordinary-PQ lifecycle and startup checks.
- [x] Capture browser, GPU/driver, display HDR, server, and active feature-flag
  evidence from successful live browser adapters.
- [x] Add the integrated custom-session subtitle browser-smoke adapter with
  private-input preflight, sanitized route/surface/worker/cue evidence,
  pause/seek/offset/switch/deselect/delayed-fetch exercises, state restoration,
  and post-stop cleanup.
- [ ] Join paired HTML/custom subtitle results, approve browser/GPU visual
  baselines and private artifact storage, wire checked subtitle fault IDs,
  integrate the 30-session retention mode, and require expected private-input
  lengths and hashes in the overlay schema.
- [ ] Migrate existing color, worker, browser, startup, artifact, and soak tools
  into executed and reviewed shared-framework cases. Adapter/catalog migration
  is complete; exact source records and cross-platform runs remain.
- [x] Record deterministic fixtures, hashes, generators, provenance, and license
  for the current exact JPEG 2000, progressive MPEG-2, DTS, and TrueHD/MLP
  checkpoint. Add HDR/live/private records as those matrices migrate.
- [ ] Add automated FFmpeg/mpv reference generation from pinned revisions.
- [x] Add a checked Windows Chrome/Edge x NVIDIA/AMD/Intel matrix runner with
  strict failed/unsupported/not-run states and privacy validation.
- [ ] Pass the hardware matrix. Current NVIDIA evidence has a Chrome retention
  timeout and unresolved Edge live-entry failure; physical AMD/Intel are not run.
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

## 11. Historical no-bitrate DirectPlay checkpoint checklist

This checkpoint removes bitrate from WebGPU route selection; it does not raise a
cap. Codec/profile/tier/level, decoded format and geometry, measured throughput,
and presentation authorization remain mandatory. Raw I420 and new codec work
follow separately so this negotiation fix cannot hide decoder or renderer work.

### 11.1 Failure evidence and invariant

- [x] Record the source: MKV, progressive HEVC Main10 High Tier Level 153,
  3840x2160 at 23.976025 fps, HDR10 BT.2020/PQ, and stereo 48 kHz 24-bit FLAC.
- [x] Confirm the SPS reports `general_profile_idc=2`, `general_tier_flag=1`,
  `general_level_idc=153`, 10-bit luma/chroma, and 4:2:0. Tier is explicit and is
  never inferred from source bitrate.
- [x] Reproduce the initial HLS result and isolate its reasons. Removing bitrate
  inputs eliminated the bitrate reason; the remaining level/resolution reasons
  came from cumulative native/raw codec-profile constraints.
- [x] Establish the invariant that source/container/audio/video bitrate is
  telemetry only for WebGPU playback selection.
- [x] Keep network bitrate available only to size a transcode after a first,
  bitrate-free request has already fixed the play method to transcode.

### 11.2 Capability, eligibility, and profile integration

- [x] Remove maximum-bitrate fields and literals from native HDR/Dolby Vision and
  bundled HEVC capability records and protocol data.
- [x] Remove source bitrate checks and required bitrate metadata from custom
  eligibility for bundled HEVC, native HDR HEVC, and native Dolby Vision.
- [x] Ignore audio/video bitrate conditions in same-session native compatibility
  so bitrate cannot select native fallback versus custom decode.
- [x] Null `MaxStreamingBitrate`, `MaxStaticBitrate`, and
  `MaxStaticMusicBitrate` and remove `AudioBitrate`/`VideoBitrate` conditions from
  every augmented codec and container profile without mutating the HTML profile.
- [x] Prevent saved/automatically detected network bitrate from entering the
  first WebGPU PlaybackInfo request.
- [x] Split true transcode fallback into selection and output-sizing requests so
  unsupported sources do not receive a zero-bitrate encode.
- [x] Prefer an authorized native external-HDR route for the exact static HDR
  item; expose the narrower raw route only if native authorization is absent.
- [x] Prevent non-authorized raw HEVC limits from intersecting the native route.
- [x] Preserve profile/level, bit depth, chroma, progressive, dimensions, frame
  rate, decoded-output, throughput, container, audio-route, and presentation
  checks.

### 11.3 Automated regression coverage

- [x] Accept missing and arbitrarily high source bitrate for otherwise identical
  bundled and native HDR routes.
- [x] Assert all global, codec, apply, audio, video, and container bitrate
  constraints are absent from an augmented profile and the source profile is
  unchanged.
- [x] Assert native compatibility ignores deliberately failing audio/video
  bitrate conditions.
- [x] Assert exact external HDR wins when both external and raw route records are
  available.
- [x] Assert a native 4K external-HDR profile is not reduced by a present but
  unauthorized 1080p raw/bundled envelope.
- [x] Assert the player returns no bitrate for selection and returns the saved
  value only for explicit transcode-output sizing.
- [x] Add focused playback bitrate-policy tests for the two-request fallback
  sequence and every gate that must prevent the second request.
- [ ] Add a compact deterministic native High Tier access-unit fixture and exact
  output fingerprint as portable hardening. The private regression source already supplies
  runtime evidence, so this is not permission to restore a bitrate threshold.

### 11.4 Port-8096 acceptance

- [x] Run the private Jellyfin High Tier HDR10 validation item
  with FLAC stream 1 through the current Jellyfin-served build.
- [x] Require custom eligibility, native `video-frame` decode, external PQ input,
  HDR-to-SDR WebGPU presentation, decoded FLAC PCM, and no HTML fallback.
- [x] Pass start, pause/resume, fullscreen, resize/DPR, frame presentation, and
  controlled stop with no terminal/runtime/browser error or ownership warning.
- [x] Re-run with a three-seek storm and capture the concurrent Jellyfin session
  as explicit `DirectPlay` evidence. `TranscodingInfo` was null and no FFmpeg
  process remained.
- [ ] Retain IMAX/2.39:1 crop transitions, natural EOF, replay, subtitle/OSD
  stacking, visual HDR comparison, a Dolby Vision source, and generated PQ/HLG as broader
  validation-matrix work rather than expanding this negotiation diff.

### 11.5 Final checkpoint gate

- [x] Pass TypeScript and 362 tests across all ten affected Vitest files.
- [x] Pass the complete WebGPU plugin suite: 83 files and 1219 tests; pass all
  111 WebGPU Node tests and ordinary codec artifact verification.
- [x] Pass ESLint on every changed source/test file with zero errors and one
  pre-existing `FIXME` warning; pass `git diff --check`.
- [x] Build the final development bundle, restore only ignored local feature
  flags in `dist/config.json`, and rerun the exact port-8096 acceptance.
- [x] Confirm source flags remain disabled and no generated media, reports,
  credentials, machine-local paths, or ignored `dist` files are staged.
- [x] Reconcile this plan and relevant player documentation with the final
  implementation and evidence.
- [x] Review the complete diff and prepare the focused `Remove bitrate from
  WebGPU playback negotiation` commit for `webgpu-player`.

## 12. Historical native external HDR checkpoint checklist

This historical checkpoint contained only the native HEVC Main10 external-HDR
route plus its required HTML startup, validation-harness, tests, and
documentation changes. The Mediabunny AC-3/E-AC-3 standard-build work followed
as a separate checkpoint to preserve review and live-validation isolation.

### 12.1 Already completed in the worktree

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

### 12.2 Code review and missing automated coverage

- [x] Review every tracked and untracked diff for stale experiments, duplicate
  branches, inconsistent route names, and accidental source flag changes.
- [x] Confirm every switch over decoder backend, video output mode, HDR route,
  fallback reason, and telemetry handles the new route exhaustively.
- [x] Add or confirm negative tests for unsupported profile/bit depth/level,
  over-limit decoded dimensions/frame rate, missing metadata, and unqualified
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

### 12.3 Required local command gates

- [x] Run `npm run build:check` again from the final diff.
- [x] Run all affected WebGPU Vitest files, not only the newly added tests.
- [x] Run the complete `src/plugins/webGPUVideoPlayer` Vitest suite.
- [x] Run ESLint on every changed TypeScript/JavaScript file; it reports zero
  errors and only four pre-existing HTML-player warnings.
- [x] Confirm stylelint is not applicable because no SCSS/CSS changed.
- [x] Run the Node tests under `scripts/webgpu` that cover worker naming,
  artifacts, browser helpers, fixtures, and release metrics.
- [x] Build with `npm run build:development` using Node 24/npm 11.
- [x] Run the then-current ordinary artifact verifier with AC-3 disabled for the
  native-HDR checkpoint.
- [x] Confirm the AC-3 build boundary was not changed inside the native-HDR
  checkpoint.
- [x] Run `git diff --check`.

### 12.4 Port-8096 browser qualification

- [x] Install/serve the current development build through the existing Jellyfin
  server on `http://localhost:8096`; do not substitute a separate 8080 frontend
  for the authoritative manual check.
- [x] Enable feature flags only in the locally served ignored `dist/config.json`.
- [x] Confirm the exact native Main10 capability reports decoded output,
  measured fps, selected tier, 4K/Level 153 bounds, and no bundled route
  substitution. Source bitrate is not a capability bound.
- [x] Confirm the exact external PQ authorization passes and telemetry records
  device, target format, route key, transfer, and accepted readback.
- [x] Confirm the exact external HLG authorization independently passes.
- [x] Play the local High Tier Main10/FLAC case and require Jellyfin `DirectPlay`,
  not HLS transcoding or a false "codec/level/resolution/bitrate/range" reason.
- [x] Confirm PlaybackInfo identifies `WebGPU Video Player` and the telemetry
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
- [x] Inject device loss while playing and paused; require one replacement
  device, reauthorization, correct exact-time repaint, and no source restart.
- [ ] Run an SDR H.264/HEVC/VP9/AV1 identity regression set.
- [ ] Run private Dolby Vision regression cases for every route currently
  claimed by its source topology; distinguish actual custom DirectPlay from an
  HTML-transcoded source in the evidence. One Profile 5 title now passes the
  lifecycle and both device-loss cases; Profile 7/8 and broader Profile 5
  coverage remain.
- [ ] Exercise one native-media audio case and one decoded-PCM case to ensure the
  new video route did not change audio clocks or track selection.
- [x] Inspect browser console, Jellyfin PlaybackInfo, worker retirement,
  dropped/corrupt frames, queue bounds, A/V drift, and fallback count for both
  generated PQ/HLG runs. Both completed without unexpected output.

### 12.5 Resource and regression gates

- [x] Run at least three consecutive native external-HDR sessions and verify
  stable workers, listeners, GPU resources, frames, and AudioWorklet state.
- [x] Run the High Tier HDR checkpoint startup comparison against direct HTML
  and the exact custom external-HDR route. Ten matched rounds passed the fixed
  custom startup thresholds with 22 exact DirectPlay server lifecycles.
- [ ] Run the SDR checkpoint startup comparison against direct HTML,
  HTML+WebGPU identity presentation, and the custom route.
- [x] Run a 30-session retention snapshot after clean stop. Listener/node and
  tracked GPU/media object growth were zero; all heap gates passed.
- [x] Record whether the known Mediabunny `VideoSample` finalizer warning occurs.
  It did not occur in either controlled PQ/HLG lifecycle run. Its causal fix
  remains deferred, but new deterministic leaks or per-session growth block
  later release qualification.
- [ ] Verify fallback still plays the same selected source/session where the
  failure is presentation-only and does not duplicate Jellyfin reporting.
- [ ] Verify ordinary HTML playback with all WebGPU flags disabled is unchanged.

### 12.6 Final checkpoint hygiene

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

### 12.7 Native external HDR checkpoint evidence

- Runtime: Chrome `151.0.7922.72`, NVIDIA GeForce RTX 4080 SUPER, driver
  `596.60`, WebGPU adapter vendor `nvidia` and architecture `lovelace`.
- Server/build: Jellyfin `10.11.6` on `http://localhost:8096`, Node `24.17.0`,
  npm `11.13.0`, development webpack build.
- PQ fixture: `pq-main10-1080p24-aac.mkv`, historical validation item, SHA-256
  `bda7653938b6ce8e667b7abae70ce1c19b95c1e6d0b2fcdc0e0deb7c55f85cb7`.
- HLG fixture: `hlg-main10-1080p24-aac.mkv`, historical validation item, SHA-256
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

## 13. Historical Mediabunny AC-3/E-AC-3 checkpoint checklist

### Standard-build integration

- [x] Remove the environment gate, Vite/Webpack aliases, ignored-module branch,
  and obsolete global build constant.
- [x] Lazy-load and register the official pinned `@mediabunny/ac3` decoder for
  selected AC-3/E-AC-3 tracks in every ordinary build.
- [x] Advertise the standard software routes independently of native WebCodecs
  or native-media AC-3/E-AC-3 availability.
- [x] Copy the package license in every build and require its exact hash plus an
  executable implementation sentinel in the artifact verifier.
- [x] Add deterministic AAC-to-AC-3 and AAC-to-E-AC-3 switch fixtures without
  duplicating the video source or validation procedure.
- [x] Remove obsolete non-distributable/opt-in documentation and record the
  approved Mediabunny-first policy.

### Automated gates

- [x] Pass TypeScript checking and focused registration/capability/worker tests.
- [x] Pass the complete WebGPU Vitest suite and all `scripts/webgpu` Node tests.
- [x] Pass changed-file ESLint with no new warnings.
- [x] Build ordinary development and production bundles with no AC-3 environment
  override, then restore the development bundle served by Jellyfin.
- [x] Run `node scripts/webgpu/verify-custom-codec-artifacts.mjs` against both
  bundles and require the content-addressed Mediabunny package asset, executable
  Mediabunny implementation marker and exact copied license.
- [x] Run `git diff --check` and confirm source feature flags remain false.

### Port-8096 live qualification

- [x] Regenerate and rescan the deterministic AAC/AC-3 and AAC/E-AC-3 switch
  fixtures in the existing Jellyfin validation library.
- [x] Start each item on AAC, switch in-session by Jellyfin `MediaStream.Index`,
  and require a new owned decoder generation without restarting video.
- [x] Require worker telemetry to report `ac-3` or `ec-3`, decoded PCM and the
  Mediabunny software route, never a false native-media result on Chrome 151.
- [x] Exercise pause/resume, primary seek, three-seek storm, fullscreen,
  resize/DPR, and explicit stop after each switch while keeping the same WebGPU
  video route. Reverse switching, replay, and natural EOF remain in the broader
  audio lifecycle matrix.
- [x] Require the WebGPU custom DirectPlay route, bounded queues/A/V drift,
  clean worker retirement, zero console/runtime errors, and no deterministic
  `VideoSample` ownership warning.

### Checkpoint hygiene

- [x] Record fixture hashes, item/stream indices, commands, route telemetry, and
  lifecycle results in this plan.
- [x] Confirm generated media, served `dist`, credentials, logs, and screenshots
  remain ignored and unstaged.
- [x] Prepare a focused imperative commit and push on `webgpu-player`.

### Checkpoint evidence

- Runtime remained Chrome `151.0.7922.72` on the NVIDIA GeForce RTX 4080 SUPER
  with Jellyfin `10.11.6` serving the development bundle on port 8096.
- AC-3 fixture `pq-main10-1080p24-aac-ac3.mkv`: historical validation item,
  target `MediaStream.Index` `2`, length
  `23940278`, SHA-256
  `fe00c1ce4aec61e2a78502fe6b29421d9f5af5e3962cf1b249c1ddb22ad482a1`.
- E-AC-3 fixture `pq-main10-1080p24-aac-eac3.mkv`: historical validation item,
  target `MediaStream.Index` `2`, length
  `23940267`, SHA-256
  `2d099b4dd40024421ae1a29f530e3e32d00be7b04ac1922b201930c3437e7089`.
- Both began on default AAC index `1`, advanced the owned decoder generation to
  `2` on the switch, selected `decoded-pcm`, and reported native-media AC-3 and
  E-AC-3 as exact `mime-unsupported`. The video remained native HEVC
  `video-frame`, neutralized PQ, and authorized `external-hdr` without fallback.
- AC-3 presented first at `118.6 ms`; decoded `50403` audio frames by the switch
  snapshot; pause held at zero clock/frame delta; resume advanced `349503 us`
  and eight frames; seek reached `9345687 us` for target `9320722 us`; the
  three-seek storm advanced three generations with zero stale audio/video; and
  stop emitted exactly once with zero terminal errors.
- E-AC-3 presented first at `107.7 ms`; decoded `52346` audio frames by the
  switch snapshot; pause held at zero clock/frame delta; resume advanced
  `322044 us` and seven frames; seek reached `9351500 us` for target
  `9333032 us`; the three-seek storm advanced three generations with zero stale
  audio/video; and stop emitted exactly once with zero terminal errors.
- Both runs recorded zero decoded-audio drop, underflow, overflow, fallback,
  console/log/runtime errors, and `VideoSample` ownership warnings. One
  additional AC-3 repetition hit a CDP `Runtime.evaluate` timeout on a stale
  debug page with zero browser errors; replacing only that dedicated page
  produced the clean passing AC-3 evidence above.
- Development artifact: content-addressed `@mediabunny/ac3` asset SHA-256
  `e92f01f60972dcb81f3d63e447af8845a7005e11ac9e6c77730c2d177b50b6c9`.
  Production artifact SHA-256:
  `3556be3c51664261a20ca81bcce01d7f858f0f7bf701408bb38d398c1509250f`.
  Both copied license SHA-256
  `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04`.
- Automated gates passed: TypeScript; `214` focused tests; complete WebGPU
  Vitest (`80` files, `1181` tests); all WebGPU Node tests (`110` tests);
  changed-file ESLint; development and production Webpack builds; artifact
  verification for both bundles; and `git diff --check`.

## 14. Historical Mediabunny PCM normalization checkpoint checklist

### Decoder and normalization implementation

- [x] Inventory the exact PCM identifiers decoded by Mediabunny 1.52.2.
- [x] Use Mediabunny's public track/sample path instead of duplicating PCM
  conversion code.
- [x] Register a narrow G.711 availability marker for Mediabunny 1.52.2's
  `ulaw`/`alaw` track-probe omission without replacing its built-in decoder.
- [x] Add one explicit mono/stereo/5.1-side layout model and shared stereo
  transform.
- [x] Add one bounded 64-tap, 2048-phase streaming sinc resampler with exact
  frame/timestamp accounting, seek-generation isolation, terminal flush, and
  bounded output chunks/history.
- [x] Keep the existing stereo 48 kHz AudioWorklet and A/V clock as the single
  output path.
- [x] Close every Mediabunny `AudioSample` in `finally` after copying it.

### Capability and negotiation safety

- [x] Map Jellyfin PCM names separately from Mediabunny decoder names.
- [x] Advertise only exact MOV, MP4/M4V, and Matroska PCM/container pairs that
  Mediabunny actually exposes.
- [x] Historical checkpoint: limit input to mono, stereo, or 5.1-side and a
  discrete qualified rate list. The current integration supersedes that list
  with the shared 3000-192000 Hz integer contract.
- [x] Keep 7.1/arbitrary input layouts, out-of-range rates, unsupported
  Matroska PCM mappings, and DVD/BD LPCM outside the profile.
- [x] Carry both source and normalized channel/rate values through worker,
  session telemetry, and the browser validation snapshot.

### Automated and live validation

- [x] Round-trip all fourteen PCM/G.711 identifiers through Mediabunny's public
  MOV writer, demux, track probe, and `AudioSampleSink` with quantization-aware
  PCM comparisons.
- [x] Cover exact passthrough, 44.1-to-48 kHz chunk-boundary independence,
  96-to-48 kHz stopband rejection, discontinuity rejection, and bounded history.
- [x] Cover the 3000/192000 Hz boundaries, out-of-range values, and a nonstandard
  12345 Hz source through policy, negotiation, protocol, session telemetry, and
  resampler tests without enumerating every possible source rate.
- [x] Cover mono/stereo/5.1 transforms plus positive and negative eligibility
  and device-profile claims.
- [x] Extend the browser harness with an all-or-none source/output audio-shape
  expectation and keep its authoritative frontend default on port 8096.
- [x] Generate and rescan a deterministic AAC-to-PCM stream-switch fixture.
- [x] Live-qualify switch, pause/resume, fullscreen, resize/DPR, primary seek,
  three-seek storm, canvas evidence, and exact stop on the same video session.
- [x] Pass TypeScript, complete WebGPU Vitest, all WebGPU Node tests,
  changed-file ESLint, development build, and `git diff --check`.
- [x] Pass the final production build and ordinary artifact verifier, then
  restore the development bundle and local-only feature flags.
- [x] Perform the final diff review and prepare the focused commit/push.

### Checkpoint evidence

- Runtime: Chrome `151.0.7922.72`, Jellyfin `10.11.6`, authoritative frontend
  and server `http://localhost:8096`.
- Fixture `pq-main10-1080p24-aac-pcm_s24le-44100-mono.mkv`: historical
  validation item, target `MediaStream.Index` `2`, length
  `27246184`, SHA-256
  `0640c55cd00111db4da231c5efe94dafc3c31fe291a57756e9164ec8666ae9cd`.
- Playback began on AAC generation `1`, switched in-session to Mediabunny
  `pcm-s24` generation `2`, and reported source mono `44100` Hz plus output
  stereo `48000` Hz. The final switch snapshot had decoded `46774` output
  frames.
- Video remained native HEVC `video-frame` with authorized external PQ HDR.
  The complete controlled lifecycle reported zero fallback, stale frames,
  decoded-audio underflow/overflow/drop, terminal errors, browser errors, and
  observed `VideoSample` ownership warnings.
- Current automated gates: complete WebGPU Vitest `83` files / `1219` tests;
  all WebGPU Node tests `111`; TypeScript and changed-file ESLint clean;
  development and production Webpack builds plus ordinary codec artifact
  verification passed. PCM uses the already-pinned Mediabunny core asset and
  adds no duplicate decoder package.

## 15. Definition of final completion

The project is complete only when all claimed codec/profile/container/audio
routes have passing manifest cases and Jellyfin negotiation evidence; HDR/DV
routes have exact production readback authorization; ordinary playback and all
fallbacks are correct; lifecycle, startup, long-play, and retention gates pass;
the `VideoSample` ownership defect is closed; shipped decoder licensing and
artifact obligations are reviewed; and the required browser/GPU matrix passes
with source feature flags enabled only by an intentional rollout decision.
