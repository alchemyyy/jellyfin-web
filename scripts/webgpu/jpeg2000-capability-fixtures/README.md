# JPEG 2000 capability fixture

`srgb-960x540.jp2` is the exact OpenJPEG software-decoder qualification
picture. It is an unsigned, 8-bit, three-component sRGB JPEG 2000 Part 1
picture with a 960x540 coded size.

- SHA-256: `3d23398ce6857e4e7bc1851c4068d46aa1be1fd1506d7b8b3971e535e18acc94`
- Decoded RGBA FNV-1a: `1076220778`
- Decoded RGBA byte length: `2073600`
- Generator: FFmpeg `jpeg2000`, reversible 5/3 wavelet, JP2 framing

Run `python scripts/webgpu/generate_jpeg2000_capability_fixture.py` to
regenerate the file. A changed digest or fingerprint is a fixture revision and
must be reviewed rather than silently accepted.
