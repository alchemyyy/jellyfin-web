# WebGPU Player Current Work

Status recorded: 2026-08-03

Branch: `webgpu-player`

Parent checkpoint: `a25eb6188aa5822cd9a8bf9efbeb1427da574a4b`

Checkpoint state: persistent player selection, runtime-gated native
multichannel PCM, exact-PTS HEVC HDR10+, the checked cross-browser/GPU hardware
matrix, exact Dolby Vision Profile 7 HDR10-compatible base handling, subtitle
and audio negotiation fixes, unsupported-video routing, Matroska timestamp
correction, terminal fallback containment, and removal of representative native
source ceilings are committed and pushed. The current worktree adds bounded PCM
packet batching and startup buffering, independent multi-video-track selection,
exact Ultra HD native capability precedence, and an accepted source-
renegotiation lifecycle that preserves the original PlaybackManager session.

## Current objective

Remove scheduler-dependent audio starvation from small decoded-PCM packets and
prevent custom-source renegotiation from detaching Jellyfin's UI session. The
remaining objective is live qualification of the supplied timing case, initial
and established renegotiation, exact Ultra HD source decoding, and ordinary
multi-video sources. Automated tests are necessary but do not replace these
browser exercises.

## Current native capability and transfer-resource slice

- Native SDR, native raw HDR, native external HDR, and native Dolby Vision
  eligibility use the selected source dimensions and do not compare its Width,
  Height, VideoLevel, or VideoFramerate against representative capability
  fixture values. The worker still requires the selected Mediabunny track's
  exact decoder configuration to pass `canDecode()` before producing frames.
- The absolute 3840x2160 raw-copy rejection is removed. Aligned plane layout is
  computed first, one transferable is limited to 128 MiB, and the existing two
  raw credits bound transferred buffers to 256 MiB in flight. Profile 7 counts
  base and enhancement layers in one compound transferable.
- WebGPU raw-plane texture creation retains the actual
  `GPUDevice.limits.maxTextureDimension2D` check. Allocation, copy, decoder,
  import, or GPU failures remain bounded fallbacks; no encoded bitrate is used
  to predict malformed media or select a route.
- Jellyfin profile conditions are split by supported custom versus
  non-custom containers. Native custom clones remove fixture-derived Width,
  Height, VideoLevel, and VideoFramerate conditions. Retry and non-custom HTML
  profiles retain their originals, while measured MPEG-2, JPEG 2000, and
  bundled HEVC profiles reapply their real software geometry/level/frame-rate
  bounds.
- Focused tests cover an ordinary 7680x4320 I420P10 transfer, computed byte
  overflow, the Profile 7 compound bound, standards-consistent native 8K
  metadata, preserved software limits, cumulative profile matching, and
  missing/extreme encoded bitrate invariance. The integrated gates pass: 414
  focused tests, 1591 tests across the complete 108-file WebGPU suite,
  TypeScript checking, scoped ESLint, and a development build. Real browser
  playback above 2160p remains a separate manual qualification requirement.

## Current subtitle, audio, routing, and fallback integration

- Custom playback keeps Jellyfin's text-subtitle layer and now owns dedicated
  ASS/SSA and PGS canvases above the WebGPU canvas. Their clocks follow the
  wrapper's millisecond boundary for play, pause, wait, seek, offset, track
  switch, aspect, resize, stop, and destroy. The native HTML paths are unchanged.
- The device profile advertises external VTT plus ASS/SSA and PGS only when the
  corresponding DOM/Worker/WebAssembly renderer environment exists. It retains
  server Encode profiles, removes unsupported External claims, deduplicates the
  result, and keeps retry profiles conservative.
- Stereo 48 kHz E-AC-3 is authorized through the existing bundled decoder.
  Normal decoded-audio routes advertise a target-neutral nonzero sample rate;
  complementary profiles reject values below 3000 Hz or above 192000 Hz. This
  prevents Jellyfin from misreading the route ceiling as a requested 192 kHz AAC
  transcode output while preserving the exact runtime envelope.
- Wrapper selection now declines media whose complete item metadata proves the
  video route is unsupported, including VC-1, interlaced or out-of-envelope
  MPEG-2, and AV1 Main10 SDR. The separately registered HTML player therefore
  owns those sessions. Missing selection metadata remains conservative; the
  negotiated-source gate still performs the exact check later.
- Matroska may independently quantize the anchor and current DTS packet
  timestamps to milliseconds. The resampler accepts at most those two 1 ms
  quantization errors plus one source-sample rounding interval, records each
  correction, and canonicalizes accepted timestamps onto its integer sample-
  count clock. A truly missing DTS access unit remains a fatal discontinuity.
- Small passthrough PCM packets are accumulated into at least 40 ms output
  chunks before crossing the worker boundary. The session requires at least
  100 ms of submitted decoded PCM before declaring media ready. At the normal
  eight-credit limit this permits about 320 ms of queued output instead of only
  40 ms for a 5 ms-packet source, and cuts its message cadence from 200 to about
  25 audio chunks per second. Finalization still emits the bounded terminal
  tail, and each new generation resets and requalifies its startup buffer.
