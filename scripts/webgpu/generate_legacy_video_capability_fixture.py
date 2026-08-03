#!/usr/bin/env python3
"""Generate the deterministic progressive MPEG-2 qualification fixture."""

from __future__ import annotations

import argparse
import pathlib
import subprocess

from ab_harness import calculate_sha256
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


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
DEFAULT_REGISTRY_OUTPUT = DEFAULT_FRAGMENT_DIRECTORY / "legacy-video.json"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ffmpeg",
        default=DEFAULT_FFMPEG_PATH,
        type=pathlib.Path,
    )
    parser.add_argument(
        "--registry-output",
        default=DEFAULT_REGISTRY_OUTPUT,
        type=pathlib.Path,
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked fixture or registry fragment is stale",
    )
    return parser.parse_args()


def create_registry_fragment() -> dict[str, object]:
    """Creates the exact progressive MPEG-2 validation-registry fragment."""

    specification = FixtureRegistrySpecification(
        fixture_id="mpeg2-main-progressive-1080p24-matroska",
        repository_path=(
            "scripts/webgpu/legacy-video-capability-fixtures/"
            "mpeg2-progressive-1920x1080.mkv"
        ),
        expected_sha256=EXPECTED_SHA256,
        license_expression="GPL-2.0-or-later",
        license_evidence_uri="repo://LICENSE",
        provenance={
            "generatorArguments": [
                "python",
                "scripts/webgpu/generate_legacy_video_capability_fixture.py",
            ],
            "kind": "generated",
            "revision": "jellyfin-ffmpeg-8.1.2",
            "source": "FFmpeg testsrc2 deterministic MPEG-2 Main encoding",
        },
        media={
            "container": "matroska",
            "packetization": "mpeg2video-access-units",
            "video": {
                "bitDepth": 8,
                "chroma": "4:2:0",
                "codec": "mpeg2video",
                "frameRate": 24,
                "height": 1080,
                "matrix": "unspecified",
                "primaries": "unspecified",
                "profile": "main",
                "progressive": True,
                "range": "unspecified",
                "transfer": "unspecified",
                "width": 1920,
            },
        },
    )
    return create_fixture_registry_fragment(
        registry_id="legacy-video",
        generator_uri=(
            "repo://scripts/webgpu/generate_legacy_video_capability_fixture.py"
        ),
        specifications=(specification,),
    )


def main() -> None:
    arguments = parse_arguments()
    registry_output_path = arguments.registry_output.resolve()
    if arguments.check:
        write_or_check_fragment(
            registry_output_path,
            create_registry_fragment(),
            check=True,
        )
        print(f"Verified {OUTPUT_PATH} and {registry_output_path}")
        return
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
    actual_sha256 = calculate_sha256(OUTPUT_PATH)
    if actual_sha256 != EXPECTED_SHA256:
        raise RuntimeError(
            "The generated MPEG-2 qualification fixture differs from the pinned "
            f"fixture: {actual_sha256}"
        )
    write_or_check_fragment(
        registry_output_path,
        create_registry_fragment(),
        check=False,
    )
    print(f"Generated {OUTPUT_PATH} ({actual_sha256})")


if __name__ == "__main__":
    main()
