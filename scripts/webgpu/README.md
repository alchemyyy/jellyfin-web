# WebGPU color diagnostics and playback harnesses

The unified entry point is
`python scripts/webgpu/validation_matrix.py`. It validates the canonical
content-addressed fixture registry, selects fixed adapters without shell
strings, deduplicates shared checks, and writes sanitized JSON, Markdown, HTML,
and manual-checklist reports. See
`scripts/webgpu/validation/README.md` for matrices, selectors, private live-case
overlays, schemas, and the shared failure vocabulary.

```powershell
python scripts/webgpu/validation_matrix.py validate --verify-fixtures
python scripts/webgpu/validation_matrix.py plan --matrix static
python scripts/webgpu/validation_matrix.py run --matrix static
python scripts/webgpu/generate_validation_live_overlay.py --list-catalog
```

Use `generate_validation_live_overlay.py` with an ignored source specification
to expand exact HDR/Dolby Vision routes through the shared lifecycle, fault,
startup, retention, worker, and mpv A/B adapters. The generated overlay stores
only environment names and content identities, never private values. The
complete procedure and schemas are in `validation/README.md`.

The individual commands below remain adapter implementations and focused
debugging entry points. New release orchestration belongs in the shared matrix,
not another top-level smoke wrapper.

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

Generate PQ and HLG fixtures for every qualified playback frame-rate tier:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -FrameRates 24,30,60 `
    -Overwrite
```

The generator accepts only 24, 30, and 60 fps. These correspond to the
production raw HDR playback tiers; production enables each codec tier only
after its measured decode-and-copy throughput passes with 1.25x headroom.
A 1080p60 fixture is correctly signaled as HEVC Level 4.1. Use
`-Resolution 720p -FrameRates 60` to generate a Level 4 route fixture for a
bundled tier that is qualified for 60 fps throughput but retains its exact
Level 4 stream bound.

Optionally add a PQ stream-switch fixture:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -IncludeAC3 `
    -IncludeEAC3 `
    -IncludePCM `
    -Overwrite
```

`-IncludeAC3` adds `pq-main10-1080p24-aac-ac3.mkv`. It retains the default
stereo 48 kHz AAC track from the PQ fixture and appends a non-default stereo
48 kHz AC-3 track. It is specifically structured to start through the ordinary
AAC route and then validate a live switch to the standard Mediabunny AC-3
decoder without changing the video route. `-IncludeEAC3` creates the equivalent
`pq-main10-1080p24-aac-eac3.mkv` E-AC-3 switch fixture. `-IncludePCM` appends a
non-default mono 44.1 kHz signed 24-bit PCM track and creates
`pq-main10-1080p24-aac-pcm_s24le-44100-mono.mkv`. It exercises Mediabunny's
built-in PCM decoder, mono mapping, and the shared 44.1-to-48 kHz resampler.
None is an audio-codec-only file. All switch fixtures require `24` in
`-FrameRates`. Generation requires FFmpeg and FFprobe, an FFmpeg build with
`libx265`, and the requested audio encoders.

Use `-ReuseExistingBaseFixtures` to verify and reuse existing PQ/HLG base files
while creating a missing switch fixture. This avoids an unnecessary HEVC
re-encode; pass the original `-DurationSeconds` value so the added audio has the
same duration. Existing switch outputs still require `-Overwrite`.

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
The signature accepts three of four fixed bar samples because testsrc2's moving
overlay can legitimately cover one sample while the two captures are taken.
It therefore rejects black, static, or grossly misordered decoded output that
would otherwise satisfy frame counters. Leave it at its default `none` for
ordinary media whose pixels do not follow this generated pattern.

For fullscreen, resize, slider-shaped volume, mute, pause/resume, seek, and stop
in one run, generate a longer lifecycle set instead of weakening progress
assertions around a six-second end of stream:

```powershell
./scripts/webgpu/generate-playback-smoke-media.ps1 `
    -FfmpegPath ffmpeg `
    -FfprobePath ffprobe `
    -DurationSeconds 30 `
    -Overwrite
```