- Mediabunny's `unsupported content encoding; dropping` warnings for unrelated
  Matroska subtitle/attachment tracks are nonfatal during video/audio track
  discovery. Custom subtitle selection uses Jellyfin's external subtitle URL;
  the Archer termination was the separate DTS timestamp discontinuity, not
  those warnings. Do not suppress the warnings or infer selected-track support
  from them; the subtitle route still requires its own live evidence.
- Custom terminal failures first detach and destroy owned decode/audio state.
  A source incompatibility now emits a synchronous, explicitly accepted
  PlaybackManager renegotiation request. Initial startup defers the accepted
  retry until the original session has emitted `playbackstart`; established
  playback retries immediately. An accepted request does not return
  `PLAYBACK_SUPERSEDED` or emit the generic terminal error, preventing a
  replacement source from playing behind the home screen. A partially started
  native fallback is still stopped before its error is exposed.

Focused automated coverage exists for all of these contracts. They are not yet
live-qualified. Required manual cases are: Fight Club PGS direct delivery and
visible seek/offset/switch behavior; Infinity Train stereo E-AC-3; AV1 Main10
SDR, VC-1, and interlaced MPEG-2 selection by the HTML player; and Archer DTS
playback without a resampler error, duplicate HLS request, navigation, or
background audio.

The existing browser-smoke controller now has a fail-closed subtitle mode. It
preflights private media/license/sidecar inputs, records only sanitized hashes
and route/resource evidence, drives cue/pause/seek/offset/switch/deselect and
delayed-fetch exercises, restores the initial state, and checks post-stop
surface/worker cleanup. Paired HTML/custom result joining, reviewed visual
baselines, checked subtitle fault IDs, 30-session retention integration, and
expected private-input digests remain explicit framework work.

## Profile 7 and stereo FLAC negotiation checkpoint

- Exact Profile 7 compatibility-ID-6 sources with explicit limited BT.2020
  non-constant/PQ metadata may use the independently authorized native HEVC
  external-PQ route when full raw Dolby Vision is outside its measured geometry,
  level, or frame-rate envelope.
- Full raw Profile 7 remains preferred when qualified. The device profile keeps
  route-specific measured limits and prevents its narrower raw route from
  cumulatively capping the same source's valid HDR10-compatible base.
- Base playback strips RPU and enhancement NAL units, skips the enhancement
  decoder and RPU parser, and continues through the static-HDR pipeline without
  restarting or renegotiating the playback session.
- Custom decoded-PCM containers no longer inherit HTML `AudioBitDepth`
  restrictions. Non-custom containers retain their original constraints. The
  exact audio decoder probe, codec/container/layout rules, and integer
  3000-192000 Hz source-rate boundary remain mandatory.
- Stereo FLAC tests cover 8/16/20/24/32-bit metadata, representative and unusual
  bounded sample rates, missing/extreme encoded bitrates, and the two adjacent
  out-of-range sample-rate failures.
- Five focused Vitest files pass 440 tests. The user-deployed Jellyfin 12
  nightly bundle is reported to play successfully, but no structured
  client/server DirectPlay or route evidence has yet been captured for this
  exact Profile 7 checkpoint.

The current authoritative integration server is a Jellyfin 12 nightly serving
this repository's current built bundle on `http://localhost:8096`. Jellyfin
10.11.6 results in the plan are historical checkpoint records, not evidence for
the current worktree. Local installation paths, account values, media item IDs,
and authenticated URLs must remain outside repository documentation and
reports.

`src/config.json` currently enables WebGPU player registration, custom decode,
and HDR tone mapping. The persistent playback setting selects Auto, HTML, or
WebGPU for the next session, and HTML remains the same-session fallback. The
validation harness remains disabled by default.

## Unified validation framework foundation

Implemented after checkpoint `750a470817`:

- `scripts/webgpu/validation/manifest.json` registers 15 stable cases with
  expected routes and numeric thresholds. Four checked generator-owned
  fragments expand to the 15 current exact-codec fixtures.
- Manifest, private-overlay, failure-vocabulary, result, and reviewed-baseline
  JSON Schemas are checked in. The dependency-free Python validator also
  rejects unknown keys, duplicate IDs, traversal, dangling references, cycles,
  unsafe arguments, missing license evidence, and ambiguous supersession.
- Every selected fixture is checked for availability, exact byte length, and
  SHA-256 before an adapter runs. Private fixtures use `env://` URIs and still
  require hashes, provenance, generators, and license evidence.
- Commands use fixed argument vectors and adapter-specific environment option
  whitelists. No manifest field is executed as a shell command.
- Static, checkpoint, and release matrices support case/codec/route/GPU/tag/
  soak selectors. Shared checks are deduplicated; release `full-vitest`
  supersedes the focused exact-codec invocation.
