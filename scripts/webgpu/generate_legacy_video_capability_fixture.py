#!/usr/bin/env python3
"""Generate the deterministic progressive MPEG-2 qualification fixture."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import subprocess


SCRIPT_DIRECTORY = pathlib.Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parents[1]
DEFAULT_FFMPEG_PATH = (
    REPOSITORY_ROOT.parent
    / "jellyfin-12.0-nightly-windows"
    / "ffmpeg.exe"
)
OUTPUT_PATH = (
    SCRIPT_DIRECTORY
    / "legacy-video-capability-fixtures"
    / "mpeg2-progressive-1920x1080.mkv"
)
EXPECTED_SHA256 = "86db9dfebafb85c3c6001c762c5a1c91427d2039fcd5fbffba8c8c42efaf43b1"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ffmpeg",
        default=DEFAULT_FFMPEG_PATH,
        type=pathlib.Path,
    )
    return parser.parse_args()


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        while chunk := input_file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    arguments = parse_arguments()
    ffmpeg_path = arguments.ffmpeg.resolve()
    if not ffmpeg_path.is_file():
        raise FileNotFoundError(f"FFmpeg was not found: {ffmpeg_path}")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080:rate=24:duration=0.5",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-an",
        "-c:v",
        "mpeg2video",
        "-g",
        "12",
        "-bf",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-q:v",
        "2",
        "-f",
        "matroska",
        "-y",
        str(OUTPUT_PATH),
    ]
    subprocess.run(command, check=True, cwd=REPOSITORY_ROOT)
    actual_sha256 = sha256(OUTPUT_PATH)
    if actual_sha256 != EXPECTED_SHA256:
        raise RuntimeError(
            "The generated MPEG-2 qualification fixture differs from the pinned "
            f"fixture: {actual_sha256}"
        )
    print(f"Generated {OUTPUT_PATH} ({actual_sha256})")


if __name__ == "__main__":
    main()
