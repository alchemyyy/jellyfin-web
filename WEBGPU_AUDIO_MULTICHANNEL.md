# WebGPU Native Multichannel Audio Output

Status: runtime-gated 5.1 and 7.1 decoded PCM output implemented; physical
speaker validation remains part of the hardware matrix

## HTML player parity decision

Implementation is justified because the normal Jellyfin HTML video player does
support and claim multichannel speaker output on the same browser contract:

- `src/scripts/browserDeviceProfile.js` reads
  `AudioContext.destination.maxChannelCount` and uses the result as the physical
  audio-channel limit. AC-3/E-AC-3 support can additionally identify a surround
  browser/device route.
- `src/plugins/htmlVideoPlayer/plugin.js` creates a normal `HTMLVideoElement`
  and does not force stereo through a Jellyfin Web Audio graph.
- Chromium 153 `media/renderers/audio_renderer_impl.cc` keeps the source layout
  when it has at least as many channels as the hardware layout, allowing the
  browser-side sink to downmix only when required.

The custom route previously differed: `CustomDecode.worker.ts` always applied
the stereo matrix before transferring PCM to a fixed two-channel AudioWorklet.

## Implemented contract

The decoded PCM route now selects output as follows:

| Source bed | `destination.maxChannelCount` | Output |
| --- | ---: | --- |
| 5.1 | 6 or more | Native 5.1 |
| 7.1 | 8 or more | Native 7.1 |
| 5.1 or 7.1 | Below the complete source bed | Qualified stereo downmix |
| Mono, stereo, 6.1, or unknown | Any | Existing stereo path |

The route never converts 7.1 to partial 5.1 and never infers output from codec,
bitrate, browser name, or Jellyfin server metadata alone. The prewarmed 48 kHz
output `AudioContext` used by playback supplies the hardware limit. Source-rate
metadata is validated independently and never selects the AudioContext rate.
Output creation rechecks the limit, sets `destination.channelCount`, and verifies
that the browser accepted it before creating the AudioWorklet.

Chromium 153 provides the required channel mapping:

- `content/renderer/media/renderer_webaudiodevice_impl.cc` maps the requested
  Web Audio output count through `GuessChannelLayout`.
- `media/base/channel_layout.cc` maps six channels to `CHANNEL_LAYOUT_5_1` and
  eight channels to `CHANNEL_LAYOUT_7_1`.
- Chromium's guessed six-channel Web Audio layout is
  `FL, FR, FC, LFE, SL, SR`; its eight-channel layout is
  `FL, FR, FC, LFE, BL, BR, SL, SR`.
- A decoded `5.1-back` bed retains its surround pair in planes 4 and 5. Web
  Audio exposes those planes as its six-channel `SL`/`SR` pair because the API
  cannot attach a back-versus-side speaker mask. Exact Windows endpoint
  placement for that case remains part of physical hardware validation.
- Blink rejects destination counts above the physical maximum in
  `realtime_audio_destination_handler.cc`.

No device-profile or server DirectPlay claim was widened. Native multichannel
presentation is selected only after custom playback has already qualified the
codec, container, source layout, decoder, and current output device. A missing,
invalid, or insufficient browser probe deterministically retains stereo.

Volume, mute, normalization, output-time correlation, generation ownership,
and source-rate resampling remain shared with the stereo path. The worker now
resamples the selected complete output bed instead of downmixing first.
Encoded bitrate is telemetry only. After codec/profile/layout qualification,
decoded routes accept any safe integer source rate from 3000 through 192000 Hz
and normalize to the fixed 48 kHz AudioWorklet rate. The native AC-3/E-AC-3 MSE
bridge remains an independent exact-48-kHz encoded-media route.

## Deferred qualification

- A real 5.1 Windows speaker endpoint must verify isolated-channel routing for
  all six positions.
- A real 7.1 endpoint must verify all eight positions and Windows speaker-mask
  routing.
- Chrome and Edge must be checked separately on NVIDIA, AMD, and Intel systems.
- Output-device hot swapping during a session needs explicit behavior evidence.

Until those cases pass, `destination.maxChannelCount` is the runtime gate, not
a release-matrix qualification claim.

## Focused verification

```powershell
npm test -- `
    src/plugins/webGPUVideoPlayer/custom/NativeMultichannelAudioOutput.test.ts `
    src/plugins/webGPUVideoPlayer/custom/CustomAudioChannelLayout.test.ts `
    src/plugins/webGPUVideoPlayer/custom/CustomAudioOutputPolicy.test.ts `
    src/plugins/webGPUVideoPlayer/custom/BrowserCustomAudioOutput.test.ts `
    src/plugins/webGPUVideoPlayer/custom/DecodeWorkerProtocol.test.ts `
    src/plugins/webGPUVideoPlayer/custom/CustomDecodeSession.test.ts `
    src/plugins/webGPUVideoPlayer/custom/CustomPlaybackController.test.ts `
    src/plugins/webGPUVideoPlayer/custom/CustomPlaybackEligibility.test.ts `
    src/plugins/webGPUVideoPlayer/WebGPUPlayer.test.ts

npm run build:check
```
