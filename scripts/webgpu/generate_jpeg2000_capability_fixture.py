"""Regenerate the deterministic JPEG 2000 software-decoder probe picture."""

from __future__ import annotations

import argparse
import pathlib
import subprocess

from ab_harness import HarnessError, calculate_sha256
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


EXPECTED_SHA256 = "3d23398ce6857e4e7bc1851c4068d46aa1be1fd1506d7b8b3971e535e18acc94"
REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "scripts"
    / "webgpu"
    / "jpeg2000-capability-fixtures"
    / "srgb-960x540.jp2"
)
DEFAULT_REGISTRY_OUTPUT = DEFAULT_FRAGMENT_DIRECTORY / "jpeg2000.json"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--registry-output",
        type=pathlib.Path,
        default=DEFAULT_REGISTRY_OUTPUT,
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked fixture or registry fragment is stale",
    )
    parser.add_argument(
        "--accept-revision",
        action="store_true",
        help="Keep a changed deterministic artifact and print its new digest",
    )
    return parser.parse_args()


def create_registry_fragment(
    output_path: pathlib.Path,
    expected_sha256: str = EXPECTED_SHA256,
) -> dict[str, object]:
    """Creates the exact JPEG 2000 validation-registry fragment."""

    try:
        repository_path = output_path.resolve().relative_to(REPOSITORY_ROOT).as_posix()
    except ValueError as error:
        raise HarnessError(
            "JPEG 2000 registry output fixture must be in the repository"
        ) from error
    specification = FixtureRegistrySpecification(
        fixture_id="jpeg2000-srgb-960x540",
        repository_path=repository_path,
        expected_sha256=expected_sha256,
        license_expression="GPL-2.0-or-later",
        license_evidence_uri="repo://LICENSE",
        provenance={
            "generatorArguments": [
                "python",
                "scripts/webgpu/generate_jpeg2000_capability_fixture.py",
            ],
            "kind": "generated",
            "revision": "fixture-v1",
            "source": "FFmpeg testsrc2 with the reversible JPEG 2000 encoder",
        },
        media={
            "container": "jp2",
            "packetization": "jpeg2000-codestream",
            "video": {
                "bitDepth": 8,
                "chroma": "4:4:4",
                "codec": "jpeg2000",
                "frameRate": 24,
                "height": 540,
                "matrix": "rgb",
                "primaries": "srgb",
                "profile": "part-1-reversible",
                "progressive": True,
                "range": "full",
                "transfer": "srgb",
                "width": 960,
            },
        },
    )
    return create_fixture_registry_fragment(
        registry_id="jpeg2000",
        generator_uri="repo://scripts/webgpu/generate_jpeg2000_capability_fixture.py",
        specifications=(specification,),
    )


def main() -> int:
    arguments = parse_arguments()
    output_path = arguments.output.resolve()
    registry_output_path = arguments.registry_output.resolve()
    if arguments.check and arguments.accept_revision:
        raise HarnessError("--check and --accept-revision cannot be combined")
    if arguments.check:
        fragment = create_registry_fragment(output_path)
        write_or_check_fragment(registry_output_path, fragment, check=True)
        print(f"Verified {output_path} and {registry_output_path}")
        return 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        arguments.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x540:rate=24",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv444p",
        "-c:v",
        "jpeg2000",
        "-pred",
        "1",
        "-format",
        "jp2",
        "-y",
        str(output_path),
    ]
    subprocess.run(command, check=True)
    artifact_sha256 = calculate_sha256(output_path)
    print(f"output={output_path}")
    print(f"sha256={artifact_sha256}")
    if artifact_sha256 != EXPECTED_SHA256 and not arguments.accept_revision:
        raise RuntimeError(
            "Generated fixture differs from the reviewed artifact; rerun with "
            "--accept-revision only when intentionally revising it"
        )
    fragment = create_registry_fragment(output_path, artifact_sha256)
    write_or_check_fragment(registry_output_path, fragment, check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
