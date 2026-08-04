# WebGPU TrueHD/MLP Decode Route

## Status

The custom player has an exact-probe-gated TrueHD/MLP software decode route
for Matroska VOD sources. Mediabunny owns container parsing, HTTP range input,
track selection, packet extraction, timestamps, and seek positioning. A focused
pinned FFmpeg `libavcodec` WebAssembly module owns only TrueHD/MLP decode.

This is not `ffmpeg.wasm` and does not contain FFmpeg programs, demuxers,
muxers, protocols, encoders, filters, or unrelated decoders. The configured
build enables only the `mlp` and `truehd` decoders plus their required parser
and `libavutil` dependencies.

## Qualified envelope

| Dimension | Authorized values |
| --- | --- |
| Container | MKV/Matroska VOD through Mediabunny `A_TRUEHD` or `A_MLP` packets |
| Codecs | Dolby TrueHD and MLP |
| Authorized layouts | TrueHD stereo/5.1 and MLP stereo |
| Source-rate contract | Every safe integer from 3000 through 192000 Hz |
| Exact capability fixtures | TrueHD stereo/48 kHz, TrueHD 5.1/96 kHz, TrueHD 5.1/192 kHz, and MLP stereo/48 kHz |
| Qualified source depth | 24-bit lossless PCM reference |
| Internal decoder output | Owned planar `Float32Array` PCM with an exact WAVE channel layout |
| Player output | Native 5.1 only when the exact destination exposes six channels; otherwise stereo 48 kHz through the shared downmix, streaming resampler, and AudioWorklet clock |
| Seek | One-second packet preroll, major-sync recovery, then sample-exact discard before the requested signed-microsecond boundary |
| Capability floor | Exact PCM fingerprints, full fixture coverage, major-sync recovery, and at least 2x real-time throughput |

The adapter structurally accepts decoder-reported 16-, 20-, or 24-bit PCM and
2/6/8-channel exact WAVE masks. Capability, eligibility, and device-profile
claims remain narrower: TrueHD is stereo/5.1 and MLP is stereo. The four exact
fixtures prove those decoder/layout families; they are not a source-rate
whitelist. Supported pairs use the shared bounded integer source-rate contract,
and the decoder must report the same rate and shape as the selected track.

## Atmos semantics

FFmpeg can identify a TrueHD Atmos profile, but the current output is only the
lossless channel bed. The route reports all of the following explicitly:

- `channelBedOnly: true`
- `objectAudioRendered: false`
- `passthrough: false`

The player must not label this PCM output as Atmos rendering. Web Audio does
not preserve TrueHD object metadata or compressed passthrough. Either feature
requires a separate browser/platform output design and its own exact sink,
clock, lifecycle, user-consent, and legal qualification.

## Ownership and data flow

```text
Jellyfin MKV range source
  -> Mediabunny Input / InputAudioTrack / EncodedPacketSink
  -> one owned TrueHDSoftwareAudioDecoder
  -> owned planar Float32 PCM
  -> complete 5.1 bed or exact WAVE-layout stereo downmix
  -> streaming 48 kHz resampler
  -> bounded worker credits
  -> owned AudioWorklet output and player clock
```

The decoder copies packet bytes into bounded WebAssembly memory and copies
decoded PCM into JavaScript-owned arrays before receiving another frame. The
worker creates one decoder for one selected track, closes it in `finally`, and
uses the existing iterator retirement and generation cancellation path. There
is no borrowed global player, HTML audio side channel, custom container parser,
or unbounded packet/PCM queue.

## Exact fixtures

`scripts/webgpu/generate_truehd_capability_fixtures.py` creates deterministic
sine-tone sources and embeds the first 32 complete access units plus native
FFmpeg PCM fingerprints in `TrueHDExactCapabilityFixtures.ts`:

- TrueHD stereo, 24-bit, 48 kHz
- TrueHD 5.1-side, 24-bit, 96 kHz
- TrueHD 5.1-side, 24-bit, 192 kHz
- MLP stereo, 24-bit, 48 kHz

The Matroska remux fixture separately proves Mediabunny returns `A_TRUEHD`, a
null native decoder configuration, correct 5.1/96 kHz metadata, complete access
units, timestamps, and positive durations to the focused decoder.

The recovery probe starts after the first major sync. Dependent access units
must produce no fatal error and decoding must resume at the next major sync.
Production seeks request one second of Mediabunny packet preroll and discard
decoded samples before the exact requested timestamp.

## Pinned build and licensing

- FFmpeg commit: `a59498db085e3d635532397128550141ab87408a`
- Source SHA-256:
  `fff68fd0b5061b1befba1cd9fc95357d9fc85eb3201bfed597c70d5f8033567e`
- Emscripten: `4.0.13`
- Configured license: LGPL version 2.1 or later
- GPL, version-3, nonfree, iconv, programs, protocols, demuxers, muxers,
  encoders, filters, threading, runtime CPU detection, and unrelated decoders
  are disabled

Ordinary builds copy the exact LGPL text, pinned FFmpeg source archive,
revision/runtime hash, GPL-2.0-or-later bridge source, repository GPL text, and
both focused/shared build scripts under `libraries/ffmpeg-truehd/`. The focused
runtime is lazy-loaded into the worker bundle only when the exact probe or a
selected TrueHD/MLP route needs it.

Build and verify:

```powershell
python scripts/webgpu/build_truehd_decoder.py --verify-reproducible
python scripts/webgpu/generate_truehd_capability_fixtures.py
node scripts/webgpu/verify-truehd-decoder-artifacts.mjs
npm test -- src/plugins/webGPUPlayer/custom/TrueHDSoftwareAudioDecoder.integration.test.ts
npm test -- src/plugins/webGPUPlayer/custom/TrueHDExactCapabilityRunner.integration.test.ts
npm test -- src/plugins/webGPUPlayer/custom/TrueHDMediabunnyDemuxIntegration.test.ts
```

## Remaining expansion procedures

### Seven/eight-channel TrueHD

FFmpeg's current open TrueHD encoder exposes at most 5.1, so it cannot generate
a clean synthetic 7.1 qualification source. Do not infer 7.1 support from the
decoder accepting eight channels. Obtain a license-clean redistributable 7.1
TrueHD source, record its provenance and hash, add exact native-reference PCM
and WAVE-mask checks, add maximum-envelope throughput and seek recovery, then
expand the authorized layout, capability evidence, input policy, eligibility,
and device profile together. Until that work passes, common 7.1 TrueHD/Atmos
tracks transcode or fall back rather than being falsely advertised.

### Blu-ray M2TS

Do not add TrueHD to TS/MTS/M2TS container tables merely because the decoder
works. First make Mediabunny surface complete Blu-ray TrueHD access units and
metadata, or integrate an equivalently bounded reviewed demux library. Validate
188/192/204-byte transport strides, PAT/PMT changes, PES fragmentation,
discontinuities, timestamp wrap, dependent substreams, multiple audio tracks,
random seek, malformed packets, cancellation, and bounded range reads. Reuse
the existing decoder/downmix/resampler path unchanged.

### Product validation

Before release, run licensed stereo/5.1 TrueHD and Atmos-bed titles through
start, pause/resume, representative seeks, seek storms, audio switching, EOF,
replay, repeated sessions, cancellation, A/V drift, queue bounds, worker
retirement, and mpv PCM/loudness A/B comparisons. Add a port-8096 Playback Info
assertion proving probe-qualified MKV sources select WebGPU Direct Play
without claiming Atmos objects or passthrough.
