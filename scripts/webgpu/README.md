# WebGPU color diagnostics and playback harnesses

External-texture measurements are diagnostics only. WebGPU imports convert video
frames into the requested `srgb` color space, so a passing measurement cannot
authorize source-transfer decoding or HDR tone mapping in production. The raw
YUV upload path must validate its own shader and reference pixels separately.

The external-texture runner owns an ordinary `rgba16float` GPU texture with
`GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC`. It never retains
a canvas current texture across an asynchronous boundary and does not acquire a
`GPUCanvasContext`. A dedicated hidden canvas supplies diagnostic dimensions
only; do not attach it to an active playback presenter.

1. Create an SDR, PQ, or HLG `ColorValidationRamp` with
   `createTransferValidationRamp`.
2. Render the corresponding reference frame into the validation canvas. An
   `rgba16float` canvas is required to prove that HDR values above normalized
   SDR white survive the browser path.
3. After submitting each reference frame, call `captureCurrentFrame` with its
   integer-microsecond timestamp.
4. Call `evaluate`. `classification: 'valid'` means only that the observed
   browser conversion matched this diagnostic model. `diagnostic.productionAuthorization`
   is always `false`. `clamped`, `double-transformed`, `mismatch`,
   `invalid-samples`, and `readback-unavailable` describe diagnostic failures.
5. Call `destroy` to release pending map buffers and unconfigure an owned canvas.

Generate eight-frame, one-frame-per-second SDR/PQ/HLG clips and a four-quadrant
PQ chromatic fixture without checking binaries into Git:

```powershell
./scripts/webgpu/generate-color-validation-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -Overwrite
```

The script requires FFmpeg and FFprobe. It fails generation unless FFprobe sees
the expected codec, pixel format, dimensions, frame count, range, matrix,
transfer, and primaries. It then decodes every clip to raw planar YUV and checks
representative plane codes, including all four spatial quadrants.

The manifest contains a versioned fixture-set ID, a canonical-ramp SHA-256,
per-file SHA-256 values, exact integer-microsecond frame times, and encoded RGB
and YUV values. Five achromatic levels test transfer handling; three chromatic
samples expose matrix or primaries conversion. The spatial fixture detects
plane-order, chroma-coordinate, and orientation errors. The generator
maps each RGB triplet through the tagged BT.709 or BT.2020 nonconstant-luminance
matrix, quantizes it to limited-range 8-bit or 10-bit YUV codes, and records the
exact RGB value reconstructed from those integer codes. The HDR clips use
lossless 10-bit HEVC and require an FFmpeg build with `libx265`. Media-query
results and container color tags are diagnostics only; they are not substitutes
for GPU readback validation.

Consumers must reject unknown fixture IDs or schema versions and verify the
selected file SHA-256 before decoding it. An arbitrary ramp, even one with the
same input metadata, has a distinct `kind: 'custom'` registry key and cannot
reuse the canonical diagnostic cache entry.

In browser code, the generated manifest supplies both the bounded decode
schedule and the ramp construction options. Manifest timestamp values are
already microseconds; convert them through the branded media-time boundary
instead of casting them. The generated clips contain one global video track at
index 0. For other clips, the index is the position returned by
`Input.getTracks()`, not the video-only track number.

```ts
import {
    MICROSECONDS_PER_MILLISECOND,
    millisecondsToMicroseconds
} from 'plugins/webGPUVideoPlayer/MediaTime';
import { createPQColorMetadata } from 'plugins/webGPUVideoPlayer/color';
import {
    WebGPUExternalTextureValidationRunner,
    validateMediabunnyExternalTextureReferenceFrames
} from 'plugins/webGPUVideoPlayer/validation';

const timestampsMicroseconds = manifest.timestampsMicroseconds.map(
    (timestampMicroseconds: number) => millisecondsToMicroseconds(
        timestampMicroseconds / MICROSECONDS_PER_MILLISECOND
    )
);
const runner = new WebGPUExternalTextureValidationRunner();
const decision = await validateMediabunnyExternalTextureReferenceFrames(runner, {
    device,
    globalTrackIndex: 0,
    metadata: createPQColorMetadata(),
    rampOptions: {
        encodedRGBTriplets: manifest.encodedRGBTriplets.pq,
        frameIntervalMicroseconds: millisecondsToMicroseconds(
            manifest.frameIntervalMicroseconds / MICROSECONDS_PER_MILLISECOND
        )
    },
    timestampsMicroseconds,
    url: new URL(manifest.files.pq, manifestUrl).toString()
});

// This remains diagnostic even when decision.classification is "valid".
console.assert(decision?.diagnostic.productionAuthorization === false);
```

