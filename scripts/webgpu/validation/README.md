# WebGPU validation matrix

`scripts/webgpu/validation_matrix.py` is the integration layer for the existing
WebGPU tests and harnesses. It does not replace Vitest, the browser smoke tool,
the worker smoke tool, or the mpv comparison tool. It selects them through
fixed adapters, validates every selected fixture first, and emits one sanitized
result set.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Canonical checks, cases, matrices, and ordered generated-fixture references. Stable IDs are append-only unless an intentional revision is reviewed. |
| `schema.json` | JSON Schema contract for the canonical manifest. |
| `fixture-registry-fragment-schema.json` | Contract for generator-owned canonical fixture records. |
| `generated/*.json` | Checked fixture records emitted from the exact bytes and generator-owned metadata. |
| `overlay-schema.json` | Contract for ignored private records appended to the canonical registries. An overlay cannot replace a canonical ID. |
| `live-case-catalog.json` | Stable HDR/Dolby Vision routes and lifecycle, fault, startup, and soak exercises. |
| `live-case-catalog-schema.json` | Contract for the stable live-case catalog. |
| `live-overlay-spec-schema.json` | Contract for an ignored private source specification. |
| `live-overlay-spec.example.json` | Path-free High Tier HDR10 example used to generate a private overlay. |
| `failure-codes.json` | Sole cross-adapter failure vocabulary. Tool-specific diagnostics remain evidence, not new top-level failure codes. |
| `result-schema.json` | Machine-readable result contract. |
| `baseline-schema.json` | Immutable reviewed baseline, environment identity, fixture set, and timing-threshold contract. |

The Python validator is authoritative at runtime and rejects unknown keys,
duplicate IDs, traversal, dangling references, dependency cycles, ambiguous
check supersession, unsafe argument records, missing license evidence, and
unsupported adapters. The JSON Schemas provide the same editor and tooling
contract without adding a Python package dependency.

## Commands

Validate the registries and every canonical fixture digest:

```powershell
python scripts/webgpu/validation_matrix.py validate --verify-fixtures
```

Inspect matrices and a deduplicated plan without running a command:

```powershell
python scripts/webgpu/validation_matrix.py list --kind matrices
python scripts/webgpu/validation_matrix.py plan --matrix static
python scripts/webgpu/validation_matrix.py plan --matrix release --selector codec:dts
```

Run the static exact-codec matrix:

```powershell
python scripts/webgpu/validation_matrix.py run --matrix static
```

The default output is ignored under
`artifacts/webgpu-validation/<UTC>-<commit>/`. Each completed run contains:

- `result.json`: canonical environment, fixture, check, case, failure, and
  artifact records;
- `summary.md`: review-oriented summary;
- `summary.html`: standalone table summary;
- `manual-checklist.md`: case-ID-bound observations;
- `evidence/<check-id>.json`: sanitized structured adapter output.

Exit code zero means `passed`. `failed` and `incomplete` both return nonzero.
`incomplete` is used when declared private inputs or required manual evidence
are absent; absence never silently becomes a pass.

## Generated fixture registries

The hand-maintained manifest does not duplicate generated fixture size, hash,
license, provenance, or media metadata. Each owning generator can emit its
fragment, and the registry-only command updates or checks all four fragments
without invoking a codec tool:

```powershell
python scripts/webgpu/generate_validation_fixture_registry.py
python scripts/webgpu/generate_validation_fixture_registry.py --check
```

The current fragments are JPEG 2000, progressive MPEG-2, DTS, and TrueHD/MLP.
Generation derives byte length and SHA-256 from the checked file and rejects a
digest that differs from the generator's reviewed pin. The loader requires
repository-local fragment and generator URIs, validates every expanded fixture
record, and rejects duplicate registry or fixture IDs.

`manifest.sha256` in a result is the effective digest of the source manifest
and the ordered fragment digests. `manifest.sourceSHA256` records the source
file separately, and `manifest.fixtureRegistries` records each fragment URI and
digest. A fragment change therefore invalidates a reviewed baseline even when
`manifest.json` itself did not change.

