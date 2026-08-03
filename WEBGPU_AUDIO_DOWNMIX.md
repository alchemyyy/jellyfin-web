# WebGPU 7.1 Downmix Qualification

Status: exact 48/96 kHz DTS 7.1 route qualified

## Scope

The shared custom-audio path accepts WAVE-order 7.1 PCM in this exact order:

```text
FL, FR, FC, LFE, BL, BR, SL, SR
```

The required WAVE channel mask is `0x63f`. LFE is omitted from stereo Lo/Ro.
The matrix is sample-local and stateless, so arbitrary encoded-packet and PCM
chunk boundaries produce sample-exactly identical output.

## Pinned reference

The reference generator pins both source behavior and the exact local tools
used for the external comparison:

| Component | Pin |
| --- | --- |
| mpv source | `1d1535ff9124fdeb3c81a2f089551e2cc8404613` |
| mpv executable SHA-256 | `002d5d348c7467c765f1b32682c6eb50c30a3eb4468b9d06caaca344e3de1839` |
| FFmpeg source | `862338fe3154e09ff0c410fd410d519588d47cf2` |
| FFmpeg executable SHA-256 | `cce4074b7af8e71b4c63f17bec8d36ca3da9b7f84f5bcbb010476164a6cafa85` |

At that mpv revision, `audio-normalize-downmix` defaults to `no`. mpv passes
`rematrix_maxval=1000` to FFmpeg `libswresample` for that mode and passes
`rematrix_maxval=1` when normalization is enabled. FFmpeg's 7.1 Lo/Ro matrix
uses direct front gain `1`, center/back/side gain `sqrt(1/2)`, and LFE gain
`0` before optional row normalization.

The generated 8-channel WAVE-extensible corpus contains isolated impulses,
correlated and decorrelated deterministic signals, positive and negative
full-scale correlation, and a large LFE-only sentinel. It is generated at both
48 and 96 kHz. No media is copied from a commercial source. mpv and FFmpeg
produced byte-identical float32 PCM for both policies and both sample rates.

## Policy decision

Keep the existing conservative normalization. It is not an approximation: it
matches mpv with `--audio-normalize-downmix=yes` and FFmpeg with
`rematrix_maxval=1`.

| Input | Selected gain | mpv default gain |
| --- | ---: | ---: |
| FL or FR | `0.3203772410170407` | `1.0` |
| FC, matching BL/BR, matching SL/SR | `0.2265409196609864` | `0.7071067811865476` |
| LFE | `0` | `0` |
| Maximum correlated row sum | `1.0` | `3.121320343559643` |

The selected matrix costs `9.8868 dB` versus mpv's default direct gain. That
loss is deliberate. Switching to mpv's default without a separately qualified
headroom or limiter policy would overload the current float output:

| Exact DTS qualification output | Selected peak / RMS dBFS / samples above 1 | mpv default peak / RMS dBFS / samples above 1 |
| --- | --- | --- |
| DTS-HD HRA 7.1, 48 kHz | `0.8051 / -10.4419 / 0` | `2.5130 / -0.5552 / 298 of 1024` |
| DTS-HD MA 7.1, 48 kHz | `0.8051 / -10.4254 / 0` | `2.5129 / -0.5386 / 298 of 1024` |
| DTS-HD MA 7.1, 96 kHz | `0.8014 / -10.4123 / 0` | `2.5013 / -0.5255 / 592 of 2048` |

The implementation does not apply per-chunk normalization, hard clipping,
makeup gain, or a hidden dynamics processor. Those would change sound across
packet boundaries or conceal overload. A future move toward mpv's default
loudness requires a separately measured limiter/headroom design, real program
material A/B evidence, and AudioWorklet clipping telemetry. It must not be made
by changing coefficients alone.

RMS dBFS and crest factor are recorded for deterministic regression. The short
synthetic corpus is not treated as a substitute for BS.1770 integrated
program-material loudness.

## Automated gates

```powershell
python scripts/webgpu/generate_seven_point_one_downmix_reference.py --check

python scripts/webgpu/generate_seven_point_one_downmix_reference.py `
    --check --verify-external `
    --mpv C:\mpv\mpv.exe `
    --ffmpeg C:\ffmpeg\ffmpeg.exe `
    --mpv-source ..\mpv `
    --ffmpeg-source ..\ffmpeg

node_modules\.bin\vite-node.cmd --script `
    scripts/webgpu/report_dts_downmix_reference.ts --check

npm test -- `
    src/plugins/webGPUVideoPlayer/custom/CustomAudioDownmix.test.ts `
    src/plugins/webGPUVideoPlayer/custom/SevenPointOneDownmixReference.test.ts `
    src/plugins/webGPUVideoPlayer/custom/DTSSoftwareAudioDecoder.integration.test.ts
```

The browser capability probe now verifies exact stereo float fingerprints for
the qualified 48 kHz HRA, 48 kHz MA, and 96 kHz MA outputs. The integration
test also proves identical 48 kHz output and identical 96-to-48 kHz resampler
output across arbitrary source chunk boundaries.