The adapter requires requests in manifest order and rejects any decoded sample
or `VideoFrame` whose integer-microsecond timestamp differs. It transfers each
fresh frame to the validation runner, which closes it. The convenience function
always destroys the Mediabunny iterator and input. Do not log authenticated
media URLs; provider errors intentionally omit URLs and query credentials.

## Playback route smoke media

`generate-playback-smoke-media.ps1` creates short files for exercising complete
Jellyfin negotiation, range fetch, demux, decode, audio, raw HDR presentation,
and playback lifecycle integration. These are route-integration fixtures, not
golden color references. Their test pattern and HDR tags provide controlled
inputs for the smoke harness's PQ or HLG route assertions, but they do not
establish tone-map or pixel accuracy. Use the generated color-validation
manifest and GPU readback procedure above for golden color validation.

Generate the default PQ and HLG fixtures:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -Overwrite
```

The default output directory is `scripts/webgpu/playback-smoke-media`. Each
file is six seconds of 1920x1080 at 24 fps, HEVC Main10 Level 4,
`yuv420p10le`, limited-range BT.2020 nonconstant-luminance YUV, with stereo
48 kHz AAC. One file is tagged PQ and the other HLG. The generator runs
FFprobe and fails unless the codec, profile, level, geometry, frame rate, pixel
format, range, matrix, transfer, primaries, channel count, and sample rate are
exact.

Optionally add a PQ stream-switch fixture:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -IncludeAC3 `
    -Overwrite
```

`-IncludeAC3` adds `pq-main10-1080p24-aac-ac3.mkv`. It retains the default
stereo 48 kHz AAC track from the PQ fixture and appends a non-default stereo
48 kHz AC-3 track. It is specifically structured to start through the ordinary
AAC route and then validate a live switch to the opt-in AC-3 decoder without
changing the video route. It is not an AC-3-only file. The AC-3 track requires
the explicitly enabled local, non-distributable AC-3 build described below.
Generation requires FFmpeg and FFprobe, an FFmpeg build with `libx265`, and
the requested audio encoders.

Add the absolute `scripts/webgpu/playback-smoke-media` directory as a Jellyfin
library path and scan that library. Use the Jellyfin item IDs returned for the
generated files as `WEBGPU_SMOKE_ITEM_ID`; do not pass filesystem paths to the
browser harness. These fixtures are only six seconds long, so set
`WEBGPU_SMOKE_SEEK_STORM_COUNT=0` for each run. Set
`WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT=raw-planes`, choose `native` or
`bundled-hevc` for `WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER` according to the route
being tested, set `WEBGPU_SMOKE_EXPECTED_AUDIO=ready`, and set
`WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE=testsrc2-motion`. The evidence option
captures the actual presentation canvas twice, checks the generated testsrc2
color signature and channel ranges, and requires a changing pixel checksum.
It therefore rejects black, static, or grossly misordered decoded output that
would otherwise satisfy frame counters. Leave it at its default `none` for
ordinary media whose pixels do not follow this generated pattern.

For `pq-main10-1080p24-aac-ac3.mkv`, read the AC-3 track's Jellyfin
`MediaStream.Index` after the library scan. The browser harness expects that
Jellyfin index, not the audio-only container ordinal. After setting the common
connection, item, and credential variables in the smoke section below, run:

```powershell
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '<AC-3 MediaStream.Index>'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'ready'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'testsrc2-motion'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

The smoke run must begin on the default AAC track, create a new decoder
generation for the selected AC-3 track, observe decoded AC-3 audio, keep the
same raw HDR presentation active, and finish without fallback or a terminal
error.

Probe WebCodecs configurations and the WebGPU adapter in a real browser started
with a remote debugging port:

```powershell
node scripts/webgpu/probe-browser-runtime.mjs http://localhost:9224 http://localhost:8080
```

Use a `localhost` target so the page is a secure context.

## Owned native AC-3 and E-AC-3 audio

Before advertising AC-3 or E-AC-3, the player appends exact two-channel and
six-channel 48 kHz CMAF fixtures to four muted owned audio elements and requires
their media clocks to advance. MIME support alone never enables a route. The
successful exact codec/layout results are cached for the page, added to the
device profile, and selected ahead of bundled PCM decode. Unknown, rejected,
or differently shaped routes remain unadvertised.