`-DurationSeconds` accepts 6 through 120 seconds. A longer run overwrites the
same deterministic route names in the selected output directory, so scan the
Jellyfin validation library again before lifecycle smoke.

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
same WebGPU HDR presentation active, and finish without fallback or a terminal
error.

Run the E-AC-3 fixture identically, using its E-AC-3 `MediaStream.Index` and:

```powershell
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ec-3'
```

The run must report the Mediabunny software decoder and decoded PCM rather than
native-media audio on a runtime whose exact native E-AC-3 probe is rejected.

Run the PCM switch fixture with its Jellyfin `MediaStream.Index` and require
both the decoded source shape and normalized player output:

```powershell
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '<PCM MediaStream.Index>'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'pcm-s24'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_CHANNELS = '1'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_RATE = '44100'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_CHANNELS = '2'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_RATE = '48000'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'ready'
$env:WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE = 'testsrc2-motion'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

The four shape expectations are optional as a group and invalid individually.
When supplied, the run fails unless telemetry proves the selected source and
the PCM delivered to the AudioWorklet have those exact layouts and rates.

Probe WebCodecs configurations and the WebGPU adapter in a real browser started
with a remote debugging port:

```powershell
node scripts/webgpu/probe-browser-runtime.mjs http://localhost:9224 http://localhost:8096
```

Use a `localhost` target so the page is a secure context.

## Static HDR metadata state matrix

`generate_static_HDR_validation_fixtures.py` creates four 12-second PQ Main10
Matroska fixtures with stereo FLAC. They exercise exact `absent`, `malformed`,
`conflicting`, and `valid` mastering-display/content-light states. The valid
fixture declares a 4000-nit mastering peak; every rejected state must retain
the renderer's bounded 1000-nit default. Generated media, its identity
manifest, and its path-free live specification are ignored local artifacts.

```powershell
python scripts/webgpu/generate_static_HDR_validation_fixtures.py --overwrite
python -m unittest discover -s scripts/webgpu -p '*static_HDR*_test.py'
```

Add the absolute `scripts/webgpu/playback-smoke-media` directory to a local
Jellyfin validation library and scan it. With Jellyfin, the current frontend,
and a CDP-enabled browser running, supply account and log-directory values only
through arguments or environment variables and run:

```powershell
$env:WEBGPU_SMOKE_USERNAME = '<validation account>'
$env:WEBGPU_SMOKE_PASSWORD = '<validation password>'
$env:WEBGPU_SMOKE_SERVER_LOG_DIRECTORY = '<Jellyfin log directory>'

