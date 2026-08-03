"""Regenerate the deterministic JPEG 2000 software-decoder probe picture."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import subprocess


EXPECTED_SHA256 = "3d23398ce6857e4e7bc1851c4068d46aa1be1fd1506d7b8b3971e535e18acc94"
REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "scripts"
    / "webgpu"
    / "jpeg2000-capability-fixtures"
    / "srgb-960x540.jp2"
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--accept-revision",
        action="store_true",
        help="Keep a changed deterministic artifact and print its new digest",
    )
    return parser.parse_args()


def calculate_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    arguments = parse_arguments()
    output_path = arguments.output.resolve()
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