Chrome 151.0.7922.72 on the current Windows validation host reports both MIME
types unsupported, so all four routes correctly remain unadvertised there. This
is a negative gating result, not evidence that the owned backend is broken;
positive qualification still requires a browser/runtime that exposes one of
the exact routes.

Set `WEBGPU_SMOKE_EXPECTED_AUDIO=native-media` when qualifying this path. The
harness then requires `audioOutputMode: native-media`, one sourced and playing
`.webgpuOwnedNativeAudio` element, an advancing qualified native clock, appended
native audio segments, and no PCM bridge or AudioWorklet output. For an
in-session track switch, continue to set the exact worker-reported codec with
`WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC`.

## Local AC-3 and E-AC-3 decoder build

Ordinary builds exclude the bundled AC-3 software decoder and report AC-3 and
E-AC-3 as build-disabled. The `@mediabunny/ac3` package statically embeds
FFmpeg codec code in a single-file WebAssembly worker. Its package does not
identify or provide the exact corresponding FFmpeg source revision and
relinking materials needed for a compliant binary distribution.

Enable the decoder only for local validation:

```powershell
$env:ENABLE_BUNDLED_AC3_SOFTWARE_DECODER = '1'
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 enabled
Remove-Item Env:ENABLE_BUNDLED_AC3_SOFTWARE_DECODER
```

After an ordinary build, run:

```powershell
node scripts/webgpu/verify-custom-codec-artifacts.mjs --ac3 disabled
```

The verifier checks copied HEVC hashes and requires the stable AC-3
implementation sentinel only in executable JavaScript from an enabled build.

Do not distribute an enabled build. The enabled build copies the package's
MPL-2.0 license into `dist/libraries/mediabunny-ac3/`, but that license copy
does not resolve the missing FFmpeg corresponding-source obligations or codec
patent rights. A redistributable build requires a separately reviewed source,
license, build, and relinking package for the exact embedded binary.

## End-to-end browser playback smoke test

`run-browser-playback-smoke.mjs` drives an already-running Chromium page through
the real Jellyfin UI using the raw Chrome DevTools Protocol. It does not launch
or stop Chromium, Jellyfin, or the static frontend server. Coordinate with
anyone using the debugging page before running it because it navigates that
existing page.

Prerequisites:

- Build Jellyfin Web with `enableWebGPUVideoPlayer` and
  `enableWebGPUCustomDecode` enabled in the served `dist/config.json`. Enable
  `multiserver` when the static frontend and Jellyfin API use different ports.
  The isolated startup comparison overlays only the four WebGPU flags in CDP
  responses and does not require or modify those served flag values.
- Serve the frontend and Jellyfin backend on `localhost`.
- Start Chrome or Edge with a remote-debugging port and leave one page open.
  Automated hidden-window runs must disable occlusion and renderer background
  throttling; otherwise Chromium can suspend custom setup or frame delivery.
- Choose a direct-play video whose exact video and audio WebCodecs
  configurations are supported by that browser.

The following isolated Chrome launch keeps hidden automated playback active.
Use a dedicated profile because the harness navigates and controls the attached
page:

```powershell
$chromePath = Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'
$profilePath = Join-Path $env:TEMP 'jellyfin-webgpu-validation-profile'
Start-Process -FilePath $chromePath -WindowStyle Hidden -ArgumentList @(
    '--remote-debugging-port=9224',
    "--user-data-dir=$profilePath",
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    'http://localhost:8096/web/'
)
```

Keep credentials out of scripts and shell history by using environment
variables:

```powershell
$env:WEBGPU_SMOKE_DEBUG_URL = 'http://localhost:9224'
$env:WEBGPU_SMOKE_FRONTEND_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_SERVER_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_ITEM_ID = '<video-item-id>'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'video-frame' # or raw-planes
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'native' # or bundled-hevc
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'disabled' # ready or native-media
$env:WEBGPU_SMOKE_COMPLETION_MODE = 'controlled-stop' # or natural-end
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '3' # optional Jellyfin stream index
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3' # required with stream index
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1' # optional, 1 through 5
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '3' # optional, 0 through 5
$env:WEBGPU_SMOKE_SOAK_SESSIONS = '0' # optional, 0 or 10 through 100
$env:WEBGPU_SMOKE_STARTUP_SAMPLES = '0' # optional, 0 or 10 through 30
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'none' # presentation, device-loss, paused-device-loss
$env:WEBGPU_SMOKE_USERNAME = '<username>'
$env:WEBGPU_SMOKE_PASSWORD = '<password>'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Equivalent CLI flags are available through `--help`, but the username and
password flags expose those values to the local process list. The frontend URL
may instead point to a separately served development build such as
`http://localhost:8080`; item ID and credentials remain required. The expected
video output and audio path are also required so the harness tests the intended
pipeline rather than inferring intent from the observed telemetry. Use
`video-frame` with `disabled` for a video-only SDR item, or `raw-planes` with
`ready` for an HDR item with custom-decoded PCM, or `native-media` for an exact
owned native-audio route that passed the runtime fixture probe.

