# WebGPU DTS decode route

## Decision

Use Mediabunny for supported container parsing and packet timestamps, then pass
complete DTS access units to one owned `libdcadec` WebAssembly decoder inside
the existing custom decode worker. Decoded planar PCM uses the shared explicit
channel-layout, downmix, streaming-resampler, credit, AudioWorklet, and clock
path. No second audio clock or native HTML audio element is introduced.

Mediabunny 1.52.2 has neither a DTS decoder extension nor a DTS MPEG-TS track
implementation. The bounded codec-only `libdcadec` module is therefore the
smallest mature fallback. This is not `ffmpeg.wasm` and does not include a
general-purpose container, filter, encoder, or protocol stack.

## Qualified support

| Family | Decoder result | Exact fixture | Authorized layout |
| --- | --- | --- | --- |
| DTS Core | Core profile, 16/24-bit PCM | 5.1-side, 48 kHz | Supported |
| DTS 96/24 | 96/24 profile, 24-bit PCM | 5.1-side, 96 kHz | Supported |
| DTS-ES | ES profile, 24-bit PCM | 6.1, 48 kHz | Supported |
| DTS-HD High Resolution | HRA profile, 24-bit PCM | 7.1, 48 kHz | Supported |
| DTS-HD Master Audio | MA profile, lossless flag only after clean parse/filter | 7.1 at 48/96 kHz and 5.1 at 192 kHz | 5.1 or 7.1 subject to the rate rule below |
| DTS-HD MA + DTS:X | MA channel bed | Same MA envelope | Channel bed only |
| DTS:X objects | No browser object renderer or compressed passthrough | None | Not supported or claimed |

The seven fixtures prove decoder output, throughput, profile identification,
and the supported profile/layout pairs. They are not a source-rate whitelist.
The server-facing rule is:

- Any safe integer source rate from 3000 through 96000 Hz may use 5.1 Core,
  5.1 96/24, 6.1 ES, 7.1 HRA, or 5.1/7.1 MA.
- Rates from 96001 through 192000 Hz require a 5.1 MA bed.
- The MA pairs also accept the DTS:X label while decoding only the MA channel
  bed.

Channel masks must map to a known exact WAVE order; ambiguous masks fail closed.
Complete 5.1/7.1 beds may retain native multichannel output when the exact
playback destination exposes the full bed. Other supported beds and insufficient
destinations use bounded stereo 48 kHz through the shared downmix and resampler.
A stream that changes its channel count or rate after readiness terminates the
custom route.

## 7.1 stereo reference policy

The 7.1 WAVE-order matrix is qualified against pinned mpv and FFmpeg source,
exact local executable hashes, and a generated license-clean impulse/correlated
corpus at 48 and 96 kHz. The current conservative coefficients exactly match
mpv's opt-in `audio-normalize-downmix=yes` behavior, not mpv's default
unnormalized float matrix.

This policy remains intentional. mpv's default matrix produced peaks around
`2.5` and placed 298 of 1,024 stereo samples above unity for both exact 48 kHz
HRA/MA outputs, and 592 of 2,048 samples above unity for the 96 kHz MA output.
The normalized matrix produced no samples above unity. No per-chunk gain,
clipping, or makeup gain is hidden in the worker. See
`WEBGPU_AUDIO_DOWNMIX.md` for coefficients, RMS/crest evidence, source pins,
the policy tradeoff, and reproduction commands.

## Containers

| Container | Mapping | Status |
| --- | --- | --- |
| Matroska/MKV | Mediabunny unknown-codec track with internal ID `A_DTS`; `EncodedPacketSink` supplies access units and signed integer microsecond timestamps | Implemented and fixture-tested |
| MPEG-TS/M2TS/MTS | Mediabunny 1.52.2 ignores Blu-ray DTS PMT stream types `0x82`, `0x85`, and `0x86` | Blocked and deliberately not advertised |
| MP4/MOV | No qualified Mediabunny DTS sample-entry route in this slice | Not advertised |

Do not widen M2TS merely because libdcadec can decode DTS elementary streams.
The next implementation must first use an upstream Mediabunny route or another
bounded, reviewed demux library that exposes complete access units, PTS, seek,
and track metadata. It must cover Blu-ray DTS Core, HRA, and MA stream types,
private-stream descriptors where applicable, 192/204-byte packet strides,
PES boundaries, discontinuities, random seek, malformed PMTs/PES packets, and
multi-track selection. Only then add DTS to the MPEG-TS eligibility and device
profile rules.

## Runtime ownership

1. Capability probing creates a separate short-lived worker.
2. The worker decodes all seven embedded exact fixtures and verifies PCM plus
   exact 7.1 stereo fingerprints, profile mask, fixture count, and at least 2x
   real-time speed.
3. DTS remains `unknown` or `unsupported` when any exact check fails.
4. A playback run recognizes only Mediabunny `A_DTS` tracks and bypasses
   `AudioSampleSink`, native `AudioDecoder`, and decoder registration.
