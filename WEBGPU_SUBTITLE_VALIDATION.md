# WebGPU Subtitle Validation

Status: validation contract and support audit  
Scope: WebGPU wrapper and custom-decode playback using Jellyfin's owned HTML
subtitle surface

## Current conclusion

No subtitle format is release-qualified for custom decode yet. The relevant
rendering and delegation paths exist, but current browser evidence does not
cover DirectPlay negotiation, visible output, custom-clock behavior, track
switching, offsets, specialized renderer cleanup, fallback, or HTML-player
parity.

The machine-readable route plan is the
[subtitle validation plan](scripts/webgpu/validation/subtitle-validation-plan.json).
Private or distributable fixture records use the
[subtitle live specification schema](scripts/webgpu/validation/subtitle-live-spec-schema.json).
These records are inputs for the existing validation manifest, live-overlay
generator, browser-smoke adapter, and report formats. Do not create a separate
subtitle runner.

## Architecture boundary

The WebGPU player does not decode or composite subtitles in its video shader.
It owns an `HtmlVideoPlayer` and deliberately preserves Jellyfin's existing DOM
and specialized subtitle renderers above the WebGPU video canvas.

The audit found the following implemented contracts:

- The WebGPU device profile preserves server Encode entries but rebuilds its
  External entries from the custom runtime's actual surfaces. VTT is retained
  from the HTML text capability; ASS/SSA and PGS require Worker, WebAssembly,
  and Canvas 2D. Unsupported External entries are removed and duplicates are
  collapsed.
- ASS/SSA and PGS qualification is independent of the HTML player's historical
  PGS experiment setting. Retry negotiation does not widen these specialized
  routes. Burn-in policy may still select an Encode profile instead.
- The owned backend is constructed with forced DOM text subtitles. This avoids
  relying on a source-less `HTMLVideoElement` text-track clock during custom
  decode.
- Custom playback forwards media time to DOM text selection and owned ASS/SSA
  and PGS canvases. Focused tests cover ASS pause/seek/offset/resize/cleanup and
  PGS timing/offset/aspect/switch/cleanup. This establishes the source-less
  custom-clock contract, but not visible browser or real-server qualification.
- Subtitle selection, secondary selection, and offset methods are delegated to
  the owned backend. Unit tests cover delegation, custom-clock text updates,
  stale text fetch rejection after a newer selection, and stale fetch rejection
  after retained-player stop.
- ASS/SSA use `@jellyfin/libass-wasm`; PGS SUP uses `libpgs`. Other text formats
  depend on Jellyfin server conversion to external VTT.

Those facts establish candidate paths, not user-visible support claims.

## Format support matrix

`Code present` means a route exists but still needs every required live
exercise. `Conversion candidate` means Jellyfin can classify the source as text
and may convert it to VTT; every listed source format still requires its own
fixture and negotiation proof. `Unsupported custom` means the WebGPU custom
pipeline has no client renderer and must use an explicitly observed server or
HTML fallback.

| Source format | Expected delivery | Client surface | Primary | Secondary | Current status |
| --- | --- | --- | --- | --- | --- |
| WebVTT (`vtt`, `webvtt`) | External VTT, directly or normalized to `vtt` | Forced DOM text layer | Candidate | Candidate | Code present, unqualified |
| ASS | External ASS without text conversion | libass canvas with attached/fallback fonts | Candidate | Not supported by current secondary policy | Code present, unqualified |
| SSA | External SSA without text conversion | libass canvas with attached/fallback fonts | Candidate | Not supported by current secondary policy | Code present, unqualified |
| Blu-ray PGS (`pgssub`, `.sup`) | Extracted/external PGS when the specialized runtime and burn-in policy permit it | Owned libpgs canvas | Candidate | Unresolved; do not claim | Code present and unit-covered, live custom-clock path unqualified |
| SRT/SubRip | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| TTML | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| SAMI/SMI | Server parsing or FFmpeg conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| MicroDVD | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| SubViewer | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| MPL2 | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| MP4 `mov_text` | Server conversion to external VTT | Forced DOM text layer | Candidate | Candidate | Conversion candidate, unqualified |
| DVD/VobSub (`dvdsub`, `dvd_subtitle`, IDX/SUB) | Server burn-in/transcode or HTML fallback only | None in custom player | No | No | Unsupported custom bitmap format |
| DVB bitmap subtitles (`dvbsub`, `dvb_subtitle`) | Server burn-in/transcode or HTML fallback only | None in custom player | No | No | Unsupported custom bitmap format |
| DivX XSUB | Server burn-in/transcode or HTML fallback only | None in custom player | No | No | Unsupported custom bitmap format |
| CEA/EIA-608, CEA/EIA-708 | Native HTML/server handling only when actually exposed | None in custom demux/decode | No | No | Unsupported custom caption format |
| Teletext subtitles | Server or HTML fallback only | None in custom player | No | No | Unsupported custom caption format |