## Selectors

Selectors are repeatable. Values on the same axis are ORed; different axes are
ANDed.

```powershell
# DTS or TrueHD cases in the checkpoint matrix
python scripts/webgpu/validation_matrix.py plan --matrix checkpoint `
    --selector codec:dts `
    --selector codec:truehd

# DTS cases using the libdcadec route
python scripts/webgpu/validation_matrix.py plan --matrix checkpoint `
    --selector codec:dts `
    --selector route:libdcadec
```

Supported forms are `case:<id>`, `codec:<name>`, `route:<name>`,
`gpu:<vendor>`, `tag:<tag>`, and `soak`.

## Check deduplication

Cases reference the smallest focused check that proves their static contract.
Matrices add shared gates. A larger check may declare `supersedes`; for
example, `full-vitest` supersedes `vitest-codec-contracts` in the release
matrix. The planner removes the focused invocation, records the replacement,
and evaluates affected cases against the larger check result. Dependencies are
then ordered without shell chaining.

All commands are argument vectors. The manifest cannot contain a shell command
string. Repository targets are checked before execution, globs are expanded by
Python, and Windows command shims such as `npm.cmd` are resolved before
launching.

## Private live cases

Do not add credentials, Jellyfin item IDs, authenticated URLs, private media
paths, or machine-specific executable paths to `manifest.json`. Add an ignored
overlay and provide values through environment variables. An environment-backed
fixture still requires its real byte length, SHA-256, provenance, generator,
and redistribution license.

Do not hand-copy lifecycle, device-loss, startup, retention, or exact HDR route
checks for every title. The checked live catalog defines 18 production
presentation routes and eight shared exercises. Generate an ignored overlay
from one ignored source specification instead:

```powershell
python scripts/webgpu/generate_validation_live_overlay.py --list-catalog

Copy-Item `
    scripts/webgpu/validation/live-overlay-spec.example.json `
    artifacts/webgpu-validation/private-live-spec.json

$env:WEBGPU_VALIDATION_HDR10_MEDIA = '<private media path>'
$env:WEBGPU_VALIDATION_HDR10_LICENSE = '<private license evidence path>'
$env:WEBGPU_VALIDATION_HDR10_ITEM_ID = '<Jellyfin item ID>'
$env:WEBGPU_VALIDATION_HDR10_MPV_PLAN = '<private mpv A/B plan path>'

python scripts/webgpu/generate_validation_live_overlay.py `
    --spec artifacts/webgpu-validation/private-live-spec.json `
    --output artifacts/webgpu-validation/private-live-overlay.json
```

The generator computes byte length and SHA-256 from the environment-backed
media, verifies the private media/license/plan inputs exist, expands only the
selected exercises, and validates the overlay with the production manifest
loader before atomically publishing it. It never writes a media path, license
path, item ID, URL, or credential value. Use `--overwrite` for an intentional
replacement.

Each browser check asserts the exact presentation route, not merely a generic
HDR boolean. The catalog distinguishes external PQ/HLG, raw PQ/HLG, external
Profile 5, raw Profile 5/8, and Profile 7 MEL/FEL/base-fallback dispositions,
with native and bundled decoder variants where they exist. A Profile 7 worker
record is accepted only for the FEL route. Optional mpv A/B records use an
environment-backed capture plan and source. Every generated browser check also
requires exact Jellyfin `DirectPlay`; an active server transcode or nonempty
transcode-reason list fails the case instead of relying on the case metadata.
Ordinary PQ HDR sources may also declare `staticHDRMetadata` with an exact
bounded scan status and tone-mapping peak. Generated lifecycle and startup
checks then assert both values, retain the first matching access-unit index and
bounded scan count as evidence, and reject a route that silently falls back to
the 1000-nit default.
The startup exercise is route-aware: SDR identity runs HTML, presentation-only,
and custom modes, while HDR/Dolby Vision runs HTML and custom modes because the
player intentionally leaves native HDR media on the browser-managed surface.
Every applicable mode still receives one warmup plus the configured measured
sample count.