- Results capture commit/dirty state, OS, tools, explicit not-recorded runtime
  fields, fixture hashes/licenses, expectations, thresholds, checks, cases,
  failures, and evidence artifacts. Declared private inputs, URLs, credentials,
  token queries, and absolute Windows paths are sanitized before writing.
- Each run emits JSON, Markdown, standalone HTML, a manual checklist, and
  per-check structured evidence under ignored `/artifacts/`.

Reviewed baselines pin the manifest and private-overlay digests, selection,
sanitized environment, fixture identities, passing records, and explicit
integer timing thresholds. Approval rejects dirty or failing results and
requires reviewer acknowledgement; replacement is explicit and validates the
old baseline first. Comparison is read-only and makes the run fail on drift.

Fixture generators now own complete registry records for JPEG 2000,
progressive MPEG-2, DTS, and TrueHD/MLP. The registry-only generator derives
size and SHA-256 from exact bytes, verifies all checked fragments, and keeps
the main manifest free of duplicate fixture data. Result evidence distinguishes
the source-manifest hash from an effective digest covering every ordered
fragment, so a fragment revision invalidates a baseline.

The baseline checkpoint's qualified static run passed 15 fixture hashes, 15
cases, 43 Python tests, 135 standalone Node tests, 383 focused Vitest tests
across 19 files, and the TypeScript check. The generated-registry checkpoint
matrix passes the same fixtures and cases plus all 10 required checks,
including 50 Python tests and a development build. At those baseline
checkpoints the source feature flags were false. Static success does not claim
live Jellyfin DirectPlay; live cases must use exact private overlays or later
canonical distributable fixtures.

The live integration slice now adds a checked catalog of 18 exact SDR/HDR/
Dolby Vision presentation routes and eight lifecycle/fault/startup/retention
exercises. `generate_validation_live_overlay.py` expands ignored private source
specifications into content-addressed overlays, computes media hashes, verifies
private input presence, and validates the result through the production loader.
Exact route assertions distinguish external PQ/HLG, raw PQ/HLG, Profile 5,
Profile 7 MEL/FEL/base fallback, and Profile 8 instead of accepting any generic
HDR route. Browser evidence now records browser, WebGPU/CDP GPU and driver,
display HDR, Jellyfin version/platform, and the request-intercepted feature
flags in the shared environment header.

The generated private High Tier HDR10 lifecycle case passed end to end on the
live Jellyfin 12.0.0 port-8096 session with Chrome 151, the exact native
external-PQ route, decoded PCM audio, no failures, and sanitized evidence. The
run populated the NVIDIA adapter/driver, SDR display state, server version, and
active feature flags instead of `not-recorded` placeholders. This is one local
route execution, not the complete private-live matrix.

The browser adapter now accepts an exact expected Jellyfin play method. It
records the player-selected method and capability booleans, queries the active
Jellyfin device/item/media-source session, and reports only match booleans,
method, transcode state, and reason names. A DirectPlay assertion rejects active
`TranscodingInfo` or any reason. The current Dark Knight High Tier HDR10/FLAC
port-8096 smoke passed with client and server `DirectPlay`, a matching media
source, no active transcode, and no reasons. No item ID, media-source ID, device
ID, or stream URL is retained. The harness now defaults to Jellyfin's normal
`http://localhost:8096/web` frontend instead of the nonexistent port-root
`config.json` path. Regenerating the browser-only private catalog and selecting
its lifecycle case passed one fixture, one case, and both the runtime and
browser checks; the resulting six evidence files passed a private-value scan.

The browser adapter now optionally snapshots the Jellyfin primary and FFmpeg
transcode logs before playback, reads at most 8 MiB appended during the bounded
exercise, and resolves the private account/title values only for in-memory
matching. It reports no raw lines, filenames, paths, names, tokens, IDs, or
URLs. Generated private browser cases require this evidence. The Dark Knight
lifecycle rerun on port 8096 recorded one exact `start,stop` pair, one policy
record, zero server errors/warnings, zero transcode-log activity, and matching
client/server DirectPlay without retaining private values.

The server-log checkpoint matrix passes all 15 fixtures/cases and all 10
required checks: 57 Python tests, 143 standalone Node tests, 383 focused Vitest
tests, TypeScript, runtime-toolchain readiness, and a development build. At
that checkpoint the source feature flags were disabled.

The generated High Tier HDR startup gate now excludes the color-invalid
presentation-only mode by exact route, while SDR identity retains all three
modes. The passed rerun contains 10 matched HTML/custom rounds plus two warmups,
22 exact server start/stop pairs, zero server errors, zero transcode-log
activity, and no private-value leak. Custom median/p95 first-visible-frame
regression versus HTML was -79.3/-11.9 ms; custom first-audio regression was
-24.1/84.0 ms, inside the fixed release thresholds.