Formats absent from this table are unsupported until a source fixture proves
its server classification, delivery method, renderer, timing, cleanup, and
fallback. A permissive server parser or codec-family label is not support
evidence.

## Fixture contract

Each source record must be portable and content-addressed. Keep item IDs,
account values, URLs, filesystem paths, and license documents in environment
variables. Checked records contain only hashes, byte lengths, provenance,
license expressions, expected routes, and timing assertions.

Every candidate route needs both an embedded and external source where the
format can occur in both forms. A minimum deterministic fixture contains:

1. A 12-second or longer video with visible frame/time markers, a fixed frame
   rate, a known display aspect ratio, and three audio synchronization pulses.
2. Primary track A and primary track B with disjoint sentinel content so a
   stale track is immediately detectable.
3. At least three cues: a simple cue, a multiline/styled/positioned cue, and a
   boundary or overlap cue. Include LTR, RTL, and non-ASCII text in at least one
   text fixture, but store only the normalized expected text SHA-256 in private
   reports.
4. A secondary VTT or server-converted text track with vertically separated
   cues. ASS/SSA secondary output is explicitly out of scope because the current
   playback policy rejects it.
5. ASS/SSA fixtures with one attached font, explicit alignment, outline/color,
   and a bounded animation. Also include missing-font fallback as a separate
   case.
6. PGS SUP fixtures with transparent, palette, forced, cropped, and full-width
   display sets at known normalized bounds. Include consecutive clear/display
   segments and one cue spanning a seek target.
7. Fixed offset probes at -1,500,000, 0, and +1,500,000 microseconds. Seconds or
   floating-point timestamps must not be retained in new fixture messages.
8. Exact media/sidecar byte lengths, SHA-256 values, generator commands or
   source revisions, and license evidence.

The live schema requires cue start/end and before/active/after probes in signed
integer microseconds. Text cues use a normalized-text hash; bitmap or styled
visual cues use an image hash and normalized expected bounds. Browser-specific
goldens may be added after review, but cross-browser font rasterization must not
be treated as bit-exact by default.

## Reusable execution procedure

### 1. Register and preflight

1. Validate the source record against `subtitle-live-spec-schema.json`.
2. Resolve private environment inputs in memory and verify every byte length,
   hash, provenance record, and license record before launching a browser.
3. Import the source through the normal Jellyfin library. Confirm the server's
   media stream records expose the exact codec, stream index, external/embedded
   state, and selected track expected by the fixture.
4. Generate cases into the existing private overlay. Each case must use the
   shared browser-smoke adapter and sanitized server-log capture.

### 2. Run matched HTML and custom sessions

Run each case twice in the same browser, viewport, device-pixel ratio, subtitle
settings, audio selection, source, and server session:

- `html`: ordinary HTML player with WebGPU/custom decode disabled.
- `custom`: WebGPU player with custom decode and the validation harness enabled.

Do not compare runs from different browser versions or display settings. Record
the browser, GPU/driver, display state, server version, feature flags, subtitle
settings, and exact fixture hash in the shared environment header.

### 3. Prove negotiation before rendering

For candidate external routes, require all of the following:

- client and server select `DirectPlay`;
- the selected subtitle stream index matches the fixture;
- delivery method is `External`;
- delivered format is exactly VTT, ASS, SSA, or PGS as declared by the route;
- the selected source has no transcoding URL or active `TranscodingInfo`;
- server evidence contains one matched start/stop pair, no subtitle transcode
  reason, and no created or changed FFmpeg transcode log.

For fallback-only formats, record the exact player, play method, delivery
method, and reason. A server transcode is acceptable only when the case expects
burn-in. A fallback must occur once without a play/retry loop. Never relabel a
fallback as client-side subtitle support.

### 4. Prove visible output

At each cue's before, active, and after media times:

- capture the sanitized DOM state, renderer/canvas counts, visibility, bounds,
  and a cropped screenshot of the subtitle region;
- for DOM text, hash normalized rendered text and assert the old track's hash is
  absent;
- for ASS/SSA, assert a nonempty libass canvas, attached-font load result,
  expected style/bounds, and a reviewed image comparison;
- for PGS, assert a nonempty libpgs canvas, display-set image/bounds, clear
  segments, aspect placement, and absence of stale bitmaps;
- assert subtitle layers are above the video canvas and below the OSD, receive
  no pointer input, and remain inside fullscreen and safe-area bounds.

Screenshot thresholds must be reviewed per browser/GPU family. Use exact hashes
for generated source assets and semantic/bounded comparisons for rasterized
browser output.

### 5. Prove timing, pause, seek, and offsets

Use media time, never wall-clock sampling alone:

1. Observe each cue onset and clear edge during continuous playback.
2. Pause inside a cue for at least two wall-clock seconds. Static output must be
   unchanged; ASS animation must remain at the paused media time.
3. Seek to before, inside, and after a cue, then run a three-target seek storm.
   No pre-seek text or bitmap may survive the first settled post-seek frame.
4. Apply -1.5 s, 0 s, and +1.5 s offsets while a track is selected, after seek,
   and after switching tracks. Assert sign, nonaccumulation, and reset behavior.
5. Repeat the same probes with a primary plus eligible secondary text track.

Initial timing review should flag an edge error greater than one source frame
plus 20 ms, or an HTML/custom edge delta greater than one source frame. These
are provisional review thresholds, not approved release baselines.

### 6. Prove switching and generation cleanup

Exercise A -> B -> off -> A for primary tracks and the corresponding eligible
secondary sequence. Delay track A's fetch, select B, then complete A. Repeat the
race across seek, `stop(false)`, `stop(true)`, destroy, next item, natural EOF,
and same-player replay.

Passing evidence requires:

- no stale DOM text, native cue, ASS canvas, PGS bitmap, font response, or worker
  response from an old selection or playback generation;
- exactly one active primary surface and at most one eligible secondary surface;
- specialized renderers disposed once, pending fetch accounting returned to
  zero, and no retained subtitle worker after stop/destroy;
- no duplicate playback, stopped, timeupdate, or subtitle-selection events;
- bounded DOM nodes, canvases, workers, listeners, and heap across 30 sessions.

The existing text-fetch generation unit tests are prerequisites, not substitutes
for this browser exercise.

### 7. Prove fallback and recovery

Inject one fault at a time: subtitle fetch failure, malformed subtitle, libass or
libpgs worker load failure, renderer initialization failure, unsupported format,
and WebGPU presentation failure while a subtitle is visible.

Each result must identify one of these outcomes without ambiguity:

- subtitle deselected while video/audio continue;
- one transition to ordinary HTML playback;
- one server burn-in/transcode transition with the expected reason;
- explicit terminal playback error matching ordinary HTML-player behavior.

Reject retry loops, duplicate server sessions, silent subtitle disappearance,
stale overlay output, or a format support claim after fallback.

### 8. Prove native HTML parity

Compare HTML and custom runs on:

- selected stream, delivery method, delivered format, and server play method;
- cue text/image identity, onset/clear media times, pause frame, seek result, and
  offset sign;