python scripts/webgpu/run_static_HDR_live_validation.py
```

The runner verifies every fixture's byte length and SHA-256, resolves its
Jellyfin item only by exact local path, and runs Mediabunny packetization plus
the production TypeScript HEVC scanner before opening the browser. It then
generates an ignored content-addressed overlay and requires all four custom
DirectPlay lifecycle cases to report the exact scan state, bounded access-unit
count, first metadata index, tone-mapping peak, and sanitized server-log
evidence. `--selector case:<id>` narrows browser execution without weakening
the four-fixture production-parser preflight.

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

## Standard Mediabunny AC-3 and E-AC-3 decoder

Ordinary builds include the official pinned `@mediabunny/ac3` decoder. It is
lazy-loaded only for a selected AC-3/E-AC-3 track and registered once per
worker. The exact native-media route remains preferred where available; the
Mediabunny route provides decoded PCM everywhere the custom worker can load the
pinned package.

After every ordinary build, run:

```powershell
node scripts/webgpu/verify-custom-codec-artifacts.mjs
```

The verifier checks copied HEVC/Dolby Vision artifacts, requires the stable
Mediabunny AC-3 implementation sentinel in executable JavaScript, and requires
`dist/libraries/mediabunny-ac3/LICENSE.txt` to match the pinned package. The
package and its MPL-2.0 distribution terms are approved for this project.

## End-to-end browser playback smoke test

`run-browser-playback-smoke.mjs` drives an already-running Chromium page through
the real Jellyfin UI using the raw Chrome DevTools Protocol. It does not launch
or stop Chromium, Jellyfin, or the static frontend server. Coordinate with
anyone using the debugging page before running it because it navigates that
existing page.

Prerequisites:

- Build and serve Jellyfin Web normally. The harness overlays the four WebGPU
  flags only in intercepted `config.json` responses for ordinary custom smoke
  and isolated startup-comparison pages; it does not require or modify the
  served flag values. Enable `multiserver` in the served configuration when the
  static frontend and Jellyfin API use different ports.
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
$env:WEBGPU_SMOKE_FRONTEND_URL = 'http://localhost:8096/web'
$env:WEBGPU_SMOKE_SERVER_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_SERVER_LOG_DIRECTORY = "$env:LOCALAPPDATA\jellyfin\log" # optional
$env:WEBGPU_SMOKE_ITEM_ID = '<video-item-id>'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'video-frame' # or raw-planes
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'native' # or bundled-hevc
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'disabled' # ready or native-media
$env:WEBGPU_SMOKE_EXPECTED_PLAY_METHOD = 'DirectPlay' # DirectStream or Transcode
$env:WEBGPU_SMOKE_COMPLETION_MODE = 'controlled-stop' # or natural-end
$env:WEBGPU_SMOKE_AUDIO_STREAM_INDEX = '3' # optional Jellyfin stream index
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC = 'ac-3' # required with stream index
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_CHANNELS = '1' # optional shape group
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_RATE = '44100'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_CHANNELS = '2'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_RATE = '48000'
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
password flags expose those values to the local process list. Item ID and
credentials remain required. The expected video output and audio path are also
required so the harness tests the intended
pipeline rather than inferring intent from the observed telemetry. Use
`video-frame` with `disabled` for a video-only SDR item, or `raw-planes` with
`ready` for an HDR item with custom-decoded PCM, or `native-media` for an exact
owned native-audio route that passed the runtime fixture probe.

Set `WEBGPU_SMOKE_EXPECTED_PLAY_METHOD=DirectPlay` for custom decode acceptance.
The harness captures the selected method and bounded media-source capability
booleans from the player, then queries the matching Jellyfin device/item/media
source session while playback is active. It requires the client and server
methods to agree. A DirectPlay result additionally requires no active
`TranscodingInfo` and an empty transcode-reason list. Reports retain no item,
media-source, device, or stream URL identifiers. The default frontend is the
normal Jellyfin-served `http://localhost:8096/web` surface; the API remains
`http://localhost:8096`.

Set `WEBGPU_SMOKE_SERVER_LOG_DIRECTORY` to require bounded server-side evidence
for the same invocation. The harness snapshots byte sizes for the retained
Jellyfin primary and FFmpeg transcode logs, reads at most 8 MiB appended after
the snapshot, and waits up to five seconds for the exact item/user start and
stop sequence. It reports only counts, `start`/`stop` tokens, playback-policy
booleans, warning/error counts, and transcode-log activity. Raw log lines,
filenames, paths, account/title values, tokens, and identifiers are never
written. A DirectPlay assertion requires no new or changed FFmpeg transcode log.
Generated private browser cases require this directory so session API evidence
and independently captured server-log evidence must agree.

A `raw-planes` result is accepted only when
`getRawHDRAuthorizationTelemetry()` reports `status: 'authorized'` on the
active presentation device and its `authorizedRouteKeys` contains the exact
route derived from the active raw frame format, matrix, primaries, range, and
PQ or HLG transfer. The report retains only that bounded route key, target
format, versions, route lists, and failure codes; it does not serialize GPU
objects or source details.

Raw Dolby Vision uses its dedicated authorization telemetry instead. Profile 5
and 8 require route `I420P10:dovi-rpu-v1`. Profile 7 requires the separately
gated `I420P10:dovi-profile7-base-v1` route and all 18 MEL plus FEL-base fixture
samples. Full FEL presentation additionally requires the nine-sample
`I420P10:dovi-profile7-fel-v1` route.
An active Profile 7 smoke additionally requires a nonzero, bounded sum of the
MEL-presented, FEL-presented, and FEL-base-fallback presentation counters. Any
nonzero FEL-presented count requires exact FEL authorization in the same
snapshot.

