# WebGPU video player

This plugin keeps the Jellyfin HTML video player as the permanent fallback and
adds two optional layers:

- WebGPU presentation over the HTML player's decoded video frames.
- A client-owned Mediabunny demux, video decode, AudioWorklet output, clock,
  and WebGPU presentation path for qualified direct-play sources.

The source feature flags in `src/config.json` are disabled by default. Local
testing enables the required flags only in the served `dist/config.json` after
building:

- `enableWebGPUVideoPlayer`
- `enableWebGPUCustomDecode`
- `enableWebGPUHDRToneMapping` for raw HDR presentation
- `enableWebGPUValidationHarness` for diagnostic color validation

Dolby Vision support, mpv/libplacebo parity targets, profile-specific fallback
rules, and the required RPU/EL ownership changes are specified in
[`WEBGPU_DOLBY_VISION.md`](WEBGPU_DOLBY_VISION.md). Dolby Vision is not
advertised until those profile-specific routes pass their production probes.

Failure during capability probing, demux, decode, audio output, WebGPU setup,
presentation, or device recovery falls back to the owned HTML player. The
custom path does not recursively request another player.

All TypeScript worker entry artifacts use content-addressed filenames. The
application therefore constructs the custom decoder and exact HEVC capability
workers from the hash emitted by the same build instead of a stable URL that a
browser can reuse after an upgrade. Worker-local chunks are content addressed
as well. The browser smoke additionally clears Chromium's HTTP cache before a
local rebuild validation so it also reloads the current top-level application
artifacts.

## Conservative codec qualification

Configuration support is not sufficient to advertise every codec route. The
production capability probe caches bounded results and the device profile
exposes only routes whose required evidence has settled successfully.

The bundled `@hevcjs/core` backend is qualified in a dedicated classic worker
against the exact pinned JS and WebAssembly assets. Each tier must:

- parse as progressive, Main tier HEVC with the exact profile and level;
- decode the complete deterministic Annex B qualification sequence;
- produce every expected frame with exact coded and chroma dimensions, bit
  depth, plane lengths, pixel format, frame count, per-frame content
  fingerprint, and aggregate byte count;
- complete within its tier elapsed-time budget; and
- sustain at least 30 measured frames per second, which is 1.25 times the
  24-frame-per-second playback target.

| Tier | Codec string | Required output | Elapsed budget |
| --- | --- | --- | ---: |
| Main 1080p | `hvc1.1.6.L120.B0` | 1920x1080 8-bit `I420` | 1750 ms |
| Main10 1080p | `hvc1.2.4.L120.B0` | 1920x1080 10-bit `I420P10` | 1750 ms |
| Main10 4K | `hvc1.2.4.L153.B0` | 3840x2160 10-bit `I420P10` | 2750 ms |

The served qualification sequence uses a `.bin` suffix even though its bytes
remain an Annex B HEVC stream. Jellyfin's ASP.NET static-file provider serves
`.bin` as `application/octet-stream` but rejects the unregistered `.hevc`
suffix before the browser can fetch it. The artifact verifier still compares
the served bytes with the checked-in `.hevc` source fixture.

Qualification uses eight decoded frames, treats the first as warm-up, and
measures the remaining seven. Its moving test pattern has a different expected
fingerprint for every frame, so repeatedly returning one valid keyframe cannot
qualify a tier. The complete worker operation has a 7000 ms deadline, covering
the sum of all sequential tier budgets plus startup overhead. Compressed and
decoded memory are bounded. A timeout, malformed worker result,
output mismatch, insufficient throughput, or unavailable worker fails closed.
No CPU model or core-count heuristic authorizes software HEVC.

Eligibility remains narrower than the decoder's theoretical support:

- SDR software HEVC requires progressive 8-bit Main content within the
  qualified Main 1080p dimensions.
- HDR software HEVC requires progressive 10-bit Main10 content within a
  successfully qualified Main10 resolution tier.
- The 1080p Main10 tier does not authorize 4K. A 4K source requires the exact
  Main10 4K result.
- Raw HDR additionally requires exact source color metadata and a production
  pixel-readback authorization for the active `GPUDevice`, canvas format, raw
  frame format, matrix, primaries, range, and PQ or HLG transfer.
