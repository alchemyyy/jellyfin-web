# libdcadec qualification fixtures

These DTS elementary streams and mono PCM reference files come from
`foo86/dcadec-samples` commit
`8665d5718888f2b9192516f86014cc3642ed653a`.

Upstream explicitly releases the sample files into the public domain. The
fixtures cover DTS Core, DTS 96/24, DTS-ES, DTS-HD High Resolution, and DTS-HD
Master Audio at the exact channel layouts, 16/24-bit depths, and 48/96/192 kHz
sample rates authorized by the bundled decoder probe.

`packets.json` records FFmpeg DTS-demuxer packet byte ranges adjusted past the
DTS-HD file headers. It is validation metadata only; production packets come
from Mediabunny's bounded container input. The DTS-HD MA reference comparison
also records the stream header's 1,024-sample codec delay and 2,048-sample
original PCM length so the same trimming performed by libdcadec's command-line
decoder is applied before the sample-exact comparison.

`core_51_24_48_768_0.mka` is a deterministic, metadata-free Matroska remux of
the Core fixture. It verifies Mediabunny's `A_DTS` unknown-codec packet route:

```text
ffmpeg -v error -y -fflags +bitexact \
  -i core_51_24_48_768_0.dtshd -map 0:a:0 -c:a copy -map_metadata -1 \
  -metadata creation_time= -fflags +bitexact -f matroska \
  core_51_24_48_768_0.mka
```

Mediabunny 1.52.2 does not surface Blu-ray DTS stream types from MPEG-TS or
M2TS. The player therefore does not advertise DTS in those containers. This is
a demux limitation, not a libdcadec limitation; support must remain gated until
an upstream or equivalently bounded library route exposes complete DTS access
units with timestamps.