The worker-only Profile 7 smoke bypasses Jellyfin device-profile selection so
decoder/protocol correctness can still be tested when a machine correctly
fails the conservative 4K throughput gate. Serve a documented Profile 7 FEL
fixture from the same frontend origin with a registered static suffix such as
`.bin`, keep a Chromium page open on that origin, and run:

```powershell
node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/dovi-p7-fel.bin
```

By default the gate requires a 3840x2160 I420P10 BL and 1920x1080 I420P10 EL.
Use `--expected-base-width` and `--expected-base-height` for a bounded structural
fixture; the expected EL dimensions follow the same full- versus half-resolution
Profile 7 rule as production. Every size requires one shared atomic buffer, PTS
agreement within one microsecond, schema-versioned `decoded-fel` metadata, one
parsed RPU, and clean worker shutdown. Fixtures are not checked in; record their
provenance and hashes in the validation result.

The command discovers exactly one content-addressed `CustomDecode.worker`
artifact in the local `dist` directory and uses that filename on the configured
frontend origin. It fails closed if the build is missing or ambiguous. Use
`--worker-url` only when validating a separately built frontend whose emitted
worker is not present in the local `dist` directory.

To prove the container-only `hvcE` route, transform the official FFmpeg
`dovi-p7-hvce` FATE sample into a same-size validation copy. The tool preserves
the Matroska `hvcE` mapping but replaces the wrapped EL VPS/SPS/PPS with valid
filler NAL units:

```powershell
node scripts/webgpu/create-container-only-hvce-fixture.mjs `
    "$env:TEMP\dovi-p7-hvce.mkv" `
    "$env:TEMP\dovi-p7-container-only-hvce.mkv"

Copy-Item "$env:TEMP\dovi-p7-container-only-hvce.mkv" `
    dist/webgpu-dovi-p7-container-only-hvce.bin

node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/webgpu-dovi-p7-container-only-hvce.bin
```

Use a static suffix accepted by the running Jellyfin frontend, such as `.bin`.
Remove the served copy after validation; neither source fixture is checked in.
Run the transformer's unit coverage with:

```powershell
node --test scripts/webgpu/create-container-only-hvce-fixture.node-test.mjs
```

To prove the separate-track Matroska route, use MKVToolNix to split the same
official interleaved FATE sample into independent BL and EL/RPU HEVC tracks:

```powershell
node scripts/webgpu/create-separate-track-dolby-vision-fixture.mjs `
    "$env:TEMP\dovi-p7-hvce.mkv" `
    "$env:TEMP\dovi-p7-separate-track.mkv" `
    --mkvtoolnix-directory "C:\Program Files\MKVToolNix"

Copy-Item "$env:TEMP\dovi-p7-separate-track.mkv" `
    dist/webgpu-dovi-p7-separate-track.bin

node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/webgpu-dovi-p7-separate-track.bin
```

The generator requires exactly one source HEVC track, removes the NAL type 63
wrapper, places the RPU on the ordinary HEVC EL track, and repeats the access
unit three times so MKVToolNix can identify and mux both raw streams. The smoke
then exercises bounded container-topology discovery, independent packet
iteration, decode-order PTS verification, RPU association, second decode, and
compound-frame ownership. Remove the served `.bin` copy after validation. Run
generator unit coverage with:

```powershell
node --test scripts/webgpu/create-separate-track-dolby-vision-fixture.node-test.mjs
```

To prove legacy dual-track Profile 7 in ISO BMFF, remux the generated
two-track Matroska fixture and add the `dvh1`/`dvhe`, `dvcC`, and `vdep`
topology required by Annex C carriage:

```powershell
node scripts/webgpu/create-dual-track-dolby-vision-mp4-fixture.mjs `
    "$env:TEMP\dovi-p7-separate-track.mkv" `
    "$env:TEMP\dovi-p7-dual-track.mp4"

Copy-Item "$env:TEMP\dovi-p7-dual-track.mp4" `
    dist/webgpu-dovi-p7-dual-track.bin

node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/webgpu-dovi-p7-dual-track.bin
```

