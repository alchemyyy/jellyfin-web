# TrueHD/MLP capability fixtures

These files contain only deterministic, mathematically generated sine tones.
They contain no copied media content. The generator records the exact source
SHA-256 and embeds the first 32 complete access units plus reference PCM
fingerprints in `TrueHDExactCapabilityFixtures.ts`.

Generate the encoded sources and TypeScript fixture table:

```bash
python scripts/webgpu/generate_truehd_capability_fixtures.py --regenerate-sources
```

Subsequent fixture-table regeneration can reuse the checked-in encoded files:

```bash
python scripts/webgpu/generate_truehd_capability_fixtures.py
```

`truehd_51_side_24_96000.mka` is a deterministic, metadata-free Matroska
remux of the corresponding elementary stream. It proves that Mediabunny owns
container parsing, seeking, timestamps, and `A_TRUEHD` packet extraction for
the focused decoder:

```text
ffmpeg -v error -y -fflags +bitexact -f truehd \
  -i truehd_51_side_24_96000.truehd -map 0:a:0 -c:a copy \
  -map_metadata -1 -metadata creation_time= -fflags +bitexact \
  -f matroska truehd_51_side_24_96000.mka
```

The source set covers TrueHD stereo at 48 kHz, TrueHD 5.1-side at 96 and
192 kHz, and MLP stereo at 48 kHz. It does not authorize 7.1 or Atmos object
rendering. A license-clean 7.1 TrueHD source remains required before the exact
capability probe may authorize eight-channel input.
