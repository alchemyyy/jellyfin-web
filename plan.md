# Client-Side HDR Tone-Mapping Plan

## Goal

Add an experimental Jellyfin Web playback path that injects SMPTE ST 2094-50
Adaptive Global Tone Mapping (AGTM) metadata into fragmented MP4 HLS. Stock
Chrome then applies the supplied gain curve in its existing GPU tone-mapping
shader. This must not require a custom Chromium build or video re-encoding.

## Initial scope

- Chrome 151 or newer on Windows
- HDR10, HDR10+, and Dolby Vision sources with an HDR10 base layer played
  through hls.js
- Fragmented MP4 HLS only
- Recorded playback on one fixed HLS level
- Unencrypted, single-`moof`/single-`mdat` Jellyfin segments
- One AGTM metadata sample covering every video sample in a fragment
- Enabled by default and fail-open: unsupported or malformed input is returned
  unchanged

Pure Dolby Vision without an HDR10 base layer, HLG, MPEG-TS, encrypted
fragments, low-latency HLS parts,
multiple movie fragments per segment, live streams, adaptive level switching,
and live curve editing are excluded from the first proof of concept.

## Architecture

### Jellyfin Web

1. Add browser-local playback preferences:
   - Enable experimental client-side HDR tone mapping
   - Select a validated tone-mapping preset
   - Adjust source peak, SDR target peak, and knee offset for BT.2390 mode
   - Scale automatic CSS desaturation with an unclamped percentage
2. Force fMP4 HLS when the experiment is enabled.
3. Enable the transformer only for supported HDR range types.
4. Supply a custom hls.js fragment loader with progressive loading disabled.
5. Lock the hls.js instance to its initial level because Chrome cannot
   re-register the same timed metadata track on one `SourceBuffer`.

### hls.js boundary

Use the existing `fLoader` extension point rather than changing Chromium or
replacing the video decoder. The loader wraps hls.js's default loader and
transforms successful `ArrayBuffer` responses before hls.js parses them.

The initialization and media loaders are separate hls.js instances, so the
custom loader class owns shared transformation state in its class-factory
closure. Audio-only fragments are recognized by track ID and passed through.

### Initialization segment transformation

1. Parse top-level ISO BMFF boxes and locate `moov`.
2. Find the selected `vide` track ID and timescale.
3. Allocate a unique metadata track ID.
4. Add a metadata `trak` containing:
   - `tkhd`
   - `tref/rndr` referencing the video track
   - `mdia/mdhd`
   - `mdia/hdlr` with handler type `meta`
   - `minf/stbl/stsd/it35`
   - Empty `stts`, `stsc`, `stsz`, and `stco`
5. Store the five-byte AGTM T.35 identifier in the `it35` sample entry:
   `B5 00 90 00 01`.
6. Add a matching `mvex/trex` entry and update `mvhd.next_track_ID`.

The timed metadata sample itself contains raw ST 2094-50 Annex C bytes and does
not repeat the T.35 identifier.

### Media fragment transformation

1. Locate the video `traf` and parse `tfhd`, `tfdt`, and `trun`.
2. Calculate the complete video presentation interval, including composition
   offsets used by reordered frames.
3. Add a metadata `traf` with one sample spanning that interval.
4. Grow the existing `moof` and adjust all explicit movie-fragment-relative
   `trun.data_offset` values.
5. Append the AGTM sample to `mdat` and update its size.

The first implementation rejects uncommon base-offset and auxiliary-encryption
layouts instead of guessing.

### AGTM presets

The control preset uses Chrome's reference-white tone-mapping operator for a
203-nit reference white and 1000-nit source peak.

The custom presets use an eight-point Rec.2020/maxRGB gain curve and vary the
SDR paper-white fraction:

| Preset | Paper-white fraction | Approximate 203-nit output |
| --- | ---: | ---: |
| Control | 0.50 | 102 nits |
| Mild | 0.65 | 132 nits |
| Balanced | 0.75 | 152 nits |
| Bright | 0.85 | 173 nits |

`BT.2390` is the default. Preset changes apply to the next
playback during the proof-of-concept phase.

The adjustable `BT.2390` preset samples the PQ-domain EETF from ITU-R
BT.2390-7 into a 16-point ST 2094-50 gain curve. Its default knee offset is
`1.0`, matching current mpv/libplacebo behavior; `0.5` selects the report's
original knee. The browser-local controls are:

| Parameter | Default | Format constraint |
| --- | ---: | ---: |
| HDR source peak | 1000 nits | Above target, at most 10000 nits, and at most 6 stops above target |
| SDR target peak / AGTM reference white | 203 nits | 0.2-10000 nits and below source peak |
| Knee offset | 1.0 | Non-negative finite value |

Jellyfin's `PlaybackInfo` response does not expose MaxCLL or mastering-display
peak luminance, so the source peak is manual. The BT.2390 black-point lift is
omitted because it requires positive gain near black, which is invalid for an
ST 2094-50 alternate image below the baseline headroom.

