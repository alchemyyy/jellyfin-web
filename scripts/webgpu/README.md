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
- Serve the frontend and Jellyfin backend on `localhost`.
- Start Chrome or Edge with a remote-debugging port and leave one page open.
- Choose a direct-play video whose exact video and audio WebCodecs
  configurations are supported by that browser.

Keep credentials out of scripts and shell history by using environment
variables:

```powershell
$env:WEBGPU_SMOKE_DEBUG_URL = 'http://localhost:9224'
$env:WEBGPU_SMOKE_FRONTEND_URL = 'http://localhost:8080'
$env:WEBGPU_SMOKE_SERVER_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_ITEM_ID = '<video-item-id>'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'video-frame' # or raw-planes
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'native' # or bundled-hevc
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'disabled' # or ready
$env:WEBGPU_SMOKE_COMPLETION_MODE = 'controlled-stop' # or natural-end
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '3' # optional Jellyfin stream index
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3' # required with stream index
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1' # optional, 1 through 5
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '3' # optional, 0 through 5
$env:WEBGPU_SMOKE_INJECT_FAILURE = 'none' # presentation, device-loss, paused-device-loss
$env:WEBGPU_SMOKE_USERNAME = '<username>'
$env:WEBGPU_SMOKE_PASSWORD = '<password>'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Equivalent CLI flags are available through `--help`, but the username and
password flags expose those values to the local process list. URL arguments
default to the three localhost values shown above; item ID and credentials
remain required. The expected video output and audio path are also required so
the harness tests the intended pipeline rather than inferring intent from the
observed telemetry. Use `video-frame` with `disabled` for a video-only SDR item,
or `raw-planes` with `ready` for an HDR item with custom-decoded audio.

A `raw-planes` result is accepted only when
`getRawHDRAuthorizationTelemetry()` reports `status: 'authorized'` on the
active presentation device and its `authorizedRouteKeys` contains the exact
route derived from the active raw frame format, matrix, primaries, range, and
PQ or HLG transfer. The report retains only that bounded route key, target
format, versions, route lists, and failure codes; it does not serialize GPU
objects or source details.

To exercise an in-session audio track change, set both
`WEBGPU_SMOKE_AUDIO_STREAM_INDEX` and `WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC`. The
harness requires a new decoder generation, decoded audio samples, the exact
decoder codec, uninterrupted WebGPU presentation, and no fallback or terminal
error. Audio stream selection is intentionally limited to one playback session
per invocation so a later Jellyfin replay cannot silently restore the item's
default track. The locally bundled AC-3 validation route additionally requires
an enabled, non-distributable AC-3 build as described above.

The harness connects through the add-server form, signs in when the selected
server does not already have a valid saved session, opens the details page, and
uses a CDP user-gesture activation on Play. Before that activation it
temporarily wraps `window.Events.trigger` and captures the priority-0 player
from its event target. No player reference or diagnostic global is added to
production code.

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
```