- Native WebCodecs output takes precedence when its codec capability and exact
  stream constraints qualify. Every native SDR codec first requires
  `isConfigSupported()` at the advertised 1920x1080 limit. H.264 then decodes
  one exact keyframe for each advertised profile; HEVC decodes the exact 1080p
  Main access unit; and VP8, VP9 Profile 0, and AV1 Main each decode a pinned
  64x64 keyframe with exact visible/display geometry and timestamp. Hardware
  surface padding is accepted only within bounded 256-pixel horizontal and
  64-pixel vertical alignment. Every output frame is closed, and missing,
  duplicate, malformed, timed-out, or rejected output keeps that native route
  unadvertised.
- AAC LC, Opus, FLAC, MP3, and Vorbis each require their exact 48 kHz stereo
  decoder initialization data and one or two pinned silence packets to produce
  exactly one owned `AudioData`. The probe verifies timestamp, channel count,
  frame count, sample rate, duration, finite planar `f32` copying, and a tight
  silence bound before closing the output and decoder. Configuration-only,
  missing, duplicate, malformed, non-silent, or timed-out output remains
  unadvertised.
- Native Dolby Vision Profile 5 additionally decodes the exact 4K Main10
  access-unit fixture under its production `hev1.2.4.H150.B0` configuration
  and requires a correctly sized owned `VideoFrame`. Configuration support
  alone does not authorize that route.
- Config-only results never authorize native audio, H.264, ordinary native
  HEVC/VP8/VP9/AV1, raw HDR, Dolby Vision Profile 5, or bundled HEVC.
  Unknown, timed-out, failed exact-output, interlaced, oversized, or ambiguous
  streams remain on the HTML player or server-selected fallback.

These probes qualify a short deterministic decode sequence on the current
runtime. They are a conservative startup gate, not a guarantee that every
feature-length stream will sustain real-time software decode under all thermal
or system loads.

## Fused linear HDR working pass

Production raw HDR presentation keeps YUV normalization, matrix conversion,
PQ or HLG decoding, gamut conversion, tone mapping, SDR encoding, display
controls, and dithering as `f32` values within one fragment invocation. Only
the final encoded and dithered SDR result is written to the preferred 8-bit
canvas format. There is therefore no 8-bit storage boundary before tone
mapping.

This fused pass intentionally replaces the plan's earlier proposal for a
persisted `rgba16float` intermediate. Storing the current per-pixel pipeline in
such a texture would add binary16 rounding, a full-frame allocation, another
render pass, and read/write bandwidth without preserving any value that the
current shader does not already retain at higher `f32` precision. The
production pixel-readback authorization executes this exact fused renderer on
the active device and target format. Add a reusable float working texture only
if a future spatial, compositing, or multi-pass stage needs linear pixels to
survive between passes.

Dolby Vision has separate raw-plane and external-texture authorizations. The
native Profile 5 route imports an owned decoded `VideoFrame`, executes the
production external-texture RPU shader, and compares GPU readback samples. The
raw route executes its distinct I420P10 plane shader. A successful result from
one route cannot authorize the other, and their device-profile limits remain
alternative route limits rather than being intersected.

Profile 7 has two raw-plane authorizations. The base route covers MEL
reconstruction and explicit FEL HDR10-base degradation. The independent FEL
route covers half-resolution EL sampling and LINEAR_DZ residual composition.
A stream can use the full route when either its interleaved key access unit
contains EL parameter sets, its selected Matroska track provides a validated
`hvcE` configuration, or a conservative two-track Matroska topology provides a
validated separate EL decoder configuration. Legacy dual-track ISO BMFF is
also supported when a bounded `dvh1`/`dvhe`, `dvcC`, `hvcC`, and `vdep`
topology identifies exactly one EL for the selected BL. The second bundled
decoder can also follow a bounded MPEG-TS or M2TS PAT/PMT dependency from one
selected HEVC BL PID to one exposed EL PID, including the fixed HDMV BL/EL PID
pair. It must produce a PTS-matched EL frame and the exact FEL GPU route must be
authorized. Otherwise the same BL session continues through the base route.

## Bundled codec licensing and distribution

### HEVC

`@hevcjs/core` is pinned to version 1.3.2 and declares the MIT license. Webpack
copies its decoder glue, WebAssembly binary, and license to
`dist/libraries/hevcjs/`. The artifact verifier requires those served files to
match the installed pinned package byte for byte.