### CSS post-processing

When an AGTM loader is active, the video element receives a global CSS
`saturate()` filter. Its automatic value is derived from the active curve's
peak compression, with a browser-local strength control that updates every
250 ms without restarting playback. The control preset and a strength of zero
leave chroma unchanged. CSS filtering cannot reproduce luminance-selective
gamut mapping, so the adjustment applies uniformly to the frame.

## Milestones

### 1. Binary core

- Implement bounds-checked BMFF box parsing and writing.
- Implement AGTM reference-white and explicit gain-curve serialization.
- Implement initialization-segment injection.
- Implement media-fragment injection.
- Add deterministic byte-level unit tests and malformed-input tests.

### 2. Jellyfin integration

- Add strict HDR source classification.
- Add local settings and playback-preferences UI.
- Force fMP4 and install the custom loader only when all gates pass.
- Keep default playback byte-for-byte unchanged when disabled.

### 3. Verification

- Run type checking, linting, and unit tests.
- Build the production Jellyfin bundle.
- Verify generated files with `ffprobe`.
- Confirm Chrome detects the metadata track.
- Compare control, balanced, and disabled playback using fixed frames.
- Check seeking, quality changes, replay, and teardown.

## Validation gates

The experiment is not considered operational until all of these pass:

1. Generated initialization data contains one `meta`/`it35` track referencing
   the intended video track.
2. Every transformed fragment contains a correctly timed metadata sample.
3. hls.js still computes the original audio/video timing.
4. Chrome reports AGTM metadata on decoded frames or demonstrates a repeatable
   visual difference between control and balanced payloads.
5. Disabled playback produces no transformed bytes.

## Verified outcome

- Chrome 151.0.7922.72 on Windows visibly applied an intentionally extreme
  1000-nit reference-white payload during 4K HEVC Main10 HDR10 playback.
- The same complete `meta`/`it35` initialization track and timed fragment
  samples produced no visual change on Chrome 150 because that release dropped
  HDR side data at the renderer-to-GPU Mojo boundary.
- The live production configuration uses normal presets rather than the
  extreme diagnostic payload.
- The adjustable BT.2390 path was deployed and verified with a 3629-nit source
  peak, 203-nit target peak, and 1.0 knee offset. Chrome played the transformed
  3840x2160 HEVC Main10 HDR10 fMP4 stream without dropped frames, media errors,
  or console warnings.
- A Dolby Vision Profile 7.6 `DOVIWithEL` title was verified through its
  1000-nit HDR10 base layer at 00:05:25. The prior build excluded this range and
  never installed the metadata loader. With support enabled, the default
  BT.2390 curve increased the sampled SDR frame mean from 4.62 to 6.97 and its
  maximum from 75 to 104; the 100-nit/2.0 stress curve increased them to 9.64
  and 123. FFmpeg copied the HEVC stream instead of tone mapping it.
- The default BT.2390 curve derives a CSS saturation of 0.819 for a 1000-nit
  source and 203-nit target. Switching its strength between 0 and 100 changed
  the active video between no filter and `saturate(0.819)` within 250 ms. A
  five-second 4K playback sample reported 123 presented frames with no dropped
  or corrupted frames.
- The complete suite passes 219 tests, TypeScript checking passes, focused
  linting reports no errors, and the production bundle builds without errors.
- The live browser is set to BT.2390 with a 1000-nit source peak, 203-nit target
  peak, and 1.0 knee offset for the Dolby Vision/HDR10 test title.

## Known risks

- Chrome 150 parses the timed metadata track but drops its HDR metadata while
  transferring decoded buffers to the out-of-process hardware decoder. Chrome
  151 contains Chromium's `DecoderBufferSideData` serialization fix and is the
  minimum supported version.
- Current Chrome 151 stable builds enable both AGTM and timed MP4 metadata by
  default. No command-line feature flags or custom browser build are required.
- Chrome currently retains timed metadata track bookkeeping across some parser
  resets. Re-appending an initialization segment with the same metadata track
  can fail. The proof of concept must explicitly test seeks, discontinuities,
  and quality switches before being enabled by default.
- Incorrect BMFF offsets cause immediate Media Source append failures.
- A malformed or invalid gain curve can silently fall back to Chrome's normal
  tone mapper.
- Timed ST 2094-50 support is new and must be runtime-tested against the
  installed Chrome build.
- CSS desaturation is global rather than highlight-selective and may prevent
  Chrome from promoting the video to a hardware overlay on some systems.
- The sibling `hls.js` checkout is not consumed automatically by Jellyfin Web;
  Jellyfin currently imports the registry package from `node_modules`.

## Rollback

Turning the feature off removes the custom fragment loader and restores the
existing hls.js path without changing server profiles or media files.
