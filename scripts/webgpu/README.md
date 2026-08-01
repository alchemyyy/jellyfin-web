# WebGPU color validation harness

Use a dedicated canvas for validation. The harness configures it with both
`GPUTextureUsage.RENDER_ATTACHMENT` and `GPUTextureUsage.COPY_SRC`; do not attach
it to an active playback presenter.

1. Create an SDR, PQ, or HLG `ColorValidationRamp` with
   `createTransferValidationRamp`.
2. Render the corresponding reference frame into the validation canvas. An
   `rgba16float` canvas is required to prove that HDR values above normalized
   SDR white survive the browser path.
3. After submitting each reference frame, call `captureCurrentFrame` with its
   integer-microsecond timestamp.
4. Call `evaluate`. Only `classification: 'valid'` permits the custom color
   pipeline. `clamped`, `double-transformed`, `mismatch`, `invalid-samples`, and
   `readback-unavailable` require native-video fallback.
5. Call `destroy` to release pending map buffers and unconfigure an owned canvas.

Generate eight-frame, one-frame-per-second SDR/PQ/HLG clips without checking
binaries into Git:

```powershell
./scripts/webgpu/generate-color-validation-media.ps1 -FfmpegPath ffmpeg -Overwrite
```

The script writes a manifest containing the exact integer-microsecond frame
times and encoded RGB triplets. Five achromatic levels test transfer handling;
three chromatic samples expose matrix or primaries conversion. The generator
maps each RGB triplet through the tagged BT.709 or BT.2020 nonconstant-luminance
matrix, quantizes it to limited-range 8-bit or 10-bit YUV codes, and records the
exact RGB value reconstructed from those integer codes. The HDR clips use
lossless 10-bit HEVC and require an FFmpeg build with `libx265`. Media-query
results and container color tags are diagnostics only; they are not substitutes
for GPU readback validation.

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
```

The adapter requires requests in manifest order and rejects any decoded sample
or `VideoFrame` whose integer-microsecond timestamp differs. It transfers each
fresh frame to the validation runner, which closes it. The convenience function
always destroys the Mediabunny iterator and input. Do not log authenticated
media URLs; provider errors intentionally omit URLs and query credentials.

Probe WebCodecs configurations and the WebGPU adapter in a real browser started
with a remote debugging port:

```powershell
node scripts/webgpu/probe-browser-runtime.mjs http://localhost:9224 http://localhost:8080
```

Use a `localhost` target so the page is a secure context.

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
$env:WEBGPU_SMOKE_USERNAME = '<username>'
$env:WEBGPU_SMOKE_PASSWORD = '<password>'
node scripts/webgpu/run-browser-playback-smoke.mjs
```

Equivalent CLI flags are available through `--help`, but the username and
password flags expose those values to the local process list. URL arguments
default to the three localhost values shown above; item ID and credentials
remain required.

The harness connects through the add-server form, signs in when the selected
server does not already have a valid saved session, opens the details page, and
uses a CDP user-gesture activation on Play. Before that activation it temporarily wraps
`window.Events.trigger` and captures the priority-0 player from its event
target. No player reference or diagnostic global is added to production code.

The checks require:

- advancing custom decode and WebGPU presentation telemetry;
- a source-less owned `HTMLVideoElement` and a visible WebGPU canvas;
- a frozen application clock and renderer while paused;
- clock and frame progress after resume;
- an integer-microsecond seek landing within tolerance;
- one stop event, an idle presenter, no retained canvas or source, and no
  terminal player/browser errors.

The command writes one JSON result and returns a nonzero exit code on failure.
Output includes only bounded counters, states, and failure codes. URLs,
usernames, passwords, authorization fields, cookies, and token-like query
parameters are recursively removed before serialization.

Run the pure helper tests without opening or navigating a browser:

```powershell
node --test scripts/webgpu/browser-smoke-helpers.node-test.mjs
```