The MIT license covers the implementation copyright. It does not grant or
clear HEVC/H.265 patent rights. Any distributed product containing or using
the bundled HEVC decoder requires a separate patent and jurisdiction review.
The copied license and successful artifact verification do not replace that
review.

### AC-3 and E-AC-3

Ordinary builds exclude the bundled AC-3 software decoder. AC-3 and E-AC-3 are
reported as `build-disabled`, the implementation modules are ignored by
Webpack, and the distribution must contain neither their implementation
markers nor the opt-in license artifact.

Enable the pinned `@mediabunny/ac3` package only for local validation:

```powershell
$env:ENABLE_BUNDLED_AC3_SOFTWARE_DECODER = '1'
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 enabled
Remove-Item Env:ENABLE_BUNDLED_AC3_SOFTWARE_DECODER
```

Do not distribute that enabled build. The package statically embeds FFmpeg
codec code but does not identify and provide the exact corresponding FFmpeg
source revision and relinking materials required for a reviewed binary
distribution. Copying its MPL-2.0 license does not resolve those source and
relinking obligations or codec patent rights.

## Build artifact verification

Verify an ordinary build after building it:

```powershell
npm run build:production
node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 disabled
```

Use the same verifier after `npm run build:development` during local testing.
It always checks the artifacts in the current `dist` directory, so the
`--ac3` mode must match the build that most recently produced that directory.

The verifier:

- hashes the served HEVC glue, WebAssembly binary, and license against the
  pinned installed package;
- rejects missing or modified HEVC artifacts;
- rejects AC-3 implementation markers or its copied license in an ordinary
  build; and
- requires both implementation markers and the matching package license in an
  explicitly enabled local AC-3 build.

Run the verifier's isolated tests with:

```powershell
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
```

## Runtime diagnostic probe

Start Chromium with a remote-debugging port, serve the built frontend on
`localhost`, and run:

```powershell
node scripts/webgpu/probe-browser-runtime.mjs http://localhost:9224 http://localhost:8080
```

This command reports WebGPU adapter information and calls
`AudioDecoder.isConfigSupported()` and `VideoDecoder.isConfigSupported()` for
representative configurations. Its codec results are config-only diagnostics.
They do not decode an access unit, validate output pixels or planes, measure
throughput, authorize raw HDR, or override the production capability probes.
Use production capability telemetry and the browser playback smoke test for
decoded-output evidence.

## Automated validation

Run the source checks and focused harness tests:

```powershell
npm run build:check
npm test -- src/plugins/webGPUVideoPlayer
npm run lint -- src/plugins/webGPUVideoPlayer scripts/webgpu
node --test scripts/webgpu/browser-smoke-helpers.node-test.mjs
node --test scripts/webgpu/cdp-retention-snapshot.node-test.mjs
node --test scripts/webgpu/worker-artifact-name.node-test.mjs
node --test scripts/webgpu/release-validation-metrics.node-test.mjs
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
node --test scripts/webgpu/create-dual-track-dolby-vision-mp4-fixture.node-test.mjs
node --test scripts/webgpu/create-dual-pid-dolby-vision-ts-fixture.node-test.mjs
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 disabled
```

The feature-gated custom decode worker, Mediabunny chunk, and pinned HEVC
runtime require a current WebCodecs/WebGPU browser and are excluded from the
repository's ES5 artifact scan. `npm run escheck` continues to require ES5 for
every other generated JavaScript asset.

Generate the deterministic SDR, PQ, HLG, and spatial color fixtures when
validating the color pipeline:

```powershell
./scripts/webgpu/generate-color-validation-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -Overwrite
```

The external-texture color harness is diagnostic only. Production raw HDR
authorization separately renders exact limited-range BT.2020 PQ and HLG raw
fixtures through the same raw YUV GPU renderer used by playback and compares
GPU readback pixels. Authorization is scoped to the exact device, target
format, and route key. See the
[harness documentation](scripts/webgpu/README.md) for fixture schemas,
readback classifications, and the complete diagnostic procedure.

### Playback route fixtures

Generate short Jellyfin library items for end-to-end PQ and HLG route testing:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -Overwrite
```

The default files are six-second, 1920x1080p24, HEVC Main10 Level 4,
limited-range BT.2020 PQ and HLG streams with stereo 48 kHz AAC. Add
`-IncludeAC3` to also generate a PQ live stream-switch fixture for an
explicitly enabled local AC-3 build:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -IncludeAC3 `
    -Overwrite