For the generated ordinary-PQ negative matrix, use the specialized wrapper
rather than manually resolving four item IDs:

```powershell
python scripts/webgpu/generate_static_HDR_validation_fixtures.py --overwrite
python scripts/webgpu/run_static_HDR_live_validation.py
```

The wrapper verifies the ignored identity manifest, matches Jellyfin items by
exact local path, executes the production Mediabunny/HEVC scanner against all
four files, generates the private overlay, runs `private-live`, and scans every
result artifact for retained credentials, identifiers, or machine paths. Its
four expected states are `absent`, `malformed`, `conflicting`, and `valid`; only
the valid state retains metadata and selects its declared 4000-nit peak.

Run one generated source matrix or the aggregate matrix with:

```powershell
$env:WEBGPU_SMOKE_USERNAME = '<validation account>'
$env:WEBGPU_SMOKE_PASSWORD = '<validation password>'
$env:WEBGPU_SMOKE_SERVER_LOG_DIRECTORY = '<Jellyfin log directory>'
$env:WEBGPU_AB_USERNAME = $env:WEBGPU_SMOKE_USERNAME
$env:WEBGPU_AB_PASSWORD = $env:WEBGPU_SMOKE_PASSWORD

python scripts/webgpu/validation_matrix.py run `
    --overlay artifacts/webgpu-validation/private-live-overlay.json `
    --matrix private-live
```

The abbreviated structure below documents the low-level overlay contract.
Prefer the generator so route and lifecycle logic remains single-sourced.

The following abbreviated structure shows the required linkage. Replace the
descriptive values in an ignored file with measured records; do not commit that
file.

```json
{
  "$schema": "scripts/webgpu/validation/overlay-schema.json",
  "schemaVersion": 1,
  "fixtures": [
    {
      "id": "private-hdr10-reference",
      "uri": "env://WEBGPU_VALIDATION_MEDIA_PATH",
      "byteLength": 123456789,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "license": {
        "expression": "LicenseRef-Private-Validation-Only",
        "evidence": "env://WEBGPU_VALIDATION_LICENSE_PATH"
      },
      "provenance": {
        "kind": "upstream",
        "source": "Private validation source record",
        "revision": "local-v1",
        "generatorArguments": ["documented", "private", "acquisition"]
      },
      "media": {
        "container": "matroska",
        "packetization": "hevc-length-prefixed",
        "video": {
          "codec": "hevc",
          "profile": "main-10-high-tier-level-5.1",
          "width": 3840,
          "height": 2160,
          "frameRate": 23.976025,
          "bitDepth": 10,
          "chroma": "4:2:0",
          "range": "limited",
          "primaries": "bt2020",
          "transfer": "pq",
          "matrix": "bt2020-ncl",
          "progressive": true
        }
      }
    }
  ],
  "checks": [
    {
      "id": "private-hdr10-browser-smoke",
      "title": "Private HDR10 Jellyfin lifecycle smoke",
      "adapter": "browser-smoke",
      "timeoutSeconds": 600,
      "requiredEnvironment": [
        "WEBGPU_SMOKE_ITEM_ID",
        "WEBGPU_SMOKE_USERNAME",
        "WEBGPU_SMOKE_PASSWORD"
      ],
      "arguments": [
        "--expected-video-output",
        "video-frame",
        "--expected-video-decoder",
        "native",
        "--expected-play-method",
        "DirectPlay",
        "--expected-audio",
        "ready"
      ],
      "resultFormat": "json",
      "resultAssertions": [
        { "path": "/status", "operator": "equals", "value": "passed" },
        { "path": "/failures", "operator": "empty" }
      ]
    }
  ],
  "cases": [
    {
      "id": "private-hdr10-live",
      "title": "Private HDR10 DirectPlay lifecycle",
      "fixtureIds": ["private-hdr10-reference"],
      "checkIds": ["private-hdr10-browser-smoke"],
      "tags": ["codec:hevc", "container:matroska", "route:native-video-frame"],
      "expectations": {
        "capability": "supported",
        "decoderBackend": "native",
        "frameMode": "video-frame",
        "presentationRoute": "custom-webgpu",
        "fallback": "none",
        "audioRoute": "decoded-pcm",
        "jellyfinPlayMethod": "DirectPlay",
        "permittedTranscodeReasons": []
      }
    }
  ],
  "matrices": [
    {
      "id": "private-live",
      "title": "Private live Jellyfin validation",
      "caseIds": ["private-hdr10-live"],
      "requiredCheckIds": ["local-runtime-toolchain"],
      "requireManualObservations": false
    }
  ]
}
```