The complete browser-only primary HDR10 matrix passes all six cases and seven
checks across 62 controlled DirectPlay sessions: lifecycle, five-session reuse,
active and paused device loss, startup, and 30-session retention. Every case
recorded exact paired server starts/stops, zero server errors/warnings, zero
transcode-log activity, and zero browser errors. Device-loss cases performed
one recovery without source restart. The retention run ended with no live GPU,
`VideoFrame`, custom worker, or WASM objects; listener/node growth was zero,
and all heap slopes/growth stayed inside the fixed gates.

The first real-title Profile 5 run correctly passed the browser/GPU capability
and external-texture authorization probes but Jellyfin selected transcoding for
audio codec, video level, and resolution reasons. The failure report now
captures a sanitized relevant slice of the generated device profile as well as
the bounded client/server decision evidence. That evidence showed a shared HEVC
compatibility profile had intersected the 1080p raw-Dolby-Vision limits with the
independent 4K native Profile 5 limits. The shared profile now uses the largest
authorized compatibility envelope so it cannot reimpose a weaker route's cap;
the range-scoped measured profiles still enforce the exact resolution, level,
frame-rate, bit-depth, and profile bounds for each route.

The corrected private Profile 5 matrix passes lifecycle, active device loss,
and paused device loss on Jellyfin 12 nightly and Chrome 151. Client and server
both report DirectPlay with no transcode reasons. The native HEVC path delivered
Profile 5 RPUs and frames to the external-texture shader, bundled E-AC-3 decoded
the selected 5.1 track to bounded stereo PCM, and all three cases completed
without fallback, browser errors, or observed ownership warnings. This is one
private title on one browser/GPU system, not completion of the Profile 5 release
matrix.

Remaining Group B work:

1. Expand the generated private catalog beyond the completed primary HDR10 and
   initial Profile 5 browser matrices to the remaining color/HDR/Dolby Vision
   routes, worker cases, and mpv A/B records, then execute and approve them.
2. Unify failure injection by case ID. Bounded active-session API and sanitized
   server-log evidence are complete.
3. Add manual-observation ingestion and pairwise/boundary matrix generation.
4. Execute the same environment contract on Edge plus AMD and Intel systems;
   retain explicit `not-recorded` values only for matrices with no live adapter.

## Current integration checkpoint

- The decoded-PCM output route now uses the browser's exact
  `AudioContext.destination.maxChannelCount` result. Complete 5.1 beds may use
  six speaker-interpreted channels and complete 7.1 beds may use eight. Any
  missing, invalid, changing, or insufficient capability retains the existing
  qualified stereo downmix. There is no partial 7.1-to-5.1 route and no new
  compressed-passthrough or server capability claim.
- Encoded audio bitrate is telemetry only. Every decoded-PCM route now uses one
  source-rate contract: any safe integer from 3000 through 192000 Hz is
  eligible for normalization to 48 kHz. Codec, container, profile, and channel
  layout remain explicit constraints, and native/WebCodecs or bundled decoders
  must still accept the actual configuration. The native AC-3/E-AC-3 MSE bridge
  remains an exact 48 kHz route; the software PCM fallback uses the bounded
  contract. Audio prewarm validates the selected source rate but always creates
  the actual 48 kHz decoded-PCM output context, so 96 kHz and nonstandard source
  rates do not discard the user-activation-time context.
- HEVC HDR10+ ST 2094-40 metadata now travels from bounded prefix/suffix SEI
  parsing through an exact-PTS queue to renderer settings version 7. The
  implemented subset is application version 0/1 with one whole-frame processing
  window and no peak-luminance grid. Missing, malformed, conflicting, or
  unsupported metadata clears the dynamic state for that frame and uses static
  HDR10. AV1, VP9, H.264, multiwindow, and grid HDR10+ remain unsupported.
- Dolby Vision continues to use its existing exact-PTS RPU path. This checkpoint
  does not add or infer metadata from decoded `VideoFrame` objects.
- The hardware runner records Chrome/Edge x NVIDIA/AMD/Intel as a fixed six-cell
  matrix and refuses to infer unavailable hardware. On this host, Chrome/NVIDIA
  passed four of five live exercises and all six route authorizations, but the
  30-session retention exercise timed out. Edge/NVIDIA probing succeeded, while
  live custom-playback entry remains unresolved; AMD and Intel were not run.
- The Chrome retention result remains a fail-closed record of the deferred
  Mediabunny `VideoSample` ownership/long-session risk. It is not being repaired
  in this checkpoint by explicit project direction.

## Codec and layout checkpoint