A `raw-planes` result is accepted only when
`getRawHDRAuthorizationTelemetry()` reports `status: 'authorized'` on the
active presentation device and its `authorizedRouteKeys` contains the exact
route derived from the active raw frame format, matrix, primaries, range, and
PQ or HLG transfer. The report retains only that bounded route key, target
format, versions, route lists, and failure codes; it does not serialize GPU
objects or source details.

To exercise an in-session audio track change, set both
`WEBGPU_SMOKE_AUDIO_STREAM_INDEX` and `WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC`. The
harness requires a new decoder generation, the exact audio codec, uninterrupted
WebGPU presentation, and no fallback or terminal error. A `ready` route must
produce decoded PCM samples; a `native-media` route must append native segments
and qualify the owned element clock. Audio stream selection is intentionally
limited to one playback session per invocation so a later Jellyfin replay cannot
silently restore the item's default track. The locally bundled AC-3 validation
route additionally requires an enabled, non-distributable AC-3 build as
described above.

The harness connects through the add-server form, signs in when the selected
server does not already have a valid saved session, opens the details page, and
uses a CDP user-gesture activation on Play. Before that activation it
temporarily wraps `window.Events.trigger` and captures the priority-0 player
from its event target. Randomized page-side capture functions exist only for
the invocation and are removed during cleanup. No player reference or
diagnostic global is added to production code.

The checks require:

- advancing custom decode and WebGPU presentation telemetry;
- the explicitly expected `video-frame` or `raw-planes` video path;
- the explicitly expected `disabled` or `ready` audio path;
- the selected audio decoder generation and codec when an audio stream index is
  supplied;
- no more than 2 percent audio underflow over an observation window containing
  at least 4,800 output frames;
- raw queued plus pending frames remaining within the two-frame raw window;
- a source-less owned `HTMLVideoElement` and a visible WebGPU canvas;
- a frozen application clock and renderer while paused;
- clock and frame progress after resume;
- an integer-microsecond seek landing within tolerance;
- three rapid, non-monotonic seeks by default, with an exact decoder-generation
  delta, final-target landing, explicit stale-work accounting, bounded frame
  queues, and no backend session restart;
- native Fullscreen API entry/exit when Chromium accepts the CDP user gesture;
- canvas backing-size updates under a temporary CDP viewport and
  device-pixel-ratio override, followed by restoration of the original page
  metrics;
- exact pause, unpause/playing, fullscreen-change, and stop event cardinality
  where the corresponding transition runs, including unpause-before-playing
  ordering;
- one stop event, an idle presenter, no retained canvas or source, and no
  terminal player/browser errors.

Set `WEBGPU_SMOKE_COMPLETION_MODE=natural-end` for an isolated decoder EOF
exercise. The mode waits for the custom controller's natural `ended` state,
requires exactly one Jellyfin `stopped` event, no terminal waiting or fallback,
drained video and audio queues, and a clock at the submitted physical audio
tail. It then observes the ended state for another 750 milliseconds before
issuing an idempotent cleanup stop. Natural-end mode requires one session, no fault
injection or audio-stream change, and a zero seek-storm count; when the count is
not configured, the mode selects zero automatically. Use a short generated
fixture and keep the per-phase timeout longer than its duration.

The seek burst is bounded by `WEBGPU_SMOKE_SEEK_STORM_COUNT` (`0` through `5`)
and defaults to three requests. Its targets stay at least one second from the
start and two seconds from the end. Configured seek storms require a finite
duration of at least eight seconds; set the count to `0` for shorter fixtures.

Fullscreen results distinguish `entered` from a skipped request. The harness
reports `fullscreen-api-unavailable`, `fullscreen-preexisting`, or
`fullscreen-request-rejected` instead of claiming coverage when CDP cannot
induce a new transition. The viewport/device-scale exercise still runs and its
override is cleared before pause, seek, or stop validation.