The MP4 generator uses FFmpeg only to copy the two ordinary HEVC tracks. It
then validates compact `moov`/`trak` boxes, requires all `mdat` boxes before
`moov`, changes the EL sample entry to `dvh1` or `dvhe`, clears the dvcC BL
flag, and inserts one `tref`/`vdep` reference to the BL track. Keeping media
data before `moov` means the 20-byte metadata insertion does not invalidate
sample offsets. The worker reads the topology and EL `hvcC` through bounded
HTTP ranges because Mediabunny exposes packets and dimensions for the Dolby
Vision sample entry but currently reports its codec and decoder configuration
as null. Remove the served `.bin` copy after validation. Run patcher coverage
with:

```powershell
node --test scripts/webgpu/create-dual-track-dolby-vision-mp4-fixture.node-test.mjs
```

For server-metadata validation, copy the `.mp4` into an ignored Jellyfin test
library on the configured Jellyfin 12 nightly server and refresh it. The server
must expose exactly two HEVC video
streams: a 10-bit PQ BL and a matching Profile 7.6 RPU/EL track. The MP4 EL is
expected to report `BlPresentFlag=0`; the equivalent separate-track Matroska
fixture currently reports `BlPresentFlag=1`. Eligibility accepts either value
only with exact P7 flags, matching frame rates, and the expected EL geometry.
It must still reject ordinary files containing multiple independent video
tracks.

The conservative bundled-HEVC capability probe can correctly reject 4K while
the two-track protocol still needs a complete Jellyfin playback test. Generate
a validation-only 1920x1080 structural fixture without weakening that runtime
gate:

```powershell
node scripts/webgpu/create-profile7-playback-fixture.mjs `
    "$env:TEMP\dovi-p7-separate-track.mkv" `
    "$env:TEMP\dovi-p7-1080p-structural.mp4" `
    --mkvtoolnix-directory "C:\Program Files\MKVToolNix"

Copy-Item "$env:TEMP\dovi-p7-1080p-structural.mp4" `
    scripts/webgpu/validation-media/dovi-p7-1080p-structural.mp4

Copy-Item "$env:TEMP\dovi-p7-1080p-structural.mp4" `
    dist/webgpu-dovi-p7-1080p-structural.bin

node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/webgpu-dovi-p7-1080p-structural.bin `
    --expected-base-width 1920 `
    --expected-base-height 1080

node --test scripts/webgpu/create-profile7-playback-fixture.node-test.mjs
```

The generator repeats the short source, re-encodes only the BL as 10-bit PQ
HEVC, copies the EL/RPU track, normalizes both timelines with MKVToolNix, and
then invokes the legacy dual-track MP4 patcher. It is deterministic for fixed
tool versions and input. Because the BL is scaled and re-encoded, this output
is only a topology, ownership, decoder, presentation, and lifecycle fixture. It
must not be used for Dolby Vision color-fidelity comparisons.

To prove separate-PID Profile 7 carriage through MPEG-TS, remux either
two-track fixture and add the exact PMT dependency descriptor:

```powershell
node scripts/webgpu/create-dual-pid-dolby-vision-ts-fixture.mjs `
    "$env:TEMP\dovi-p7-1080p-structural.mp4" `
    "$env:TEMP\dovi-p7-dual-pid-1080-structural.ts" `
    --ffmpeg "C:\ffmpeg\ffmpeg.exe"

Copy-Item "$env:TEMP\dovi-p7-dual-pid-1080-structural.ts" `
    scripts/webgpu/validation-media/dovi-p7-dual-pid-1080-structural.ts

Copy-Item "$env:TEMP\dovi-p7-dual-pid-1080-structural.ts" `
    dist/webgpu-dovi-p7-dual-pid-1080-structural.bin

node scripts/webgpu/run-dolby-vision-worker-smoke.mjs `
    --debug-url http://127.0.0.1:9226 `
    --frontend-url http://localhost:8096/web/ `
    --media-url http://localhost:8096/web/webgpu-dovi-p7-dual-pid-1080-structural.bin `
    --expected-base-width 1920 `
    --expected-base-height 1080

node --test scripts/webgpu/create-dual-pid-dolby-vision-ts-fixture.node-test.mjs
```

