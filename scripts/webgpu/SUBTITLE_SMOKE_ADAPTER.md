# Subtitle browser-smoke adapter

The subtitle validation path is part of
`run-browser-playback-smoke.mjs`; it is not a second browser controller. Enable
it with `--subtitle-live-spec <path>` or
`WEBGPU_SMOKE_SUBTITLE_LIVE_SPEC`. The configured item ID must match exactly one
source through that source's `itemEnvironment`.

The adapter fails before browser playback when the private specification is
malformed, ambiguous, missing an environment-backed media/license/sidecar
file, or disagrees with `--expected-play-method`. It streams SHA-256 over each
private input and records only byte lengths, hashes, source/stream identifiers,
and the declared license expression. Paths, titles, item IDs, account values,
URLs, subtitle text, and screenshot bytes are never written to the report.

## Implemented custom-session exercise

For every cue declared on the first primary track, the existing browser-smoke
session now:

1. records the selected stream index, normalized codec, embedded/external kind,
   delivery method, and delivered format;
2. records bounded primary/secondary DOM, native track, specialized canvas,
   libass-worker, and libpgs-worker counts;
3. pauses the Jellyfin media clock and seeks to the cue's before, active, and
   after integer-microsecond probes;
4. hashes NFC-normalized rendered text after removing bidi control characters
   and collapsing whitespace, without returning the text;
5. hashes the bounded nontransparent RGBA region of specialized subtitle
   canvases, prefixed by little-endian uint32 width and height, without
   returning pixels;
6. hashes an in-memory PNG crop around the declared subtitle bounds, without
   persisting or returning its bytes;
7. checks the active hash, clear edges, normalized bounds, pointer pass-through,
   media time, and a pause held for at least two seconds;
8. exercises -1.5 s, 0 s, and +1.5 s offsets, A-to-B primary switching when a
   second primary exists, deselection, eligible secondary selection, and a
   three-target cue-directed seek storm;
9. delays the first reselected subtitle request through the existing CDP Fetch
   interceptor, selects B, releases A, and rejects a stale A hash;
10. restores the exact initial primary/secondary selection, offset, and playing
    state, then requires zero subtitle workers and surfaces after normal stop.

All expectations are explicit. Missing hashes, unrecognized delivered formats,
unavailable canvas pixels, missing screenshots, unknown resource counts, and
ambiguous selections fail rather than being counted as support.

## Current automation boundary

This slice does not yet claim the complete subtitle release matrix:

- The HTML/custom paired run still needs a dedicated two-context result join.
  Current evidence qualifies the integrated custom session only.
- Browser/GPU-specific reviewed image tolerances are not approved. The adapter
  records exact hashes; it does not infer cross-browser visual equivalence.
- Subtitle-specific malformed-input, worker-startup, renderer-startup, and
  WebGPU-presentation fault injection is not wired to checked case IDs yet.
- The 30-session subtitle-specific retention series still needs to be joined to
  the existing generic retention mode. This slice proves cleanup after its one
  controlled session.
- The current live specification supplies environment-backed files but no
  independently recorded expected byte length/SHA-256 fields. The adapter
  calculates evidence before playback, but reproducibility still requires
  extending the checked private overlay contract with expected digests.
- Cropped screenshot bytes intentionally remain in memory. A future reviewed
  artifact store must be private, content-addressed, ignored by Git, and expose
  only sanitized artifact references in matrix results.

Until the paired HTML run, fault cases, reviewed visual baselines, and retention
join land, a passing subtitle adapter result is custom-session evidence, not a
full format release qualification.
