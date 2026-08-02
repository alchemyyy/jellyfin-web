# Dolby Vision RPU parser WASM

This directory builds the bounded parser used by the WebGPU custom decode
worker. It wraps `dolby_vision` from the exact dovi_tool revision recorded in
`REVISION` and emits a fixed, versioned binary snapshot rather than exposing
Rust pointers or allocator-owned metadata to TypeScript.

The checked-in artifact is built for `wasm32-unknown-unknown` with:

- a 4 MiB linker minimum (the current artifact emits 65 pages, 4.1 MiB);
- 16 MiB maximum linear memory;
- a 64 KiB maximum caller buffer;
- an aborting panic strategy;
- no WASI or JavaScript imports.

Build from PowerShell with Rust 1.95 or newer and the
`wasm32-unknown-unknown` target installed:

```powershell
./build.ps1
```

The wrapper and TypeScript decoder define schema version 1 together. Changing
field order, fixed lengths, coefficient normalization, or state semantics
requires a schema version change and new conformance fixtures.

The parser is not a Dolby-licensed playback stack. The bundled libdovi code is
MIT licensed; see `LICENSE.libdovi.txt`. Dolby patent, trademark, and
certification questions are separate from that copyright license.
