# WebGPU Legacy Video Decode

## Current product route

The player can directly decode progressive MPEG-2 Video Main Profile carried in
Matroska. Mediabunny owns authenticated input, range reads, demuxing, packet
timestamps, keyframe lookup, and packet ownership. A focused FFmpeg
`libavcodec`/`libavutil` WebAssembly module owns only compressed video decode.
Decoded progressive I420 frames become owned Mediabunny `VideoSample` objects,
then transferable `VideoFrame` objects for the existing WebGPU presentation
path.

The Jellyfin device profile advertises this route only after the browser
qualification worker:

1. Demuxes the checked-in Matroska fixture with Mediabunny.
2. Decodes all 12 frames, including B-frame reordering.
3. Verifies 1920x1080 I420 output and 37,324,800 aggregate decoded bytes.
4. Verifies aggregate FNV-1a fingerprint `544635241`.
5. Measures at least 30 decode/output frames per second.

The advertised route is bounded to 1920x1080, 24 fps, 8-bit SDR, progressive
Main Profile Matroska. Source bitrate is not a capability or selection input.

## Fail-closed exclusions

- Interlaced MPEG-2 is detected from `AVFrame` metadata and rejected. No weave
  or heuristic deinterlacing is permitted.
- MPEG-TS, M2TS, and MTS are not advertised because Mediabunny 1.52.2 does not
  expose MPEG-2 `stream_type 0x02` as a video track.
- MPEG-PS and VOB remain unsupported because there is no qualified demux path.
- MOV and MP4 are not advertised for MPEG-2.
- VC-1 and WMV3 are not implemented or present in the focused decoder artifact.
- The focused artifact contains only the MPEG-2 Video decoder.
- Dimensions, frame rates, bit depths, profiles, or containers outside the
  exact route fail eligibility before starting the worker.

## Navigation

| Concern | File |
| --- | --- |
| Focused C decoder bridge | `scripts/webgpu/legacy-video-decoder/bridge.c` |
| Reproducible focused build | `scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py` |
| Pinned artifacts and hashes | `scripts/webgpu/legacy-video-decoder/artifacts/` |
| Decoder adapter and ownership | `src/plugins/webGPUPlayer/custom/LegacySoftwareVideoDecoder.ts` |
| Exact browser capability gate | `src/plugins/webGPUPlayer/custom/LegacyVideoExactCapabilityProbe.ts` |
| Full demux/decode worker probe | `src/plugins/webGPUPlayer/custom/LegacyVideoExactCapabilityProbe.worker.ts` |
| Runtime worker route | `src/plugins/webGPUPlayer/custom/CustomDecode.worker.ts` |
| Server negotiation | `src/plugins/webGPUPlayer/custom/CustomDeviceProfile.ts` |
| Client route validation | `src/plugins/webGPUPlayer/custom/CustomPlaybackEligibility.ts` |
| Artifact packaging and verification | `webpack.common.js`, `scripts/webgpu/verify-custom-codec-artifacts.mjs` |

## Verification

```powershell
python scripts/webgpu/generate_legacy_video_capability_fixture.py
python scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py --verify-reproducible
node scripts/webgpu/verify-legacy-video-decoder-artifacts.mjs
npm test -- src/plugins/webGPUPlayer/custom/LegacySoftwareVideoDecoder.test.ts
npm test -- src/plugins/webGPUPlayer/custom/LegacyVideoDecoderIntegration.test.ts
npm test -- src/plugins/webGPUPlayer/custom/LegacyVideoExactCapabilityProbe.test.ts
npm test -- src/plugins/webGPUPlayer/custom/CustomPlaybackEligibility.test.ts
npm test -- src/plugins/webGPUPlayer/custom/CustomDeviceProfile.test.ts
node --test scripts/webgpu/verify-custom-codec-artifacts.node-test.mjs
npm run build:check
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs
```