Run it with:

```powershell
python scripts/webgpu/validation_matrix.py run `
    --overlay artifacts/webgpu-validation/private-overlay.json `
    --matrix private-live
```

The result records the overlay hash, not its path or content. Every declared
environment value is replaced before evidence is written. URLs, token query
values, credential assignments, sensitive keys, and absolute Windows paths are
also removed. A declared value surviving sanitization aborts report creation.

## Adapters

The current fixed adapters cover TypeScript, Vitest, Node tests, Python
unittest, ESLint, Stylelint, development/production Webpack, generated-data
checks, Vite Node, production artifact verification, browser lifecycle smoke,
Dolby Vision worker smoke, runtime readiness, and mpv/browser A/B capture.

`browser-smoke` reads its existing `WEBGPU_SMOKE_*` variables and permits
per-check environment-backed `--item-id` and `--server-log-directory` values.
Several private titles can therefore run in one matrix without copying or
exposing their IDs or machine log paths. `worker-smoke`,
`toolchain-probe`, and `mpv-ab` may map declared environment variables to a
small adapter-specific option whitelist through `environmentArguments`.
Arbitrary option names are rejected.

Generated browser cases pass the case's `jellyfinPlayMethod` as an exact
`--expected-play-method` assertion. The adapter records only bounded player and
matching server-session fields: method, capability booleans, item/media-source
match booleans, transcode-state booleans, and transcode-reason names. DirectPlay
fails if either side selects another method, the server exposes active
transcoding, or any transcode reason remains. Private item/media-source/device
identifiers and stream URLs are never written.

When a generated PQ HDR source declares `staticHDRMetadata`, the browser
adapter passes fixed `--expected-static-hdr-metadata-status` and
`--expected-static-hdr-peak-nits` arguments. These values are source contract
data, not machine environment input. Each custom startup sample also records
and validates the scan status, scan bound, first matching access unit, and
active tone-mapping peak.

Generated browser cases also require bounded Jellyfin log evidence. The
adapter snapshots all retained primary-log and FFmpeg-transcode-log byte sizes,
then reads only primary bytes appended during the exercise, capped at 8 MiB.
Private item and account names are resolved in browser memory solely for exact
matching. Evidence retains the matched start/stop sequence, policy booleans,
counts, and whether any transcode log was created or changed. It never retains
raw lines, filenames, paths, names, tokens, or IDs. DirectPlay requires the
exact expected session count, alternating start/stop order, no server errors,
and zero transcode-log activity.

A successful browser adapter contributes bounded browser product/protocol,
WebGPU adapter/limit/canvas data, CDP GPU device and driver records, display HDR
state, Jellyfin version/platform, and request-intercepted feature flags to the
run environment header. Private values are sanitized before evidence is
written. A reviewed baseline therefore compares the actual browser, GPU,
driver, display, server, and active feature configuration instead of
`not-recorded` placeholders.

## Reviewed baselines

A normal run never creates or changes a baseline. Approval is a separate command
that requires all of the following:

- a passing result from a clean worktree;
- an explicit reviewer label;
- an explicit integer duration-regression tolerance;
- `--accept-reviewed-result`;
- `--replace-existing` when updating an existing valid baseline.