5. One `DTSSoftwareAudioDecoder` context is created for the run and closed in
   `finally`; every returned plane is copied into an owned `Float32Array`.
6. Generation cancellation retires the encoded-packet iterator through the
   existing worker lifecycle. A new run creates a new decoder context.
7. DTS:X is reported as decoded MA channel-bed PCM, never object rendering,
   Atmos-style rendering, or passthrough.

### Matroska timestamp quantization

Matroska commonly stores DTS packet timestamps on a 1 ms timecode grid, while
a 512-frame DTS unit at 48 kHz lasts 10,666.67 microseconds. A valid packet
sequence can therefore arrive as `0, 10000, 21000, 31000, 42000, 53000`
microseconds even though the decoded PCM is sample-contiguous.

The shared streaming resampler accepts at most one millisecond of container
timestamp quantization plus one source sample. Accepted input is canonicalized
to the decoded sample-count timeline; correction count and maximum deviation
remain bounded telemetry. A missing DTS unit is still roughly 10.67 ms away
from the expected timestamp and fails closed. This prevents quantization from
causing a false custom-decode fallback without concealing real packet loss.

## Bounds and fail-closed behavior

- Maximum encoded access unit: 2 MiB.
- Maximum decoded frame count per access unit: 16,384.
- WebAssembly initial memory: 32 MiB; maximum memory: 256 MiB.
- One decoder context per playback stream.
- Accepted sample depths: 16 and 24 bits.
- Accepted server routes use only the fixture-derived profile/layout pairs and
  the shared 3000-192000 Hz integer source-rate bound. Decoder-level acceptance
  does not add another profile or layout.
- The decoder rechecks actual output rate, profile, and channel count. Above
  96 kHz it requires 5.1 MA; server metadata cannot widen that envelope.
- The decoder can map exact stereo, 5.1-back, 5.1-side, 6.1, and 7.1 WAVE
  masks, but server negotiation authorizes only the profile/channel-count pairs
  listed above. Stereo is not a current DirectPlay claim.
- Decoder output is copied before the next parse can invalidate libdcadec
  memory.
- Unsupported profile, mask, depth, rate, packet size, output size, or changed
  stream shape fails the custom session instead of widening a server claim.

## Source, license, and relinking artifacts

`libdcadec` is pinned to commit
`b93deed1a231dd6dd7e39b9fe7d2abe05aa00158` and is
LGPL-2.1-or-later. Emscripten is pinned to 4.0.13. The distribution copies the
LGPL text, exact source archive, revision/hash manifest, GPL-2.0-or-later bridge
source, repository GPL text, and reproducible build script under
`libraries/libdcadec/`.

Rebuild and verify:

```text
python scripts/webgpu/build_dts_decoder.py --emcc <emscripten-4.0.13-emcc> --verify-reproducible
node scripts/webgpu/verify-dts-decoder-artifacts.mjs
python scripts/webgpu/generate_dts_capability_fixtures.py --check
```

The generated runtime module is `src/lib/libdcadec/libdcadec.mjs`. The build
rejects a compiler whose reported version is not the pin above and embeds
WebAssembly in that replaceable ES module so webpack does not depend on an
ambient `.wasm` URL. Compiler source paths are prefix-mapped. Release builds
compile in two isolated directories and reject a different module SHA-256.

## Validation inventory

- Decoder ABI bounds, output ownership, close idempotence, and failure cases.
- Runtime rejection of non-MA or 7.1 192 kHz decoder output.
- Exact Core, 96/24, ES, HRA, MA 48 kHz, MA 96 kHz, and 16-bit MA 192 kHz
  fingerprints.
- Sample-for-sample DTS-HD MA comparison against public-domain reference PCM.
- Exact WAVE channel-mask mapping and ambiguous-mask negatives.
- Exact 48/96 kHz 7.1 stereo fingerprints, bounds, objective metrics, and
  decode/resampler chunk-independence coverage.
- Capability worker protocol validation, timeout/error mapping, cache, and
  throughput gate.
- Matroska `A_DTS` track metadata, packet extraction, timestamp, and real WASM
  decode integration.
- Exact 512-frame/48 kHz Matroska cadence regression accepting 1 ms timestamp
  quantization while rejecting one missing DTS packet.
- Eligibility aliases/profiles, MKV-only claim, M2TS negatives, missing exact
  evidence, profile/layout negatives, 3000/192000 bounds, the 96000/96001
  transition, and bundled runtime requirements.
- Device-profile MKV-only direct-play advertisement with `ApplyConditions`
  refinements for fixture-derived profile/layout pairs and the high-rate MA
  restriction. Missing or mismatched profile metadata and out-of-range source
  rates fail closed before playback.

Remaining live validation requires licensed/user media without checking it into
the repository: seek start and seek storms for each profile, audio switching,
natural EOF, repeated sessions, cancellation during decode, long-run A/V drift,
underflow/queue telemetry, malformed access units, and mpv PCM/loudness A/B
capture. DTS:X sources must additionally confirm that UI and telemetry say
channel bed only.
