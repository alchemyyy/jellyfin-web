# WebGPU Player Current Work

Status recorded: 2026-08-03

Branch: `webgpu-player`

Parent checkpoint: `277e304763411d9d01ddd3010d37a2c058c99fb4`

Checkpoint state: generated private live-case catalog, bounded Jellyfin
playback-decision evidence, and server-log evidence are committed and pushed;
route-aware startup and the complete primary HDR10 browser matrix are validated
in the current worktree

## Current objective

Migrate live HDR/lifecycle/startup/soak/mpv evidence into the unified matrix
without duplicating route, fixture, or exercise definitions per private title.

The current authoritative integration server is a Jellyfin 12 nightly serving
this repository's current built bundle on `http://localhost:8096`. Jellyfin
10.11.6 results in the plan are historical checkpoint records, not evidence for
the current worktree. Local installation paths, account values, media item IDs,
and authenticated URLs must remain outside repository documentation and
reports.

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
including 50 Python tests and a development build.
Source feature flags remain false. Static success does not claim live Jellyfin
DirectPlay; live cases must use exact private overlays or later canonical
distributable fixtures.

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
tests, TypeScript, runtime-toolchain readiness, and a development build. Source
feature flags remain disabled.

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

Remaining Group B work:

1. Expand the generated private catalog beyond the completed primary HDR10
   browser matrix to the remaining color/HDR/Dolby Vision routes, worker cases,
   and mpv A/B records, then execute and approve those matrices.
2. Unify failure injection by case ID. Bounded active-session API and sanitized
   server-log evidence are complete.
3. Add manual-observation ingestion and pairwise/boundary matrix generation.
4. Execute the same environment contract on Edge plus AMD and Intel systems;
   retain explicit `not-recorded` values only for matrices with no live adapter.

## Exact codec checkpoint

| Route | Current authorized input | Decoder and output | Explicit exclusions |
| --- | --- | --- | --- |
| JPEG 2000 | `MJ2` or QuickTime `MOV`; `mjp2`; progressive unsigned 8-bit sRGB/gray; at most 960x540 and 24 fps | Mediabunny packets -> pinned OpenJPEG WASM -> owned RGBA `VideoFrame`; exact fingerprint and at least 30 decode/output fps | HDR, high bit depth, MXF, DCI 2K/4K, JPX/HTJ2K, alpha, signed or ambiguous component layouts |
| MPEG-2 Video | Matroska only; Main Profile; progressive 8-bit SDR; at most 1920x1080 and 24 fps | Mediabunny packets -> focused MPEG-2-only FFmpeg WASM -> owned I420 `VideoSample`/`VideoFrame`; exact reordered output and at least 30 fps | VC-1, WMV3, MPEG-1, interlaced MPEG-2, non-Main profiles, TS/MTS/M2TS, PS/VOB, MOV, MP4, and every non-Matroska container |
| DTS family | Matroska only; seven exact tuples listed below | Mediabunny `A_DTS` packets -> pinned `libdcadec` WASM -> exact WAVE layout -> stereo 48 kHz PCM | Any unlisted profile/layout/rate tuple, TS/MTS/M2TS, MOV/MP4, DTS:X object rendering, and passthrough |
| TrueHD/MLP | Matroska only; four exact tuples listed below | Mediabunny `A_TRUEHD`/`A_MLP` packets -> focused FFmpeg WASM -> exact WAVE layout -> stereo 48 kHz PCM | Any unlisted tuple, 7.1/eight-channel claims, TS/MTS/M2TS, Atmos object rendering, and passthrough |

### Exact DTS tuples

1. DTS Core, 5.1, 48 kHz
2. DTS 96/24, 5.1, 96 kHz
3. DTS-ES, 6.1, 48 kHz
4. DTS-HD HRA, 7.1, 48 kHz
5. DTS-HD MA, 7.1, 48 kHz
6. DTS-HD MA, 7.1, 96 kHz
7. DTS-HD MA, 5.1, 192 kHz

The DTS-HD MA tuples also accept the DTS:X label while decoding only the MA
channel bed. These tuples are a union, not a Cartesian product.

### Exact TrueHD/MLP tuples

1. TrueHD, stereo, 48 kHz
2. TrueHD, 5.1, 96 kHz
3. TrueHD, 5.1, 192 kHz
4. MLP, stereo, 48 kHz

These tuples are a union, not every combination of two/six channels and
48/96/192 kHz. Atmos metadata may be detected, but output remains the lossless
channel bed.

## Implemented in the worktree

- Pinned decoder artifacts, focused build scripts, license/source/revision
  records, and artifact verifiers for OpenJPEG, MPEG-2, DTS, and TrueHD/MLP.