```

The additional `pq-main10-1080p24-aac-ac3.mkv` retains AAC as its default
stereo 48 kHz track and appends a non-default stereo 48 kHz AC-3 track. It is
designed to start with AAC and switch decoders in-session while the same video
route continues. It is not an AC-3-only file.

These files validate Jellyfin negotiation, byte-range input, demux, video and
audio decode, raw HDR authorization, presentation, and playback lifecycle.
They are not golden color-accuracy fixtures and do not replace the
color-validation manifest or GPU pixel-readback checks.

The generator writes to `scripts/webgpu/playback-smoke-media` by default and
verifies the stream metadata with FFprobe. Add that generated directory as a
Jellyfin library path, scan the library, and use the returned Jellyfin item ID
for each file as `WEBGPU_SMOKE_ITEM_ID`. Do not give the smoke harness a local
filesystem path. Because the route fixtures are six seconds long, set:

```powershell
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'raw-planes'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'bundled-hevc' # or native for that route
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'ready'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'testsrc2-motion'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
```

To validate decoder EOF and physical audio-tail draining instead of the normal
pause, seek, and explicit-stop lifecycle, also set:

```powershell
$env:WEBGPU_SMOKE_COMPLETION_MODE = 'natural-end'
```

Natural-end mode waits for the controller's ended state and exactly one
Jellyfin `stopped` event without a terminal waiting event or fallback, verifies
drained video and audio queues and a clock at the submitted audio endpoint,
observes the stable ended state, and only then performs idempotent cleanup. It
requires a single session, no fault injection or in-session audio switch, and
a zero seek-storm count.

The frame-evidence mode samples the actual presentation canvas at two media
times, verifies the generator's asymmetric testsrc2 color signature and
channel ranges, and requires different pixel checksums. Use the default
`none` for arbitrary library media that does not contain this test pattern.

When asserting the optional switch fixture, use the AC-3 track's Jellyfin
`MediaStream.Index`, not the audio-only container ordinal. After setting the
common connection, item, and credential variables in the live-validation
section below, run:

```powershell
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '<AC-3 MediaStream.Index>'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'ready'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'testsrc2-motion'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

The harness must observe the default AAC start, a new decoder generation,
decoded AC-3 samples, uninterrupted raw HDR presentation, and no fallback or
terminal error. Playback still requires the non-distributable opt-in build
described above.

## Live browser playback validation

The smoke harness uses an already-running Chromium debugging target and real
Jellyfin UI. It navigates that page but does not start or stop Chromium,
Jellyfin, or the static server. The frontend and server must use `localhost` so
WebGPU runs in a secure context.

Enable the player and custom-decode flags in the served `dist/config.json`.
Raw HDR also requires the tone-mapping flag; the diagnostic-validation flag is
not a substitute for production raw authorization. Enable `multiserver` when
the static frontend and Jellyfin API are served from different ports.

Set the common connection and credential inputs without placing credentials on
the process command line:

```powershell
$env:WEBGPU_SMOKE_DEBUG_URL = 'http://localhost:9224'
$env:WEBGPU_SMOKE_FRONTEND_URL = 'http://localhost:8080'
$env:WEBGPU_SMOKE_SERVER_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_ITEM_ID = '<item-id>'
$env:WEBGPU_SMOKE_USERNAME = '<username>'
$env:WEBGPU_SMOKE_PASSWORD = '<password>'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'disabled' # Use ready when custom audio is expected
```

For native SDR decode:

```powershell
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'video-frame'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'native'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

For qualified bundled HEVC Main SDR decode on a runtime where the native HEVC
route did not qualify:

```powershell
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'video-frame'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'bundled-hevc'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

For qualified bundled HEVC Main10 HDR decode and raw presentation on a runtime
where the native HEVC raw-output route did not qualify:

```powershell
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'raw-planes'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'bundled-hevc'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Use `WEBGPU_SMOKE_INJECT_FAILURE=paused-device-loss` to prove that a paused raw
or native custom presentation re-decodes and repaints one exact-time frame on a
replacement GPU device without restarting the HTML backend or emitting a
second pause event.

The raw path passes only when telemetry reports the exact active raw HDR route
as authorized. The harness also checks playback progress, pause and resume,
seek storms, fullscreen where available, resize and device-pixel-ratio changes,
bounded queues, event cardinality, stop cleanup, stale work, and browser errors.

Use the following optional exercises in separate runs:

```powershell
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '3'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '5'
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'presentation' # or device-loss
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Run the paired release startup gate separately:

```powershell
$env:WEBGPU_SMOKE_STARTUP_SAMPLES = '10'
$env:WEBGPU_SMOKE_SOAK_SESSIONS = '0'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'none'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'none'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

This mode keeps one isolated browser context and one temporary page alive for
each of direct HTML, HTML decode with WebGPU presentation, and custom decode.
The isolated contexts prevent Jellyfin's shared authentication state from
causing the three modes to redirect or replace one another. After one
unmeasured warmup per page it collects 10 matched samples per mode without
document reloads, alternating HTML-first and custom-first rounds. It records play,
audio, decoded, and exact presenter-frame milestones and gates the median and
nearest-rank p95 of per-round threshold excess. Custom audio requires decoded
PCM submission and render-thread consumption rather than silent output quanta;
video-only evidence marks audio not applicable. Per-page CDP response overlays
change only the in-memory WebGPU feature flags. They neither edit
`dist/config.json` nor alter the user's original browser page, and every
temporary target and browser context is destroyed after its interceptor
drains. See the harness documentation for exact thresholds and observation
bias.

Run a release post-stop retention gate separately with a representative native
route and the worst qualified software route:

```powershell
$env:WEBGPU_SMOKE_SOAK_SESSIONS = '30'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'none'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'none'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

The soak forces two garbage collections after each clean stop, requires custom
worker retirement before the one-second watchdog, and gates heap, backing
storage, DOM, listener, and available media/WebGPU object-count growth from the
post-GC first-session baseline. An unclosed `VideoSample` finalizer warning is a
soak failure even while the known ownership defect remains deferred. Available
Performance counts for audio handlers, AudioWorklet processors, and worker
global scopes must have no positive terminal or Theil-Sen growth from their
warmed session-one values. Array-buffer-content counts retain a small bounded
noise allowance but may not grow once per session. The queried post-stop
`AudioWorkletNode` count must remain exactly at its warmed baseline. Custom
audio sessions share one exact-rate page-lifetime `AudioContext` and one
physical worklet output. Each session receives an exclusive guarded lease;
release clears processor state through an acknowledged deactivation before
the idle context is suspended. Failed deactivation, resume, or suspension
invalidates the shared runtime rather than caching a poisoned output.

The device-loss run destroys the actual active `GPUDevice` and requires one
replacement-device recovery without restarting custom decode. A raw HDR run
must also reauthorize its exact route on the replacement device before
presentation resumes.

### Known VideoSample ownership warning

Repeated paused-device-loss runs with the bundled HEVC decoder can
intermittently produce Mediabunny's diagnostic warning that a `VideoSample`
was garbage collected without first being closed. Playback, exact-time paused
repaint, replacement-device recovery, worker shutdown acknowledgement, bounded
queues, and subsequent HTML fallback remain functional in the observed runs.

The custom HEVC adapter closes samples rejected by its callback, the worker
closes each consumed sample immediately after obtaining its independent
`VideoFrame`, iterator retirement is awaited, and worker shutdown waits for
the active software decoder lifecycle. Temporary ownership counters observed
all adapter-created samples being closed in clean runs, but the warning is
nondeterministic and has not been causally assigned. One candidate is an
upstream Mediabunny range-filter edge for a decoded seek-preroll sample whose
timestamp precedes the requested start after the first sample has already been
queued.

Treat the warning as an unresolved resource-ownership defect. Keep browser
console assertions enabled, record whether it occurs during stress runs, and
do not claim a leak-free long-duration soak until retained-object or memory
evidence closes it. Do not suppress the warning or weaken fallback behavior.

For an enabled local AC-3 build, select an exact stereo 48 kHz Jellyfin audio
stream and assert its decoder codec:

```powershell
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '<stream-index>'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'ready'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Run with `--help` for all CLI equivalents and bounds. The complete smoke-test
contract, failure-injection scope, telemetry sanitization, and manual test
prerequisites are in the
[harness documentation](scripts/webgpu/README.md).