| Route | Current authorized input | Decoder and output | Explicit exclusions |
| --- | --- | --- | --- |
| JPEG 2000 | `MJ2` or QuickTime `MOV`; `mjp2`; progressive unsigned 8-bit sRGB/gray; at most 960x540 and 24 fps | Mediabunny packets -> pinned OpenJPEG WASM -> owned RGBA `VideoFrame`; exact fingerprint and at least 30 decode/output fps | HDR, high bit depth, MXF, DCI 2K/4K, JPX/HTJ2K, alpha, signed or ambiguous component layouts |
| MPEG-2 Video | Matroska only; Main Profile; progressive 8-bit SDR; at most 1920x1080 and 24 fps | Mediabunny packets -> focused MPEG-2-only FFmpeg WASM -> owned I420 `VideoSample`/`VideoFrame`; exact reordered output and at least 30 fps | VC-1, WMV3, MPEG-1, interlaced MPEG-2, non-Main profiles, TS/MTS/M2TS, PS/VOB, MOV, MP4, and every non-Matroska container |
| DTS family | Matroska only; fixture-proven profile/layout pairs at integer source rates from 3000 through 192000 Hz; rates above 96 kHz require a 5.1 MA or MA+DTS:X bed | Mediabunny `A_DTS` packets -> pinned `libdcadec` WASM -> exact WAVE layout -> native 5.1/7.1 only when the complete physical bed is exposed, otherwise stereo 48 kHz PCM | Unlisted profile/layout pairs, rates outside the bounded contract, TS/MTS/M2TS, MOV/MP4, DTS:X object rendering, and passthrough |
| TrueHD/MLP | Matroska only; TrueHD stereo/5.1 or MLP stereo at integer source rates from 3000 through 192000 Hz | Mediabunny `A_TRUEHD`/`A_MLP` packets -> focused FFmpeg WASM -> exact WAVE layout -> native 5.1 only when six output channels are exposed, otherwise stereo 48 kHz PCM | TrueHD 7.1/eight-channel claims, MLP surround, rates outside the bounded contract, TS/MTS/M2TS, Atmos object rendering, and passthrough |

### DTS capability fixtures and rate contract

1. DTS Core, 5.1, 48 kHz
2. DTS 96/24, 5.1, 96 kHz
3. DTS-ES, 6.1, 48 kHz
4. DTS-HD HRA, 7.1, 48 kHz
5. DTS-HD MA, 7.1, 48 kHz
6. DTS-HD MA, 7.1, 96 kHz
7. DTS-HD MA, 5.1, 192 kHz

These seven tuples are exact decoder, layout, output, and throughput fixtures;
they are not a sample-rate whitelist. They authorize their profile/layout pairs
across the shared bounded source-rate contract. Above 96 kHz, only 5.1 DTS-HD
MA or DTS-HD MA + DTS:X is admitted. The DTS:X label still decodes only the MA
channel bed.

### TrueHD/MLP capability fixtures and rate contract

1. TrueHD, stereo, 48 kHz
2. TrueHD, 5.1, 96 kHz
3. TrueHD, 5.1, 192 kHz
4. MLP, stereo, 48 kHz

These four tuples prove the decoder and the TrueHD stereo/5.1 and MLP stereo
layout families; they are not a sample-rate whitelist. Each supported
codec/layout pair accepts bounded integer source rates from 3000 through
192000 Hz and normalizes them to 48 kHz. Atmos metadata may be detected, but
output remains the lossless channel bed.

## Implemented in the worktree

- Pinned decoder artifacts, focused build scripts, license/source/revision
  records, and artifact verifiers for OpenJPEG, MPEG-2, DTS, and TrueHD/MLP.
- Exact capability workers and deterministic fixtures for every claimed route.
- Mediabunny packet demux, signed-microsecond timestamps, seek positioning, and
  generation-safe iterator retirement.
- Owned decoder contexts, copied output memory, bounded packets/frames/queues,
  and existing WebGPU/AudioWorklet presentation paths.
- Fixture-derived DTS and TrueHD profile/layout tables plus one shared bounded
  source-rate contract across eligibility, device profiles, protocol checks,
  resampling, and runtime validation.
- Controller, session, and worker protocol support for the focused
  `openjpeg` and `legacy-software` video backends.
- Portable mpv/browser A/B tooling. Example manifests contain placeholders;
  local media IDs and credentials belong in environment variables or private
  manifests only.
- Version 6 HDR settings use a libplacebo-derived static spline in IPTPQc4 and
  bounded perceptual BT.709 chroma compression across external, raw, and Dolby
  Vision shaders. The spline now uses libplacebo's nominal PQ black point of
  0.000001 nit and its 1000:1 SDR output contrast before black-point
  compensation. The gamut stage remains analytic; it is not claimed to
  reproduce libplacebo's generated 3D perceptual LUT exactly.
- The custom HEVC worker parses mastering-display and content-light SEI payloads
  from up to 16 startup access units and an 8 MiB accumulated packet budget,
  forwards validated static metadata through the session/controller protocol,
  and applies the mastering-display maximum, or MaxCLL when no mastering maximum
  exists, before the first non-Dolby-Vision PQ frame. Consistent partial fields
  merge across access units. Missing, malformed, or conflicting optional
  metadata is reported explicitly and retains the bounded 1000-nit default
  without interrupting decode. Metadata beyond the startup prefix remains
  unsupported. Exact-PTS HEVC HDR10+ is handled separately by the version 7
  dynamic path described above.