The generator copy-muxes BL to PID `0x100` and EL/RPU to PID `0x101`, then
patches every bounded single-packet PMT and recomputes its MPEG-2 CRC. It keeps
both entries at HEVC `stream_type 0x24` because Mediabunny 1.52.2 does not
expose a track for the standards-defined private-data `stream_type 0x06`.
Production discovery accepts either value, validates PAT/PMT continuity and
CRC data within the first 1 MiB, and also recognizes the HDMV registration
plus fixed `0x1011`/`0x1015` BDMV pair. A standards-defined `0x06` EL still
fails closed until the demuxer exposes that PID as a track; the local metadata
parser does not replace PES demuxing.

The generated transport stream exposes descriptionless Annex B HEVC tracks.
The worker permits that shape only after exact Profile 7 dependency discovery,
exact BL/EL geometry, and an Annex B decoder configuration; malformed or
ambiguous signaling remains BL-only. Jellyfin may label the EL as `HDR10`
despite exact Profile 7 side data. That label is accepted only for one exact
two-track source with matching PQ metadata, flags, geometry, and frame rates.
The device profile authorizes that HDR10 label only for the same item-scoped
request.

After copying the `.ts` file into the ignored validation library and scanning
it, run the complete Jellyfin path with the resulting item ID:

```powershell
$env:WEBGPU_SMOKE_DEBUG_URL = 'http://127.0.0.1:9226'
$env:WEBGPU_SMOKE_FRONTEND_URL = 'http://localhost:8096/web/'
$env:WEBGPU_SMOKE_SERVER_URL = 'http://localhost:8096'
$env:WEBGPU_SMOKE_ITEM_ID = '<transport-stream-item-id>'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT = 'raw-planes'
$env:WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER = 'bundled-hevc'
$env:WEBGPU_SMOKE_EXPECTED_AUDIO = 'disabled'
$env:WEBGPU_SMOKE_COMPLETION_MODE = 'natural-end'
$env:WEBGPU_SMOKE_REPEAT_SESSIONS = '1'
$env:WEBGPU_SMOKE_SEEK_STORM_COUNT = '0'
$env:WEBGPU_SMOKE_USERNAME = '<username>'
$env:WEBGPU_SMOKE_PASSWORD = '<password>'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Native decoded Profile 5 is also HDR despite using `video-frame` output. The
harness requires `external-dolby-vision` presentation and authorized route
`external-I420P10-bt709-limited:dovi-p5-rpu-v1`; it does not infer SDR merely
from the output mode. Reports retain both that active authorization and the
prewarmed Profile 7 authorization so one smoke session verifies route isolation.
Fixture version 2 also reports finite `maximumInputChannelError` and
`maximumChannelError` values for the recovered base signal and final output;
the harness rejects older authorization telemetry that lacks either measurement.
The capability snapshot also reports the measured native Profile 5 throughput
and its qualified 24, 30, or 60 fps device-profile tier.

To exercise an in-session audio track change, set both
`WEBGPU_SMOKE_AUDIO_STREAM_INDEX` and `WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC`. The
harness requires a new decoder generation, the exact audio codec, uninterrupted
WebGPU presentation, and no fallback or terminal error. A `ready` route must
produce decoded PCM samples; a `native-media` route must append native segments
and qualify the owned element clock. Audio stream selection is intentionally
limited to one playback session per invocation so a later Jellyfin replay cannot
silently restore the item's default track. The standard Mediabunny AC-3/E-AC-3
decoder loads only after such a track is selected.

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
- the explicitly expected Jellyfin play method when configured, with matching
  bounded client/server session evidence and no transcode state or reasons for
  DirectPlay;
- the exact server-log start/stop sequence and no FFmpeg transcode-log activity
  for DirectPlay when server-log capture is configured;
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
For SDR identity input, the harness creates isolated long-lived pages for HTML,
HTML-backed WebGPU presentation, and custom decode. For HDR and Dolby Vision it
creates only HTML and custom-decode pages: the presentation-only player
intentionally leaves native HDR on the browser-managed video surface because a
native-media external texture is already browser color-converted. Treating that
surface as raw PQ, HLG, or Dolby Vision would make the comparison invalid.
Context isolation prevents Jellyfin's same-origin authentication and server
selection from making modes replace or redirect one another. It runs one
unmeasured warmup per applicable mode, then measures the same item once per mode
in every round without reloading those pages. Odd rounds start with HTML and
even rounds start with custom; the SDR presentation sample remains between
them. This balances run-order drift while keeping every round matched by sample
number on the same browser, server, account, and item.

Each temporary page first loads through a CDP `Fetch` response overlay for
`config.json` to establish authentication, then receives one synchronized
measurement-document load before warmup and sampling. HTML disables the WebGPU
plugin, presentation enables the wrapper but disables custom decode, and custom
enables the player, custom decode, HDR tone mapping, and diagnostic
authorization. Presentation-only mode is created only for SDR identity input.
The served `dist/config.json` is never edited. HTTP caching remains enabled so
the warmup can populate normal bundle and artifact caches, while service
workers remain bypassed. The interceptors are drained and disabled and every
temporary target and browser context is destroyed before the command exits;
the user's original page is not repurposed for a comparison mode. Server-log
capture starts only after those temporary contexts are authenticated and
prepared, so their expected unauthenticated socket probes remain outside the
measured playback window.

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

For every matched SDR round, presentation playing, first-audio when expected, and
first-visible-frame regression is compared with the greater of 50 milliseconds
or 10 percent of that round's HTML value for the median gate, and the greater
of 100 milliseconds or 15 percent for the p95 gate. Its local
canvas-attach-to-frame median must be at most 100 milliseconds and p95 at most
250 milliseconds. Custom comparisons use the greater of 250 milliseconds or
20 percent of paired HTML for the median gate and 500 milliseconds or 30
percent for p95. HDR and Dolby Vision report presentation validation as not
applicable rather than sampling a color-invalid native-media texture. A gate
fails when the median or nearest-rank p95 of matched
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

The harness also records a pre-playback resource snapshot to prove that no
controlled-page custom decode worker was already active and to retain ambient
resource counts for diagnosis. Custom-audio resource gates use absolute
stopped-page totals, so an existing same-page audio object cannot hide an extra
player allocation.

- JavaScript and embedder heap: at most 16 MiB growth and a 256 KiB/session
  Theil-Sen slope.
- Backing storage: at most 8 MiB growth and a 128 KiB/session slope.
- Documents: no change; DOM nodes: at most 32 growth and a 0.5/session slope;
  event listeners: at most 16 growth and a 0.25/session slope.
- Every available queried media/WebGPU object type: at most baseline plus one
  and a 0.1 object/session slope. A custom-audio run additionally requires
  exactly one total `AudioContext`, `AudioWorkletNode`, and
  `AudioWorkletProcessors` Performance object after every stop. Owned
  native-media and audio-disabled runs require zero worklet nodes and
  processors. Their unused PCM prewarm may leave one suspended `AudioContext`,
  so that context remains subject to the generic bounded-growth gate.
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

## JPEG 2000 qualification

The OpenJPEG route uses the checked-in
`jpeg2000-capability-fixtures/srgb-960x540.jp2` fixture. Regenerate and verify it
with:

```powershell
python scripts/webgpu/generate_jpeg2000_capability_fixture.py
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
```

The browser exact-capability worker verifies the full decoded RGBA fingerprint
and steady-state throughput before the device profile advertises `jpeg2000`.
See `WEBGPU_JPEG2000.md` for the supported envelope and expansion procedure.

## Legacy video qualification

The progressive MPEG-2 route uses the focused FFmpeg build and checked-in
`legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv` fixture.
Regenerate, rebuild, and verify it with:

```powershell
python scripts/webgpu/generate_legacy_video_capability_fixture.py
python scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py --verify-reproducible
node scripts/webgpu/verify-legacy-video-decoder-artifacts.mjs
npm test -- src/plugins/webGPUVideoPlayer/custom/LegacyVideoDecoderIntegration.test.ts
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
```

The browser probe performs full Matroska demux, reordered decode, byte-count,
I420 fingerprint, and throughput validation before the device profile
advertises `mpeg2video`. See `WEBGPU_LEGACY_VIDEO.md` for the supported envelope
and explicit container, profile, geometry, frame-rate, and interlace exclusions.
This route is progressive MPEG-2 Main in Matroska only. It does not authorize
VC-1/WMV3, interlaced MPEG-2, or MPEG-2 in TS/MTS/M2TS, PS/VOB, MOV, or MP4.

## TrueHD/MLP qualification

The Matroska TrueHD/MLP route keeps Mediabunny as the container, range, packet,
timestamp, and seek layer and lazy-loads a pinned TrueHD/MLP-only FFmpeg
`libavcodec` WebAssembly decoder. Rebuild the focused LGPL artifact, regenerate
the embedded deterministic packet/PCM records, and verify exact bytes with:

```powershell
python scripts/webgpu/build_truehd_decoder.py --verify-reproducible
python scripts/webgpu/generate_truehd_capability_fixtures.py
node scripts/webgpu/verify-truehd-decoder-artifacts.mjs
npm test -- src/plugins/webGPUVideoPlayer/custom/TrueHDSoftwareAudioDecoder.integration.test.ts
npm test -- src/plugins/webGPUVideoPlayer/custom/TrueHDExactCapabilityRunner.integration.test.ts
npm test -- src/plugins/webGPUVideoPlayer/custom/TrueHDMediabunnyDemuxIntegration.test.ts
```

The browser exact-capability worker requires lossless PCM fingerprints for
TrueHD stereo/48, TrueHD 5.1/96, TrueHD 5.1/192, and MLP stereo/48, recovery at
a later major sync after dependent-frame startup, and at least 2x real-time
throughput. These four tuples are an exact union, not a channel/rate Cartesian
product.
Atmos is explicitly channel-bed-only. Seven/eight-channel and M2TS routes remain
unadvertised pending exact fixtures and bounded demux evidence. See
`WEBGPU_TRUEHD.md` for the supported envelope and expansion procedure.

## DTS qualification

The Matroska DTS route uses Mediabunny packet demux and a pinned libdcadec
codec-only WebAssembly module. Release artifacts are built twice from isolated
source trees and must match exactly:

```powershell
python scripts/webgpu/build_dts_decoder.py --verify-reproducible
python scripts/webgpu/generate_dts_capability_fixtures.py --check
python scripts/webgpu/generate_seven_point_one_downmix_reference.py --check
node scripts/webgpu/verify-dts-decoder-artifacts.mjs
npx vite-node --script scripts/webgpu/report_dts_downmix_reference.ts --check
npm test -- src/plugins/webGPUVideoPlayer/custom/DTSSoftwareAudioDecoder.integration.test.ts
npm test -- src/plugins/webGPUVideoPlayer/custom/DTSMediabunnyDemuxIntegration.test.ts
```

Capability and server negotiation authorize only the seven exact
profile/layout/rate tuples recorded in `WEBGPU_DTS.md`. They do not authorize a
Cartesian product. DTS:X means decoded DTS-HD MA channel bed only. Eight-channel
output uses the WAVE `FL, FR, FC, LFE, BL, BR, SL, SR` order and the explicitly
selected `mpv --audio-normalize-downmix=yes` stereo matrix. See
`WEBGPU_AUDIO_DOWNMIX.md` for the pinned mpv/FFmpeg comparison, metrics, and
external reproduction command.

## Portable mpv/browser A/B manifest

Copy `scripts/webgpu/mpv-ab-manifest.example.json` to an ignored local manifest
before running `run_mpv_ab.py`. Replace its placeholder Jellyfin item ID and
timestamps with values for the local validation source. Supply server URLs and
credentials through environment variables; never add an authenticated URL,
account value, local media identifier, or machine-specific tool path to the
portable example or a committed report.

Run the pure helper tests without opening or navigating a browser:

```powershell
node --test scripts/webgpu/browser-smoke-helpers.node-test.mjs
node --test scripts/webgpu/cdp-retention-snapshot.node-test.mjs
node --test scripts/webgpu/release-validation-metrics.node-test.mjs
node --test scripts/webgpu/server-log-evidence.node-test.mjs
```