- Exact capability workers and deterministic fixtures for every claimed route.
- Mediabunny packet demux, signed-microsecond timestamps, seek positioning, and
  generation-safe iterator retirement.
- Owned decoder contexts, copied output memory, bounded packets/frames/queues,
  and existing WebGPU/AudioWorklet presentation paths.
- Exact non-Cartesian DTS and TrueHD route tables shared by eligibility, device
  profiles, and runtime validation.
- Controller, session, and worker protocol support for the focused
  `openjpeg` and `legacy-software` video backends.
- Portable mpv/browser A/B tooling. Example manifests contain placeholders;
  local media IDs and credentials belong in environment variables or private
  manifests only.
- Version 5 HDR settings use a libplacebo-derived static spline in IPTPQc4 and
  bounded perceptual BT.709 chroma compression across external, raw, and Dolby
  Vision shaders. The gamut stage is analytic; it is not claimed to reproduce
  libplacebo's generated 3D perceptual LUT exactly.
- All seven HDR/Dolby Vision shader variants compile and create pipelines in
  Chrome 151 WebGPU. A five-frame private HDR10 comparison against mpv spline
  improved static-reference mean SSIM from 0.9617516 to 0.9886684 and mean
  PSNR from 29.199 dB to 38.116 dB. The same run had zero browser errors,
  zero ownership warnings, and decoded PCM matching the mpv analysis window.
- External Profile 5 authorization fixture version 2 now bounds browser-recovered
  10-bit base signals separately from output shader parity. Chrome 151 authorized
  the exact route with maximum normalized input error 0.00497875 and maximum
  output error 0.00267303; the output tolerance remains 8/255.
- The mpv A/B browser capture now reuses the shared runtime-config interceptor,
  so disabled source flags are enabled only in the capture request. Frontend
  asset resolution is stable with or without a trailing `/web/` separator.
- Ordinary browser smoke now uses the same request-scoped interceptor instead
  of depending on locally enabled `dist/config.json` flags. A live high-tier
  HDR10 custom DirectPlay smoke on Chrome 151 passed with active external PQ
  and the prewarmed Profile 5 fixture version 2. The Profile 5 maximum
  normalized input and output errors were 0.00497875 and 0.00267303
  respectively, with no fallback or browser error.

## Completed checkpoint gates

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
- Development and production Webpack builds passed. The production bundle is
  served by Jellyfin 12 nightly on port 8096; source feature flags remain false
  while the ignored local production config enables manual validation.
- Chrome 151 completed pause/resume, fullscreen, resize, primary seek, a
  three-seek storm, FLAC stream selection, exact stop, and a two-session replay
  through the custom DirectPlay route with no fallback, browser error, stale
  frame/sample, or observed ownership warning.
- Injected WebGPU device loss recovered exactly once without restarting or
  falling back. External PQ/HLG, Profile 5 fixture version 2, and Profile 7
  base/FEL authorizations remained valid.

## Remaining product validation

1. Run Jellyfin 12 nightly DirectPlay negotiation for every exact positive tuple
   and nearby negative tuple. Confirm Playback Info never widens DTS or TrueHD
   into a channel/rate Cartesian product.
2. Exercise start, pause/resume, representative seeks, seek storms, audio
   switching, natural EOF, explicit stop, replay, source replacement, and
   repeated sessions for every new route.
3. Measure combined software-video plus software-audio throughput. JPEG 2000 or
   MPEG-2 paired with DTS or TrueHD shares one decode worker, so independent
   per-codec throughput probes do not by themselves prove a combined route can
   sustain real time.
4. Compare decoded PCM and representative video frames against FFmpeg/mpv
   references, including long-run A/V drift and queue telemetry.
5. Keep the intermittent Mediabunny `VideoSample` ownership warning as a
   documented deferred defect. The final checkpoint runs observed zero
   warnings, but that does not prove leak-free soak behavior; do not suppress
   its console assertion or make a leak-free claim until the ownership boundary
   is fixed and retention evidence passes.
6. Keep all WebGPU feature flags disabled in source until the supported browser,
   GPU, output, and server matrix is complete.

## Navigation

- `webgpu_plan_2.md`: encompassing product plan and validation matrix
- `WEBGPU_JPEG2000.md`: exact OpenJPEG route and expansion procedure
- `WEBGPU_LEGACY_VIDEO.md`: exact progressive MPEG-2 Matroska route
- `WEBGPU_DTS.md`: exact seven-tuple DTS route
- `WEBGPU_TRUEHD.md`: exact four-tuple TrueHD/MLP route
- `scripts/webgpu/README.md`: fixture, build, artifact, browser, and A/B commands
- `scripts/webgpu/validation/README.md`: shared matrices, schemas, selectors,
  reports, and private live-case overlays

No validation command is running. The final local production bundle remains
available through the Jellyfin 12 nightly server on port 8096.