- primary/secondary ordering, style, normalized bounds, safe-area placement,
  fullscreen, resize, device-pixel-ratio, and 16:9 versus 2.39:1 content;
- track switch and deselection latency;
- end, stop, replay, next-item, and failure outcome;
- console errors, server errors, transcode activity, and retained resources.

HTML may use native text tracks while the owned WebGPU backend uses forced DOM
text. Compare semantics and reviewed appearance, not implementation-specific DOM
node equality.

## Encompassing matrix

Do not multiply every axis blindly. Run every format route through its mandatory
primary lifecycle, then use pairwise coverage for secondary environmental axes.

| Axis | Required values |
| --- | --- |
| Format route | VTT, ASS, SSA, PGS SUP, each listed text-to-VTT format, each unsupported bitmap/caption family |
| Source kind | Embedded and external where applicable |
| Player mode | HTML baseline and custom decode |
| Browser | Chrome and Edge; add Firefox/Safari only if WebGPU custom decode is later enabled there |
| Track role | Primary, off, eligible secondary; ASS/SSA primary only; PGS secondary unresolved |
| Playback state | Start, playing, paused, seek, seek storm, EOF, stop(false), stop(true), replay, next item |
| Offset | -1.5 s, 0 s, +1.5 s |
| Presentation | SDR 16:9, HDR 16:9, 2.39:1 letterbox/crop, fullscreen, resize/DPR |
| Settings | Default/custom appearance, specialized renderer runtime present/absent, each burn-in policy affecting the route |
| Fault | Fetch, malformed input, worker, renderer, unsupported format, WebGPU presentation |
| Retention | Five-session reuse and 30-session soak |

Mandatory non-pairwise gates:

1. VTT, ASS, SSA, and PGS each pass all nine exercise IDs on primary output.
2. Every text-to-VTT source format independently proves server conversion and
   visible timing; one SRT result cannot authorize the group.
3. VTT plus every converted text route proves eligible secondary output at
   least once; ASS/SSA remain primary-only.
4. PGS proves runtime-qualified external DirectPlay and unavailable-runtime or
   burn-in fallback. Secondary PGS remains unclaimed until a dedicated
   two-renderer case passes.
5. Every unsupported family proves the expected fallback without a custom
   renderer or DirectPlay support claim.
6. Every candidate route passes HTML parity in Chrome and Edge on at least one
   physical GPU. Hardware vendors unavailable to a host remain explicit
   `not-run` cells.
7. The complete route set passes generation races and the 30-session retention
   gate without stale output, worker leaks, or unbounded growth.

## Browser-smoke adapter status

The existing browser-smoke controller now accepts `--subtitle-live-spec` or
`WEBGPU_SMOKE_SUBTITLE_LIVE_SPEC`; there is no second runner. The integrated
custom-session adapter implements:

- private media/license/sidecar preflight and streamed SHA-256 evidence;
- sanitized primary/secondary stream, codec, source-kind, delivery, and format
  evidence;
- bounded DOM/native-track/specialized-canvas/libass-worker/libpgs-worker counts;
- integer-microsecond before/active/after probes, normalized text and RGBA
  hashes, and in-memory cropped screenshot hashes;
- pause for at least two seconds, cue-directed seeks and seek storm, fixed
  offsets, primary switch, deselection, eligible secondary selection, and a
  delayed-fetch generation race;
- exact restoration of initial selection, offset, and playing state, followed
  by post-stop surface and worker cleanup assertions;
- recursive sanitization of every configured path, account value, item ID,
  URL, and private input value.

See [the adapter contract](scripts/webgpu/SUBTITLE_SMOKE_ADAPTER.md). Its 58
Node tests and the shared 19-test Python validation suite pass. The remaining
framework work is explicit: join paired HTML/custom two-context results, approve
browser/GPU visual tolerances and a private content-addressed artifact store,
wire subtitle fault injection to checked case IDs, join the 30-session retention
mode, and add expected private-input byte lengths/hashes to the overlay schema.

Until those items and the live matrix pass, Playback Info may show the WebGPU
player, but it is not evidence that the selected subtitle route is correct.