- All seven HDR/Dolby Vision shader variants compile and create pipelines in
  Chrome 151 WebGPU. A five-frame private HDR10 comparison against mpv spline
  now records static-reference mean/minimum SSIM of 0.9938272/0.990991 and
  mean/minimum PSNR of 39.421/37.965 dB. Dynamic-reference mean/minimum SSIM is
  0.992474/0.989412. The exact source supplied a 4000-nit mastering maximum;
  the run used that peak, DirectPlay, native HEVC `VideoFrame`, external PQ,
  settings version 6, and decoded FLAC with zero browser errors or ownership
  warnings.
- The same ten-second capture presented 238 changed frames. Media intervals
  were 42 ms at median, p95, and maximum; wall intervals were 41.7 ms median,
  41.8 ms p95, and 97.2 ms maximum. Browser-minus-mpv PCM RMS was 0.00032 dB,
  the peaks were identical within floating-point precision, and neither output
  contained clipping or non-finite samples.
- External Profile 5 authorization fixture version 2 now bounds browser-recovered
  10-bit base signals separately from output shader parity. Chrome 151 authorized
  the renderer-settings-version-6 route with maximum normalized input error
  0.00497875 and maximum output error 0.00253959; the output tolerance remains
  8/255.
- The mpv A/B browser capture now reuses the shared runtime-config interceptor,
  so disabled source flags are enabled only in the capture request. Frontend
  asset resolution is stable with or without a trailing `/web/` separator.
- Ordinary browser smoke now uses the same request-scoped interceptor instead
  of depending on locally enabled `dist/config.json` flags. A live high-tier
  HDR10 custom DirectPlay smoke on Chrome 151 passed with active external PQ
  and the prewarmed Profile 5 fixture version 2, with no fallback or browser
  error. The later four-state static-HDR live matrix retained the current
  version-6 Profile 5 authorization values recorded above.
- Failure diagnostics now retain only profile entries matching the active
  container and video/audio codecs plus bounded playback-decision fields. The
  Profile 5 negotiation fix keeps a non-blocking shared compatibility envelope
  while route-scoped measured profiles retain exact independent caps.
- Browser evidence now retains the static HDR scan status, scanned access-unit
  count, and first metadata index. The live High Tier HDR10 lifecycle passed
  with 16 scanned access units, metadata first observed at index 0, `valid`
  status, a 4000-nit input peak, native HEVC DirectPlay on client and server,
  decoded FLAC, zero transcode reasons, and zero fallback. A ten-round paired
  startup gate also passed: custom first-visible median/p95 regression versus
  HTML was -81.9/7.1 ms and first-audio regression was 9.9/97.2 ms, within the
  fixed 250/500 ms gates.
- Generated ordinary-PQ live specifications can now require the exact static
  metadata status and tone-mapping peak. Lifecycle checks validate the bounded
  scan count and first matching access unit, and every custom startup sample
  repeats the same assertions while retaining the values as evidence. The live
  High Tier HDR10 lifecycle and paired startup selectors passed with `valid`,
  access unit 0 of 16, and 4000 nits.
- A deterministic generator now creates 12-second PQ Main10/FLAC Matroska
  fixtures for `absent`, `malformed`, `conflicting`, and valid 4000-nit static
  metadata. The live wrapper verifies byte identities, exact Jellyfin paths,
  the production Mediabunny/TypeScript parser, private-value sanitization, and
  all browser/server DirectPlay contracts. TypeScript's ES5 transform initially
  erased the conflict error prototype in the worker; explicitly restoring it
  fixed the emitted bundle without weakening generic malformed detection.
- `WebGPUPlayer` now accepts the slider's numeric string, validates and forwards
  a numeric 0-100 value, and applies Jellyfin's cubic gain to custom output.
  Track/album/off normalization follows `HtmlAudioPlayer` precedence and stays
  independent from volume and mute. Decoded PCM permits gain above unity;
  native-media audio caps at one because the media element cannot amplify.
  Every custom-audio lifecycle now verifies string volume, cubic gain, mute,
  invariant normalization, and restoration.
- A sanitized CDP runtime probe now reports the active normalization mode and
  bounded catalog metadata coverage without retaining account or media
  identities. The current authenticated video catalog supplies no track or
  album gain metadata, so those movie sessions correctly use unity. Jellyfin's
  stock LUFS task covers audio-library items rather than ordinary videos; this
  path is metadata-driven and is not a movie loudness analyzer.
- A compact generated 12-second 4K24 PQ Main10 High Tier Level 5.1
  Matroska/FLAC fixture now verifies the actual SPS high-tier bit, Main10
  profile, Level 153, progressive signaling, valid 4000-nit static metadata,
  and a bitrate-free live route record. Its dedicated wrapper resolves the
  Jellyfin item by exact path and performs the production metadata preflight,
  private overlay, browser lifecycle, server-log, and privacy checks.

## Completed checkpoint gates

