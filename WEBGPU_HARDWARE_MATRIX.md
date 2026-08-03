# WebGPU Hardware Matrix

Status: current-host execution record  
Executed: 2026-08-03 17:18 UTC  
Repository commit: `eaa6bb627d63dd1a7cb91e8dc45c5e2bb8d81143` with a dirty worktree

## Result

The authoritative machine-readable result is ignored at
`artifacts/webgpu-hardware-matrix/current-host-v4-20260803/result.json`.
The run exercised every Chrome/Edge and physical GPU combination available on
this host. This machine has one physical GPU, so AMD and Intel results are
explicitly `not-run`; they are not inferred from NVIDIA results.

| Browser | Physical GPU | Browser/driver | Exercises | Route authorizations | Result |
| --- | --- | --- | ---: | ---: | --- |
| Chrome | NVIDIA GeForce RTX 4080 SUPER | Chrome 151.0.7922.72 / NVIDIA 32.0.15.9660 | 4/5 passed | 6/6 passed | Failed: retention timeout |
| Chrome | AMD | Chrome 151.0.7922.72 / no AMD device | 0/5 | 0/6 | Not run: hardware unavailable |
| Chrome | Intel | Chrome 151.0.7922.72 / no Intel device | 0/5 | 0/6 | Not run: hardware unavailable |
| Edge | NVIDIA GeForce RTX 4080 SUPER | Edge 151.0.4129.59 / NVIDIA 32.0.15.9660 | 0/5 passed | 0/6 passed | Failed: custom playback did not start |
| Edge | AMD | Edge 151.0.4129.59 / no AMD device | 0/5 | 0/6 | Not run: hardware unavailable |
| Edge | Intel | Edge 151.0.4129.59 / no Intel device | 0/5 | 0/6 | Not run: hardware unavailable |

Overall coverage is 0 passed, 2 failed, 0 unsupported, and 4 not run across
the fixed six-cell matrix. A cell passes only when all five exercises and all
six exact-device route authorizations pass.

## Physically observed runtime

Both installed browsers selected the non-fallback RTX 4080 SUPER through
WebGPU and CDP. Each exposed 19 adapter features, 36 adapter limits, and 36
device limits. CDP reported WebGPU, hardware video decode, hardware video
encode, GPU compositing, rasterization, and WebGL enabled.

The runtime probe records native `VideoDecoder.isConfigSupported()` and
`AudioDecoder.isConfigSupported()` responses. These are configuration-support
observations only. They do not establish successful decode output. The live
exercise separately captures the player's output-qualified native and bundled
decoder capability record.

The Chrome headless live environment reported `dynamic-range: high` as false.
Therefore this run does not qualify a physical HDR display or visual HDR output.
It does qualify the exact selected GPU's shader/presentation prewarm routes and
the generated HDR10 custom DirectPlay lifecycle that actually ran.

## Chrome/NVIDIA details

Passed:

- Generated 4K24 HEVC Main10 High Tier PQ plus FLAC DirectPlay lifecycle
- Active-playback WebGPU device-loss recovery
- Paused-playback WebGPU device-loss recovery
- Ten-session startup comparison
- External HDR, raw HDR, external Dolby Vision, raw Dolby Vision, Dolby Vision
  Profile 7, and Profile 7 FEL exact-device route authorization

Failed:

- The 30-session retention exercise stopped making progress and ended with
  `soak-session-timeout`. Its last bounded observation contained 12 stopped
  sessions and a thirteenth custom session in `starting` state. This is not a
  pass and remains relevant to the documented `VideoSample` ownership and
  long-session retention work.

The successful authorization checks are synthetic exact-device shader and
presentation fixtures. The live media fixture is HDR10 PQ, not a Dolby Vision
title. Consequently the six authorization passes do not claim end-to-end
Dolby Vision title playback.

## Edge/NVIDIA details

Edge exposed the same NVIDIA adapter, driver, WebGPU features/limits, and a
largely complete production decoder capability record. However, none of the
five live playback exercises entered active custom playback. The bounded
lifecycle evidence reported:

- custom playback eligibility `eligible: false`
- eligibility reason `play-method-unsupported`
- no matched client/server playback decision
- `custom-playback-timeout` for lifecycle and device-loss cases
- `startup-sample-timeout` for startup
- `soak-session-timeout` for retention
- route authorization telemetry `unavailable`
- no browser console or runtime exception explaining the selection failure

This is an unresolved Edge live-playback or harness-startup failure, not an
unsupported GPU result. The retained snapshot was captured after cleanup: it
has no current source and the event sequence shows that playback had entered
`playing` before `stopped`. The persisted `play-method-unsupported` value is
therefore useful evidence, but it does not by itself prove that playback-method
selection was the root cause. Reproduce the failure while the attempted session
is active before changing player eligibility or treating Edge as supported.

## Tooling contract

[hardware_matrix.py](scripts/webgpu/hardware_matrix.py) owns matrix expansion
and delegates playback work to the existing generated live overlay,
`validation_matrix.py`, and browser-smoke adapters. It does not create a
parallel playback harness.

The checked plan and schemas are:

- [Hardware matrix plan](scripts/webgpu/validation/hardware-matrix-plan.json)
- [Plan schema](scripts/webgpu/validation/hardware-matrix-plan-schema.json)
- [Result schema](scripts/webgpu/validation/hardware-matrix-result-schema.json)

The result validator rejects missing or duplicate matrix cells, wrong-vendor
passes, fallback-adapter passes, incomplete passing records, network URLs,
absolute Windows paths, and secret-shaped report content. Full browser
profiles, private source overlays, and detailed evidence remain ignored under
`artifacts/`; the summary uses only `artifact://` evidence references.

Run the matrix with a dedicated local validation account:

```powershell
$env:WEBGPU_SMOKE_USERNAME = '<validation account>'
$env:WEBGPU_SMOKE_PASSWORD = '<validation password>'

python scripts/webgpu/hardware_matrix.py `
    --output artifacts/webgpu-hardware-matrix/current-host
```

Use `--probe-only` for browser/GPU inventory without live pass claims.
`--reuse-live-results` reassembles an existing output after runner/report fixes;
it does not rerun or upgrade the underlying live evidence.

## Remaining coverage

1. Rebuild the served frontend, rerun the Edge lifecycle case, and capture the
   active pre-stop playback options, eligibility transition, source, and custom
   session state. Distinguish a harness timeout from a player-route failure
   before changing selection policy, then rerun the complete Edge/NVIDIA cell.
2. Retain the Chrome timeout and associated `VideoSample` ownership risk as a
   documented deferred defect. Rerun the retention cell when that work resumes;
   do not convert the present result to a pass.
3. Rerun the complete matrix after the current source edits are integrated.
   This record applies only to the frontend served during the recorded run.
4. Run the same checked plan on physical AMD and Intel hosts. Do not substitute
   software adapters, vendor overrides, or NVIDIA output.
5. Run visual HDR comparisons on an HDR-capable display; headless route
   authorization is not visual output validation.
