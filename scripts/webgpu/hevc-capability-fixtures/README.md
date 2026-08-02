# HEVC capability fixtures

`main10-4k-complex.hevc` is an eight-frame, deterministic, synthetic Main10
Level 5.1 qualification stream. The moving `testsrc2` pattern exercises more
prediction and residual work than a flat color fixture, so the bundled decoder
does not advertise 4K from an unrepresentative fast path.

SHA-256:

```text
0b320b24dbecb054276fcf4412c8ad24f9f3478d2f406f86410ad46869acce7b
```

Regenerate with FFmpeg git-862338fe31 and x265 4.1+225-1b48507eb:

```powershell
$parameters = 'high-tier=0:keyint=30:min-keyint=1:scenecut=0:bframes=0:' +
    'repeat-headers=1:annexb=1:info=0:pools=1:frame-threads=1:wpp=0'
ffmpeg -f lavfi -i "testsrc2=s=3840x2160:r=30:d=0.267" -frames:v 8 `
    -pix_fmt yuv420p10le -c:v libx265 -profile:v main10 -preset ultrafast `
    -x265-params "level-idc=5.1:$parameters" -f hevc -y main10-4k-complex.hevc
```
