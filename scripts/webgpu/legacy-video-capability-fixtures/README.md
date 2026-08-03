# Legacy video capability fixture

`mpeg2-progressive-1920x1080.mkv` is a deterministic, synthetic 12-frame
MPEG-2 Main Profile stream used only to qualify the focused software decoder.
It contains FFmpeg's `testsrc2` pattern at 1920x1080, 24 fps, 8-bit 4:2:0,
with progressive pictures and B-frame reordering.

Regenerate it with Jellyfin FFmpeg 8.1.2:

```powershell
python scripts/webgpu/generate_legacy_video_capability_fixture.py
```

The generator enables bit-exact muxing and validates SHA-256
`86db9dfebafb85c3c6001c762c5a1c91427d2039fcd5fbffba8c8c42efaf43b1`.
The pinned decoder must produce 12 I420 frames, 37,324,800 total decoded bytes,
and aggregate FNV-1a fingerprint `544635241` before the route is advertised.