Set `WEBGPU_SMOKE_REPEAT_SESSIONS` to `2` through `5` to replay and stop the
same item repeatedly. Each additional session must use a newer player session,
advance decoded presentation, report no stale custom events, and clean up with
exactly one additional stop event.

Set `WEBGPU_SMOKE_STARTUP_SAMPLES=10` for the isolated release startup gate.
The harness creates one isolated browser context with one temporary, long-lived
page for each mode. Context isolation prevents Jellyfin's same-origin
authentication and server-selection state from making the three modes replace
or redirect one another. It runs one unmeasured warmup in each page, then
measures the same item once per mode in every round without reloading those
pages. Odd rounds use HTML, presentation, custom order; even rounds reverse
native and custom around presentation. This balances run-order drift while
keeping every round matched by sample number on the same browser, server,
account, and item.

Each temporary page first loads through a CDP `Fetch` response overlay for
`config.json` to establish authentication, then receives one synchronized
measurement-document load before warmup and sampling. HTML disables the WebGPU
plugin, presentation enables the wrapper but disables custom decode, and custom
enables the player, custom decode, HDR tone mapping, and diagnostic
authorization. The served `dist/config.json` is never edited. HTTP caching
remains enabled so the warmup can populate normal bundle and artifact caches,
while service workers remain bypassed. The interceptors are drained and
disabled and all three temporary targets and browser contexts are destroyed
before the command exits; the user's original page is not repurposed for a
comparison mode.