- The Profile 7 HDR10-base and custom-audio negotiation checkpoint passed five
  focused Vitest files and 440 tests. The suites cover exact color/descriptor
  parsing, independent device-profile envelopes, full-Dolby-Vision preference,
  native base fallback, RPU/EL stripping without parser invocation, and the
  generalized stereo FLAC metadata matrix. The manual deployed playback report
  is retained as smoke evidence only.
- The bounded audio source-rate integration passed TypeScript, 1,529 WebGPU
  Vitest tests across 108 files, 147 standalone Node harness tests, 96 Python
  harness tests, full WebGPU plugin plus changed-script ESLint, development and
  production builds, and ordinary codec artifact verification. Jellyfin 12
  nightly served that production bundle on port 8096 with the ignored local
  feature overlay enabled; source feature flags were false at that checkpoint.
- The generated native High Tier fixture passed one live lifecycle case and
  both required checks on Jellyfin 12 nightly and Chrome 151: client/server
  DirectPlay, native HEVC `VideoFrame`, external HDR, decoded FLAC, valid static
  metadata at access unit 0 of 16, slider/mute restoration, no transcode log,
  and no browser failure. Its production Mediabunny/parser preflight also
  passed before browser execution.
- The combined static-HDR/audio checkpoint matrix passed all 15 fixture hashes,
  all 15 cases, and all 10 checks: 384 focused codec-contract Vitest tests,
  144 standalone Node tests, 73 Python tests, TypeScript, runtime-toolchain
  readiness, DTS/downmix/registry freshness, and a development build. The full
  WebGPU player suite independently passed 1,445 tests across 103 files;
  changed-file ESLint and the codec artifact verifier also passed.
- The combined four-state static-HDR and audio-control live run passed four
  fixtures, four lifecycle cases, five checks, and four production-parser
  preflights on Jellyfin 12 nightly and Chrome 151. Every case recorded exact
  DirectPlay, static scan/peak state, a slider-string transition to level 37,
  the corresponding cubic gain, mute, unity normalization for the generated
  source, exact restoration, sanitized server logs, and no browser failure.
- The static-HDR live-contract worktree passed all 15 canonical fixture hashes
  and cases plus all 10 checks: 384 focused codec-contract Vitest tests, 144
  standalone Node tests, 60 Python tests, TypeScript, runtime-toolchain
  readiness, artifact/fixture freshness, and a development build. Focused
  changed-file ESLint and generator tests passed. Independent generated live
  lifecycle and paired-startup selectors also passed on Jellyfin 12 nightly and
  Chrome 151 with exact DirectPlay and server-log evidence.
- The bounded static-HDR-prefix checkpoint passed all 15 canonical fixture
  hashes and cases plus all 10 required checks: 384 codec-contract Vitest tests
  across 19 files, 143 standalone Node tests, 57 Python tests, TypeScript,
  runtime-toolchain readiness, downmix/artifact freshness, and a development
  build. The affected HDR/session/player suites passed 225 focused tests. The
  independent live lifecycle and paired ten-round startup gates also passed on
  Jellyfin 12 nightly and Chrome 151.
- The Profile 5 negotiation worktree checkpoint passed all 15 canonical
  fixture hashes and cases plus all 10 checks: 384 focused Vitest tests across
  19 files, 143 standalone Node tests, 57 Python tests, TypeScript,
  runtime-toolchain readiness, downmix/artifact freshness, and a development
  build. The independent HDR10 lifecycle regression and the three-case private
  Profile 5 matrix also passed on Jellyfin 12 nightly.
- The static-HDR-metadata checkpoint passed the canonical matrix: all 15
  fixture hashes, 15 exact cases, and 10 required checks, including TypeScript,
  focused Vitest codec contracts, 143 standalone Node tests, 57 Python tests,
  downmix references, artifact/fixture freshness, runtime-toolchain readiness,
  and a development build. The private mpv selector also passed its fixture,
  toolchain, and A/B checks through the unified matrix.
- The playback-decision follow-up passed the canonical checkpoint matrix: all
  15 fixture hashes, 15 cases, and 10 checks; 57 Python tests, 138 standalone
  Node tests, 383 focused Vitest tests, TypeScript, runtime-toolchain readiness,
  and a development build. Focused JavaScript lint, generator tests, whitespace,
  disabled source flags, a live 8096 DirectPlay session, and a private-value
  scan also passed.
- The live-catalog checkpoint passed 15 canonical fixture hashes/cases and all
  10 required checks: 57 Python tests, 136 standalone Node tests, 383 focused
  Vitest tests, TypeScript, runtime-toolchain readiness, and the development
  build. Changed JavaScript lint, both new JSON Schemas, whitespace checks, and
  disabled source feature flags also passed.
- TypeScript passed; Vitest passed 119 files and 1,620 tests; the standalone
  Node harness passed 135 tests; Python discovery passed 21 tests; full ESLint
  completed with zero errors and 97 pre-existing warnings; Stylelint passed.
- DTS, TrueHD/MLP, and MPEG-2 rebuilt twice from their pinned source archives
  with byte-identical runtime output. Standalone and central artifact verifiers
  accepted the source, license, bridge, toolchain, revision, fixture, and
  runtime hashes.
