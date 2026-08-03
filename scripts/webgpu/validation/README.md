# WebGPU validation matrix

`scripts/webgpu/validation_matrix.py` is the integration layer for the existing
WebGPU tests and harnesses. It does not replace Vitest, the browser smoke tool,
the worker smoke tool, or the mpv comparison tool. It selects them through
fixed adapters, validates every selected fixture first, and emits one sanitized
result set.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Canonical fixtures, checks, cases, and matrices. Stable IDs are append-only unless an intentional fixture revision is reviewed. |
| `schema.json` | JSON Schema contract for the canonical manifest. |
| `overlay-schema.json` | Contract for ignored private records appended to the canonical registries. An overlay cannot replace a canonical ID. |
| `failure-codes.json` | Sole cross-adapter failure vocabulary. Tool-specific diagnostics remain evidence, not new top-level failure codes. |
| `result-schema.json` | Machine-readable result contract. |

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

`browser-smoke` reads its existing `WEBGPU_SMOKE_*` variables. `worker-smoke`,
`toolchain-probe`, and `mpv-ab` may map declared environment variables to a
small adapter-specific option whitelist through `environmentArguments`.
Arbitrary option names are rejected.

## Current coverage boundary

The canonical v1 registry contains the 15 checked-in exact fixtures/cases for
JPEG 2000, progressive MPEG-2 Matroska, seven DTS tuples plus representative
Matroska demux, and four TrueHD/MLP tuples plus representative Matroska demux.
It does not claim that static checks are live Jellyfin DirectPlay evidence.
Live title, HDR/Dolby Vision, fault, startup, soak, and cross-browser/GPU cases
must be added as content-addressed records or private overlays before their
matrix can pass.

Baseline approval/comparison, generator-emitted registry fragments, shared
case-ID failure injection, server log capture, pairwise matrix generation, and
manual-observation ingestion remain framework work. Baselines must not be
implemented as an automatic update after a run.
