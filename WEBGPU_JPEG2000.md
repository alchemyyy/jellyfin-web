# WebGPU JPEG 2000 Route

Status: implemented, exact-runtime-gated initial route

Backend: pinned OpenJPEG WASM through `@cornerstonejs/codec-openjpeg` 1.3.0

Demux: Mediabunny encoded packets

Presentation: owned RGBA `VideoFrame` through the existing WebGPU presenter

## Supported envelope

| Property | Current claim |
| --- | --- |
| Jellyfin codec names | `JPEG2000`, `JPEG 2000`, `J2K` |
| Container | `MJ2` or QuickTime `MOV` |
| ISO BMFF sample entry | Exact internal Mediabunny codec ID `mjp2` |
| Image | Progressive, unsigned 8-bit sRGB or grayscale |
| Maximum coded size | 960x540 |
| Maximum source rate | 24 fps |
| Runtime gate | Exact 960x540 output fingerprint and at least 30 measured decode/output fps |
| Decoder backend | `openjpeg`, software only |
| Output | Full-range RGBA `VideoFrame`, sRGB/BT.709 color declaration |
| Seeking | Mediabunny packet at or immediately before the requested timestamp |
| HDR | Not supported |
| Interlace and rotation | Not supported |

The route is not authorized from codec-name or configuration support alone. It
is advertised only after the pinned decoder reproduces the exact qualification
frame and sustains 1.25x throughput headroom for 24 fps playback. Source bitrate
is not inspected and is not a route constraint.

## Architecture

1. `CustomDecodeCapabilities` runs `JPEG2000ExactCapabilityProbe` once.
2. The probe worker loads the pinned OpenJPEG glue and WASM, decodes nine copies
   of the qualification image, closes each generated `VideoFrame`, verifies the
   exact RGBA byte length and FNV-1a fingerprint, and measures steady-state
   throughput after one warm-up frame.
3. The Jellyfin device profile advertises only `jpeg2000` in `mov,mj2`, with
   exact 8-bit, SDR, progressive, 960x540, and 24 fps conditions.
4. Eligibility chooses the `openjpeg` backend only for matching metadata and a
   supported exact capability result.
5. Mediabunny demuxes `mjp2` samples and supplies bounded `EncodedPacket`
   instances with timestamps and durations. It is not treated as the decoder.
6. `JPEG2000SoftwareVideoDecoder` owns one OpenJPEG decoder. It rejects changed
   geometry, non-zero image origins, signed samples, high bit depth, unsupported
   component counts, ambiguous color spaces, metadata-only samples, and packets
   above 64 MiB.
7. Every decoded frame enters the existing generation-safe credit and transfer
   path. Stop, source replacement, stale-generation rejection, and failed post
   paths close the owned `VideoFrame` through the existing worker contract.

No JPEG 2000 algorithm was reimplemented. Mediabunny is used for the container
and packet layer; the mature OpenJPEG library is used for decoding.

## Pinned artifacts and licensing

- npm package: `@cornerstonejs/codec-openjpeg` 1.3.0
- Package integrity:
  `sha512-hP8WAZ63AcaDYmHbBVTY04x424AglXsRHrI6VBdW4eTiJ76f0heWrEodT9Sb3sNwazzYuyMOIZNndJPeVSeHcw==`
- Wrapper repository revision:
  `717e892a2c5fec302bc8371140a66c7f648606ff`
- OpenJPEG revision:
  `2d606701e8b7aa83f657d113c3367508e99bd12b`
- Wrapper license: MIT
- OpenJPEG license: BSD-2-Clause

`scripts/webgpu/verify-custom-codec-artifacts.mjs` verifies that all served
decoder, license, revision, and qualification files are byte-identical to the
pinned sources. `scripts/webgpu/openjpeg/REVISION` records reviewed hashes.

## Qualification fixture

Source:
`scripts/webgpu/jpeg2000-capability-fixtures/srgb-960x540.jp2`

- SHA-256:
  `3d23398ce6857e4e7bc1851c4068d46aa1be1fd1506d7b8b3971e535e18acc94`
- Decoded dimensions: 960x540
- Decoded byte length: 2,073,600 RGBA bytes
- Decoded FNV-1a fingerprint: 1,076,220,778
- Generator: `scripts/webgpu/generate_jpeg2000_capability_fixture.py`

The checked-in fixture is copied with a `.bin` suffix so Jellyfin's static file
provider serves it as an ordinary binary asset.

## Validation commands

```powershell
npm test -- --run src/plugins/webGPUPlayer/custom/JPEG2000SoftwareVideoDecoder.test.ts src/plugins/webGPUPlayer/custom/JPEG2000ExactCapabilityProbe.test.ts src/plugins/webGPUPlayer/custom/CustomDecodeCapabilities.test.ts src/plugins/webGPUPlayer/custom/CustomPlaybackEligibility.test.ts src/plugins/webGPUPlayer/custom/CustomDeviceProfile.test.ts src/plugins/webGPUPlayer/custom/DecodeWorkerProtocol.test.ts
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
python scripts/webgpu/generate_jpeg2000_capability_fixture.py
npm run build:check
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs
```

Manual validation must use a 960x540 or smaller, progressive 8-bit sRGB/gray
MJ2 file at no more than 24 fps. Confirm DirectPlay, `openjpeg` telemetry,
normal start, pause/resume, deterministic seek, EOF, stop, next-item reuse, no
unclosed-frame warnings, and bounded worker/memory counts. Compare exact frames
against OpenJPEG, FFmpeg, and mpv references.

## Unsupported JPEG 2000 work

### High bit depth and HDR

1. Add deterministic 10-, 12-, and 16-bit codestreams for every claimed color
   space and component layout.
2. Extend the common raw-frame protocol with a format that preserves the
   decoded integer samples. Do not truncate them through 8-bit RGBA.
3. Define explicit color metadata and XYZ-to-display conversion where required.
4. Add exact decoder fingerprints and GPU readback references.
5. Add independent geometry/frame-rate tiers with 1.25x throughput headroom.
6. Advertise each tier only after the full decode-to-presentation path passes.

### DCI 2K/4K and archive resolutions

1. Add realistic complex 2K and 4K fixtures rather than flat test patterns.
2. Measure decode, allocation, copy, upload, and presentation separately.
3. Add bounded decoder-worker parallelism if one decoder cannot sustain the
   target rate. Preserve strict timestamp ordering and credit limits.
4. Add memory ceilings and repeated-session soak evidence before widening the
   device profile.

### Additional containers

1. Confirm Mediabunny exposes exact packets, sample-entry identity, timestamps,
   and seeking for the container.
2. Add the container to the shared container contract. Do not parse it inside
   the decoder adapter.
3. Add positive and nearby-negative codec/container tests.
4. MXF requires a separate demux implementation or reviewed library and is not
   authorized by the current MJ2 evidence.

### JPEG 2000 variants

JPX extensions, HTJ2K, alpha, non-zero origins/crops, signed components,
subsampled component layouts, and ambiguous/unknown OpenJPEG color spaces remain
unsupported. Each requires a deterministic fixture, an explicit output
contract, an exact reference fingerprint, and measured runtime qualification.

Motion JPEG is a separate codec and remains unsupported.
