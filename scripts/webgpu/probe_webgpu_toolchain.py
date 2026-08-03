"""Probes the deterministic local WebGPU/mpv validation toolchain."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Sequence

from ab_harness import HarnessError, resolve_executable, run_checked, write_json


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parent.parent
DEFAULT_JELLYFIN_DIRECTORY = REPOSITORY_ROOT.parent / "jellyfin-12.0-nightly-windows"
DEFAULT_FFMPEG_PATH = DEFAULT_JELLYFIN_DIRECTORY / "ffmpeg.exe"
REQUIRED_FILES = (
    SCRIPT_DIRECTORY / "run-browser-reference-capture.mjs",
    SCRIPT_DIRECTORY / "mpv_reference_capture.lua",
    SCRIPT_DIRECTORY / "mpv-ab-manifest.example.json",
)
MPV_REQUIRED_OPTIONS = (
    "--ao-pcm-waveheader",
    "--gamut-mapping-mode",
    "--gpu-api",
    "--hdr-compute-peak",
    "--screenshot-sw",
    "--tone-mapping",
    "--vo",
)
FFMPEG_REQUIRED_FILTERS = ("blend", "hstack", "psnr", "ssim")


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the standalone probe CLI."""

    parser = argparse.ArgumentParser(
        description="Check tools and optional local runtime endpoints for the A/B harness."
    )
    parser.add_argument("--node", help="Node executable path")
    parser.add_argument("--mpv", help="mpv executable path")
    parser.add_argument(
        "--ffmpeg",
        help="FFmpeg executable path; defaults to the sibling Jellyfin 12 nightly",
    )
    parser.add_argument("--output", help="Optional JSON report destination")
    parser.add_argument(
        "--check-runtime",
        action="store_true",
        help="Also check Chromium CDP and the Jellyfin frontend",
    )
    parser.add_argument("--debug-url", default="http://localhost:9224")
    parser.add_argument("--frontend-url", default="http://localhost:8096/web/")
    return parser


def probe_tool(
    *,
    argument: str | None,
    environment_name: str,
    executable_name: str,
    feature_arguments: Sequence[str] | None = None,
    required_tokens: Sequence[str] = (),
) -> dict[str, object]:
    """Resolves one executable and checks its required feature surface."""

    try:
        resolution = resolve_executable(
            executable_name,
            argument,
            environment_name,
        )
    except HarnessError as error:
        return {
            "available": False,
            "error": str(error),
            "missingFeatures": list(required_tokens),
        }

    missing_features: list[str] = []
    feature_error: str | None = None
    if feature_arguments:
        try:
            completed_command = run_checked(
                [str(resolution.path), *feature_arguments],
                working_directory=REPOSITORY_ROOT,
                timeout_seconds=30,
            )
            combined_output = (
                f"{completed_command.standard_output}\n{completed_command.standard_error}"
            )
            missing_features = [
                token for token in required_tokens if token not in combined_output
            ]
        except HarnessError as error:
            feature_error = str(error)
            missing_features = list(required_tokens)

    result: dict[str, object] = {
        "available": feature_error is None and not missing_features,
        "missingFeatures": missing_features,
        "path": str(resolution.path),
        "resolutionSource": resolution.source,
        "version": resolution.version,
    }
    if feature_error:
        result["error"] = feature_error
    return result


def probe_json_endpoint(url: str) -> dict[str, object]:
    """Reads one bounded local HTTP endpoint without sending credentials."""

    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read(256 * 1024)
            content_type = response.headers.get_content_type()
            result: dict[str, object] = {
                "available": 200 <= response.status < 400,
                "contentType": content_type,
                "statusCode": response.status,
                "url": response.geturl(),
            }
            if content_type == "application/json":
                value = json.loads(body.decode("utf-8"))
                if isinstance(value, dict):
                    result["product"] = value.get("Browser") or value.get("ProductName")
            return result
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        return {"available": False, "error": str(error), "url": url}


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Builds one complete static and optional runtime readiness report."""

    files = {
        path.name: {
            "available": path.is_file(),
            "path": str(path),
        }
        for path in REQUIRED_FILES
    }
    tools = {
        "ffmpeg": probe_tool(
            argument=(
                arguments.ffmpeg
                if arguments.ffmpeg is not None
                else str(DEFAULT_FFMPEG_PATH)
            ),
            environment_name="WEBGPU_AB_FFMPEG",
            executable_name="ffmpeg",
            feature_arguments=("-hide_banner", "-filters"),
            required_tokens=FFMPEG_REQUIRED_FILTERS,
        ),
        "mpv": probe_tool(
            argument=arguments.mpv,
            environment_name="WEBGPU_AB_MPV",
            executable_name="mpv",
            feature_arguments=("--no-config", "--list-options"),
            required_tokens=MPV_REQUIRED_OPTIONS,
        ),
        "node": probe_tool(
            argument=arguments.node,
            environment_name="WEBGPU_AB_NODE",
            executable_name="node",
        ),
    }
    runtime: dict[str, object] | None = None
    if arguments.check_runtime:
        runtime = {
            "chromium": probe_json_endpoint(
                f"{arguments.debug_url.rstrip('/')}/json/version"
            ),
            "frontend": probe_json_endpoint(arguments.frontend_url),
        }
    all_files_available = all(
        bool(file_record["available"]) for file_record in files.values()
    )
    all_tools_available = all(
        bool(tool_record["available"]) for tool_record in tools.values()
    )
    runtime_available = runtime is None or all(
        bool(endpoint["available"])
        for endpoint in runtime.values()
        if isinstance(endpoint, dict)
    )
    return {
        "files": files,
        "runtime": runtime,
        "schemaVersion": 1,
        "status": (
            "ready"
            if all_files_available and all_tools_available and runtime_available
            else "incomplete"
        ),
        "tools": tools,
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Prints and optionally persists the readiness result."""

    arguments = create_argument_parser().parse_args(command_arguments)
    report = execute(arguments)
    if arguments.output:
        write_json(Path(arguments.output).expanduser().resolve(), report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