```powershell
$env:WEBGPU_SMOKE_STARTUP_SAMPLES = '10'
$env:WEBGPU_SMOKE_SOAK_SESSIONS = '0'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'none'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'none'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Each sample records browser `performance.now()` milestones for the play
invocation, Jellyfin playback start and playing events, first native media
playing or consumed custom PCM when audio is expected, first native
`requestVideoFrameCallback()` or custom decoded frame, first visible frame,
and canvas-attach-to-presented-frame interval. Presented-frame timing comes
from the presenter's exact monotonic session-start plus first-frame latency.
Custom decode/audio readiness is observed through 10-millisecond CDP polling;
its positive bias also includes CDP scheduling and, for audio, the worklet
telemetry cadence. The report retains warmup and measured samples, matched
sample numbers, summaries, paired regressions, threshold excesses, and limits.

For every matched round, presentation playing, first-audio when expected, and
first-visible-frame regression is compared with the greater of 50 milliseconds
or 10 percent of that round's HTML value for the median gate, and the greater
of 100 milliseconds or 15 percent for the p95 gate. Its local
canvas-attach-to-frame median must be at most 100 milliseconds and p95 at most
250 milliseconds. Custom comparisons use the greater of 250 milliseconds or
20 percent of paired HTML for the median gate and 500 milliseconds or 30
percent for p95. A gate fails when the median or nearest-rank p95 of matched
threshold excess is positive. Native audio uses the media element's first
`playing` boundary. Custom decoded PCM requires both submitted samples and a
positive AudioWorklet consumed-frame count, so underflow silence cannot pass.
Owned native audio requires appended media, a qualified native clock, and an
observed increase in the element's integer-microsecond time. A video-only run
reports the audio gate as not applicable rather than inventing samples. All
requested measured samples are mandatory. Startup mode requires controlled
stop, repeat count one, no soak, fault injection, audio switch, seek storm, or
generated-frame evidence.

Set `WEBGPU_SMOKE_SOAK_SESSIONS` to `10` through `100` for a lean repeated
play/observe/stop retention gate; use `30` for a release run. Soak mode selects
a zero seek count by default and requires controlled stop, repeat count one, no
failure injection, no in-session audio switch, and no generated-frame evidence.
After every stop it waits 250 milliseconds, performs two explicit V8 garbage
collections, and records heap, embedder heap, backing storage, DOM counters,
performance metrics, live media/WebGPU wrapper counts, and browser worker
targets. Each stop must complete within 900 milliseconds and no custom decode
worker opened by the controlled page in its browser context may remain.

Session one is the post-GC steady-state baseline because the player may retain
one warmed presenter device and pipeline. Sessions two onward must stay within
these release gates:

The harness also records a pre-playback resource snapshot. Audio-resource
counts are measured relative to that snapshot so an unrelated page-owned audio
object cannot hide an extra player allocation or cause a false failure.

- JavaScript and embedder heap: at most 16 MiB growth and a 256 KiB/session
  Theil-Sen slope.
- Backing storage: at most 8 MiB growth and a 128 KiB/session slope.
- Documents: no change; DOM nodes: at most 32 growth and a 0.5/session slope;
  event listeners: at most 16 growth and a 0.25/session slope.
- Every available queried media/WebGPU object type: at most baseline plus one
  and a 0.1 object/session slope. A custom-audio run additionally requires
  exactly one more `AudioContext`, `AudioWorkletNode`, and
  `AudioWorkletProcessors` Performance object than the pre-playback snapshot
  after every stop. An owned native-audio run requires the exact pre-playback
  `AudioContext`, `AudioWorkletNode`, and processor counts after its unused PCM
  prewarm closes. An audio-disabled run requires no worklet node or processor
  increase; its unused prewarm may leave one suspended `AudioContext`.
- Available `AudioHandlers` and `WorkerGlobalScopes` Performance counts: no
  positive final, last-three-median, or Theil-Sen slope from the warmed
  session-one baseline. `ArrayBufferContents` may grow by at most 32 with a
  0.1/session slope to tolerate bounded global-page noise without accepting
  per-session growth. Missing mandatory audio-object probes fail the gate.
- No stopped-session custom decode worker and no unclosed `VideoSample`
  finalizer warning.

Custom audio sessions share one exact-rate page-lifetime `AudioContext` and
one physical worklet output. Each session receives an exclusive guarded lease.
Lease release clears queued PCM and timing state through an acknowledged
processor deactivation before the idle context is suspended. Failed setup,
deactivation, or idle suspension poisons that shared runtime and forces a fresh
context and node on the next session. An active-session resume rejection is
surfaced to the controller and handled by normal session fallback and teardown.

The report includes every raw sample plus the final, last-three-median, and
slope calculations. An unavailable browser constructor is reported but not
invented as a zero count. CDP does not expose reliable live GPU allocation
bytes, so GPU wrapper counts, backing storage, and player cleanup invariants are
the bounded evidence used here.

Set `WEBGPU_SMOKE_INJECT_FAILURE=presentation` to invoke the presenter's
session-scoped fallback seam after a separate successful custom start. This
requires a test item that the HTML backend can play after fallback. The harness
checks that the WebGPU canvas is removed, the expected failure reason is
retained, native video resumes and advances, and the fallback session stops
cleanly. This mode is opt-in because browser/server codec support determines
whether same-session native recovery is possible; the default smoke run does
not inject failures.

Set `WEBGPU_SMOKE_INJECT_FAILURE=device-loss` to call `GPUDevice.destroy()` on
the active presenter's current device. Chromium resolves that device's real
`lost` promise, which invokes the presenter's registered loss handler. The
harness requires exactly one recovery count increment, a distinct replacement
device, continued presentation and clock progress in the same custom decode and
backend generations, no terminal control events, and a clean stop. This proves
the specified destroyed-device recovery path; it does not emulate a driver
reset, GPU process crash, or physical device removal. The second-loss terminal
fallback and recovery-timeout paths remain deterministic unit-test coverage,
not claims made by this browser command.

Set `WEBGPU_SMOKE_INJECT_FAILURE=paused-device-loss` to pause the separate
fault-injection session before destroying the device. The harness requires one
replacement device, one generation-safe frame re-decode at the exact paused
clock, a visible repaint without resuming or restarting the HTML backend, no
duplicate pause event, and advancing frames and clock after one explicit
resume. This mode covers the paused push-presentation recovery path where the
old frame's transferred storage is no longer retained.

For `raw-planes` playback, device-loss recovery acquires one replacement
device, reruns the exact raw HDR pixel-readback authorization on that device,
and resumes only if the active route passes again. A failed reauthorization or
a second device loss falls back to the owned HTML player.

The `presentation` injection calls the presenter's explicit fallback method; it
does not claim to manufacture an actual shader, import, or queue submission
failure. Both injection modes run in a separate playback session after the
ordinary lifecycle exercises.

The command writes one JSON result and returns a nonzero exit code on failure.
Output includes only bounded counters, states, and failure codes. URLs,
usernames, passwords, authorization fields, cookies, and token-like query
parameters are recursively removed before serialization.

Run the pure helper tests without opening or navigating a browser:

```powershell
node --test scripts/webgpu/browser-smoke-helpers.node-test.mjs
node --test scripts/webgpu/cdp-retention-snapshot.node-test.mjs
node --test scripts/webgpu/release-validation-metrics.node-test.mjs
```