```powershell
python scripts/webgpu/validation_matrix.py approve-baseline `
    --result artifacts/webgpu-validation/<clean-run>/result.json `
    --output artifacts/webgpu-validation/static-baseline.json `
    --reviewed-by local-validation `
    --duration-tolerance-percent 25 `
    --accept-reviewed-result
```

Use the baseline read-only in a later run:

```powershell
python scripts/webgpu/validation_matrix.py run `
    --matrix static `
    --baseline artifacts/webgpu-validation/static-baseline.json
```

Comparison requires the same manifest and private-overlay digests, matrix,
selectors, selected IDs, sanitized host/tool/browser/GPU/server/flag
environment, fixture byte lengths and hashes, and passing case/check statuses.
Each check duration must be no greater than its reviewed duration plus the
explicit percentage tolerance.
Repository commit and dirty state are recorded in the baseline source but are
excluded from the reusable environment identity, so a reviewed baseline can
detect regressions on later commits.

Approval rejects unsanitized URLs and absolute Windows paths in environment
evidence. Comparison failure is recorded in the normal result and changes the
run status to `failed`; it never modifies the baseline. The result records only
the baseline hash, approval time, source run ID, status, failures, and a
repository-relative or private URI.

## Hardware and browser matrix

`hardware_matrix.py` expands the checked
`validation/hardware-matrix-plan.json` into the six Chrome/Edge by
NVIDIA/AMD/Intel cells. It launches each installed browser with an isolated
profile, verifies the selected physical adapter through both WebGPU and CDP,
then delegates live playback to the existing generated overlay,
`validation_matrix.py`, and `browser-smoke` adapters. It does not duplicate a
second playback harness.

The runtime probe records browser and driver versions, every exposed adapter
and device feature, every exposed numeric limit, CDP feature status, and native
WebCodecs configuration support. The live lifecycle adds output-qualified
production codec capabilities and exact-device external HDR, raw HDR, external
Dolby Vision, raw Dolby Vision, Profile 7, and Profile 7 FEL authorization.
Each physically selected cell must also pass DirectPlay lifecycle, active and
paused device-loss recovery, ten-sample startup comparison, and the
thirty-session retention soak.

```powershell
$env:WEBGPU_SMOKE_USERNAME = '<validation account>'
$env:WEBGPU_SMOKE_PASSWORD = '<validation password>'

python scripts/webgpu/hardware_matrix.py `
    --output artifacts/webgpu-hardware-matrix/current-host
```

Use `--probe-only` to inspect browser/GPU availability without claiming any
live exercise passed. `passed` requires all exercises and authorizations.
`failed` means a physically available cell ran and failed. `unsupported` means
the installed browser could not use the selected hardware route. `not-run` is
reserved for an absent browser, absent physical GPU vendor, or deliberately
omitted live input. An AMD or Intel pass is never inferred from NVIDIA output.

The report schema rejects duplicate/missing cells, a pass on a fallback or
wrong-vendor adapter, incomplete pass records, absolute machine paths, network
URLs, and secret-shaped content. Full browser profiles, private overlays, and
raw validation evidence remain ignored under `artifacts/`; the authoritative
summary contains only `artifact://` references. See the
[hardware matrix record](../../../WEBGPU_HARDWARE_MATRIX.md) for the latest
physically executed host coverage.

## Current coverage boundary

The canonical v1 registry contains the 15 checked-in exact fixtures/cases for
JPEG 2000, progressive MPEG-2 Matroska, seven DTS tuples plus representative
Matroska demux, and four TrueHD/MLP tuples plus representative Matroska demux.
It does not claim that static checks are live Jellyfin DirectPlay evidence.
Live title and HDR/Dolby Vision routes still require exact private source
records and real executions before their matrix can pass. Cross-browser/GPU
coverage uses the hardware matrix above; unavailable vendors remain explicit
`not-run` cells. Route/exercise definitions and overlay generation are shared
rather than duplicated per title.

Shared case-ID failure injection, pairwise matrix generation, and
manual-observation ingestion remain framework work. Bounded server-log capture
is integrated into every generated browser case.