- Development and production Webpack builds passed. The current production
  bundle served by Jellyfin 12 nightly on port 8096 enables the WebGPU player,
  custom decode, and HDR tone mapping; the validation harness stays disabled.
- Chrome 151 completed pause/resume, fullscreen, resize, primary seek, a
  three-seek storm, FLAC stream selection, exact stop, and a two-session replay
  through the custom DirectPlay route with no fallback, browser error, stale
  frame/sample, or observed ownership warning.
- Injected WebGPU device loss recovered exactly once without restarting or
  falling back. External PQ/HLG, Profile 5 fixture version 2, and Profile 7
  base/FEL authorizations remained valid.
- The real-title Profile 5 private matrix passed lifecycle, active device loss,
  and paused device loss through custom DirectPlay with decoded 5.1 E-AC-3,
  external Profile 5 presentation, and no transcode reasons or fallback.

## Remaining product validation

1. Capture one exact 4K Profile 7 compatibility-ID-6 session through the shared
   browser/server harness. Require client and server DirectPlay, the native HEVC
   external-PQ route, no enhancement decoder or RPU parse, valid static-HDR
   state, no transcode reasons, and bounded lifecycle/resource telemetry.
2. Capture stereo FLAC sources spanning ordinary 24-bit metadata plus unusual
   supported bit depth/rate metadata. Confirm audio never creates a bit-depth,
   bitrate, or common-rate transcode reason while an actual decoder rejection
   still fails closed.
3. Run Jellyfin 12 nightly DirectPlay negotiation for every supported
   profile/layout pair at lower, representative, 96 kHz transition, and upper
   source-rate boundaries plus nearby negatives. Confirm Playback Info never
   widens DTS or TrueHD beyond the listed envelope.
4. Exercise start, pause/resume, representative seeks, seek storms, audio
   switching, natural EOF, explicit stop, replay, source replacement, and
   repeated sessions for every new route.
5. Measure combined software-video plus software-audio throughput. JPEG 2000 or
   MPEG-2 paired with DTS or TrueHD shares one decode worker, so independent
   per-codec throughput probes do not by themselves prove a combined route can
   sustain real time.
6. Compare decoded PCM and representative video frames against FFmpeg/mpv
   references, including long-run A/V drift and queue telemetry.
7. Run non-unity TrackGain and AlbumGain against HtmlAudioPlayer on a generated
   audio-library fixture. Before claiming the same for WebGPU movie playback,
   define a legitimate server or client source of video loudness metadata; the
   stock Jellyfin task does not populate it for ordinary videos.
8. Keep the intermittent Mediabunny `VideoSample` ownership warning as a
   documented deferred defect. The final checkpoint runs observed zero
   warnings, but that does not prove leak-free soak behavior; do not suppress
   its console assertion or make a leak-free claim until the ownership boundary
   is fixed and retention evidence passes.
9. Keep the player available through the persistent user preference and retain
   HTML same-session fallback. Keep the validation harness disabled outside
   intentional test runs, and do not widen runtime capability probes before the
   supported browser/GPU/output/server matrix passes.
10. Physically verify 5.1 and 7.1 channel isolation, ordering, output-device
   changes, mute, volume, normalization, seeking, and fallback in Chrome and
   Edge. Automated channel-array tests do not prove speaker wiring.
11. Run decodable real HDR10+ material through a temporal browser capture and
   compare exact frames against pinned mpv/libplacebo output. Include scenes
   with changing peaks and static-fallback frames.
12. Reproduce Edge custom-playback entry while capturing active pre-stop state;
    the current post-stop snapshot does not prove its persisted
    `play-method-unsupported` value caused the failure.
13. Execute the checked hardware plan on physical AMD and Intel systems and run
    visual HDR output checks on an HDR-capable display.

## Navigation

- `webgpu_plan_2.md`: encompassing product plan and validation matrix
- `WEBGPU_JPEG2000.md`: exact OpenJPEG route and expansion procedure
- `WEBGPU_LEGACY_VIDEO.md`: exact progressive MPEG-2 Matroska route
- `WEBGPU_DTS.md`: DTS fixture evidence, profile/layout rules, and bounded-rate route
- `WEBGPU_TRUEHD.md`: TrueHD/MLP fixture evidence, layout rules, and bounded-rate route
- `WEBGPU_AUDIO_MULTICHANNEL.md`: native decoded-PCM output policy and physical
  qualification requirements
- `WEBGPU_DYNAMIC_HDR.md`: exact HDR10+/Dolby Vision dynamic-metadata contract
- `WEBGPU_HARDWARE_MATRIX.md`: checked matrix tooling and current-host results
- `scripts/webgpu/README.md`: fixture, build, artifact, browser, and A/B commands
- `scripts/webgpu/validation/README.md`: shared matrices, schemas, selectors,
  reports, and private live-case overlays

No validation command is running. Deployment state is user-managed and is not
treated as repository validation evidence without a captured harness result.
