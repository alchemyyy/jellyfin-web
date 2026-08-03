#!/usr/bin/env python3
"""Run the generated native HEVC High Tier fixture through Jellyfin."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Sequence, cast

from ab_harness import calculate_sha256
from generate_native_HEVC_High_Tier_validation_fixture import (
    DEFAULT_OUTPUT_DIRECTORY,
    LIVE_SPEC_FILE_NAME,
    MANIFEST_FILE_NAME,
)
from run_static_HDR_live_validation import (
    DEFAULT_ARTIFACT_DIRECTORY,
    LiveValidationError,
    PRODUCTION_PROBE_PATH,
    REPOSITORY_ROOT,
    SHA256_PATTERN,
    VITE_NODE_PATH,
    authenticate,
    get_item_path_candidates,
    read_library_items,
    refresh_library,
    require_mapping,
    require_private_values_absent,
    require_production_probe_result,
    run_child,
)


DEFAULT_OVERLAY_PATH = (
    DEFAULT_ARTIFACT_DIRECTORY / "native-HEVC-High-Tier-live-overlay.json"
)
MEDIA_ENVIRONMENT = "WEBGPU_VALIDATION_NATIVE_HEVC_HIGH_TIER_MEDIA"
ITEM_ENVIRONMENT = "WEBGPU_VALIDATION_NATIVE_HEVC_HIGH_TIER_ITEM_ID"
LICENSE_ENVIRONMENT = "WEBGPU_VALIDATION_NATIVE_HEVC_HIGH_TIER_LICENSE"


class FixtureDiscoveryPending(LiveValidationError):
    """Reports a generated fixture that Jellyfin has not indexed yet."""


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the native HEVC High Tier live validation CLI."""

    default_log_directory = (
        Path(os.environ["LOCALAPPDATA"]) / "jellyfin" / "log"
        if os.environ.get("LOCALAPPDATA")
        else None
    )
    parser = argparse.ArgumentParser(
        description=(
            "Resolve the generated native HEVC High Tier fixture by exact path "
            "and run its source-bound browser lifecycle."
        )
    )
    parser.add_argument("--media-directory", default=str(DEFAULT_OUTPUT_DIRECTORY))
    parser.add_argument("--manifest")
    parser.add_argument("--live-spec")
    parser.add_argument("--overlay", default=str(DEFAULT_OVERLAY_PATH))
    parser.add_argument("--output")
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WEBGPU_SMOKE_SERVER_URL", "http://localhost:8096"),
    )
    parser.add_argument(
        "--frontend-url",
        default=os.environ.get(
            "WEBGPU_SMOKE_FRONTEND_URL", "http://localhost:8096/web"
        ),
    )
    parser.add_argument(
        "--debug-url",
        default=os.environ.get("WEBGPU_SMOKE_DEBUG_URL", "http://localhost:9224"),
    )
    parser.add_argument(
        "--server-log-directory",
        default=os.environ.get(
            "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY",
            str(default_log_directory) if default_log_directory is not None else None,
        ),
    )
    parser.add_argument("--username", default=os.environ.get("WEBGPU_SMOKE_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("WEBGPU_SMOKE_PASSWORD"))
    parser.add_argument("--skip-library-refresh", action="store_true")
    parser.add_argument("--discovery-timeout-seconds", type=int, default=120)
    return parser


def load_fixture_manifest(manifest_path: Path) -> dict[str, object]:
    """Loads and validates the single generated fixture identity."""

    try:
        manifest_value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LiveValidationError(
            f"Unable to read native HEVC High Tier manifest: {error}"
        ) from error
    manifest = require_mapping(manifest_value, "Native HEVC High Tier manifest")
    if manifest.get("schemaVersion") != 1:
        raise LiveValidationError(
            "Native HEVC High Tier manifest schemaVersion is unsupported"
        )
    fixture = require_mapping(
        manifest.get("fixture"), "Native HEVC High Tier fixture"
    )
    file_name = fixture.get("file")
    byte_length = fixture.get("byteLength")
    SHA256 = fixture.get("sha256")
    profile_tier_level = fixture.get("profileTierLevel")
    if (
        not isinstance(file_name, str)
        or Path(file_name).name != file_name
        or isinstance(byte_length, bool)
        or not isinstance(byte_length, int)
        or byte_length < 1
        or not isinstance(SHA256, str)
        or SHA256_PATTERN.fullmatch(SHA256) is None
        or not isinstance(profile_tier_level, dict)
        or profile_tier_level.get("highTier") is not True
        or profile_tier_level.get("profileIDC") != 2
        or profile_tier_level.get("levelIDC") != 153
        or fixture.get("expectedStaticHDRMetadataStatus") != "valid"
        or fixture.get("expectedToneMappingPeakNits") != 4_000
    ):
        raise LiveValidationError("Native HEVC High Tier fixture identity is invalid")
    return dict(fixture)


def resolve_fixture_item(
    fixture: Mapping[str, object],
    items: Sequence[Mapping[str, object]],
    media_directory: Path,
) -> dict[str, str]:
    """Matches the generated fixture to exactly one Jellyfin item by path."""

    file_name = cast(str, fixture["file"])
    media_path = (media_directory / file_name).resolve()
    if not media_path.is_file():
        raise LiveValidationError(f"Generated fixture is missing: {file_name}")
    if media_path.stat().st_size != cast(int, fixture["byteLength"]):
        raise LiveValidationError("Generated High Tier fixture size changed")
    if calculate_sha256(media_path) != cast(str, fixture["sha256"]):
        raise LiveValidationError("Generated High Tier fixture hash changed")
    normalized_media_path = os.path.normcase(os.path.abspath(media_path))
    matching_identifiers: list[str] = []
    for item in items:
        item_identifier = item.get("Id")
        if not isinstance(item_identifier, str) or not item_identifier:
            continue
        if normalized_media_path in get_item_path_candidates(item):
            matching_identifiers.append(item_identifier)
    unique_identifiers = tuple(dict.fromkeys(matching_identifiers))
    if not unique_identifiers:
        raise FixtureDiscoveryPending("Jellyfin has not indexed the High Tier fixture")
    if len(unique_identifiers) != 1:
        raise LiveValidationError("Jellyfin has duplicate High Tier fixture items")
    return {"itemID": unique_identifiers[0], "mediaPath": str(media_path)}


def wait_for_fixture_item(
    fixture: Mapping[str, object],
    media_directory: Path,
    *,
    server_url: str,
    token: str,
    user_identifier: str,
    timeout_seconds: int,
) -> dict[str, str]:
    """Polls bounded library state until the exact fixture is indexed."""

    deadline = time.monotonic() + timeout_seconds
    last_error: FixtureDiscoveryPending | None = None
    while time.monotonic() <= deadline:
        try:
            return resolve_fixture_item(
                fixture,
                read_library_items(server_url, token, user_identifier),
                media_directory,
            )
        except FixtureDiscoveryPending as error:
            last_error = error
            time.sleep(2)
    raise last_error or FixtureDiscoveryPending(
        "Jellyfin did not index the generated High Tier fixture"
    )


def run_production_probe(media_path: str) -> None:
    """Runs Mediabunny and the production static-HDR parser on the fixture."""

    node_path = shutil.which("node")
    if node_path is None:
        raise LiveValidationError("Node.js is required for the High Tier probe")
    if not VITE_NODE_PATH.is_file() or not PRODUCTION_PROBE_PATH.is_file():
        raise LiveValidationError("Static HDR production probe tooling is missing")
    output = run_child(
        (
            node_path,
            str(VITE_NODE_PATH),
            "--script",
            str(PRODUCTION_PROBE_PATH),
            media_path,
        ),
        os.environ.copy(),
        "Native HEVC High Tier production probe",
    )
    require_production_probe_result(
        output,
        expected_status="valid",
        expected_peak_nits=4_000,
    )


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Resolves the fixture and runs the exact live lifecycle matrix."""

    if not arguments.username or not arguments.password:
        raise LiveValidationError(
            "Pass --username/--password or set the WEBGPU_SMOKE credentials"
        )
    if not arguments.server_log_directory:
        raise LiveValidationError("A Jellyfin --server-log-directory is required")
    if arguments.discovery_timeout_seconds < 1 or arguments.discovery_timeout_seconds > 600:
        raise LiveValidationError("Discovery timeout must be from 1 through 600 seconds")

    media_directory = Path(arguments.media_directory).expanduser().resolve()
    manifest_path = (
        Path(arguments.manifest).expanduser().resolve()
        if arguments.manifest
        else media_directory / MANIFEST_FILE_NAME
    )
    live_spec_path = (
        Path(arguments.live_spec).expanduser().resolve()
        if arguments.live_spec
        else media_directory / LIVE_SPEC_FILE_NAME
    )
    server_log_directory = Path(arguments.server_log_directory).expanduser().resolve()
    license_path = REPOSITORY_ROOT / "LICENSE"
    if not live_spec_path.is_file() or not license_path.is_file():
        raise LiveValidationError("High Tier live specification or license is missing")
    if not server_log_directory.is_dir():
        raise LiveValidationError("Jellyfin server log directory is missing")

    fixture = load_fixture_manifest(manifest_path)
    server_url = arguments.server_url.rstrip("/")
    token, user_identifier = authenticate(
        server_url,
        arguments.username,
        arguments.password,
    )
    if not arguments.skip_library_refresh:
        refresh_library(server_url, token)
    resolved = wait_for_fixture_item(
        fixture,
        media_directory,
        server_url=server_url,
        token=token,
        user_identifier=user_identifier,
        timeout_seconds=arguments.discovery_timeout_seconds,
    )
    run_production_probe(resolved["mediaPath"])

    child_environment = os.environ.copy()
    child_environment[MEDIA_ENVIRONMENT] = resolved["mediaPath"]
    child_environment[ITEM_ENVIRONMENT] = resolved["itemID"]
    child_environment[LICENSE_ENVIRONMENT] = str(license_path)
    child_environment["WEBGPU_SMOKE_DEBUG_URL"] = arguments.debug_url
    child_environment["WEBGPU_SMOKE_FRONTEND_URL"] = arguments.frontend_url
    child_environment["WEBGPU_SMOKE_PASSWORD"] = arguments.password
    child_environment["WEBGPU_SMOKE_SERVER_LOG_DIRECTORY"] = str(
        server_log_directory
    )
    child_environment["WEBGPU_SMOKE_SERVER_URL"] = server_url
    child_environment["WEBGPU_SMOKE_USERNAME"] = arguments.username
    private_values = [
        arguments.username,
        arguments.password,
        token,
        user_identifier,
        resolved["itemID"],
        resolved["mediaPath"],
        str(license_path),
        str(media_directory),
        str(server_log_directory),
    ]

    overlay_path = Path(arguments.overlay).expanduser().resolve()
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    output_directory = (
        Path(arguments.output).expanduser().resolve()
        if arguments.output
        else DEFAULT_ARTIFACT_DIRECTORY
        / f"native-HEVC-High-Tier-live-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    run_child(
        (
            sys.executable,
            "scripts/webgpu/generate_validation_live_overlay.py",
            "--spec",
            str(live_spec_path),
            "--output",
            str(overlay_path),
            "--overwrite",
        ),
        child_environment,
        "Native HEVC High Tier live overlay generation",
    )
    run_child(
        (
            sys.executable,
            "scripts/webgpu/validation_matrix.py",
            "run",
            "--overlay",
            str(overlay_path),
            "--matrix",
            "private-live",
            "--output",
            str(output_directory),
        ),
        child_environment,
        "Native HEVC High Tier live validation matrix",
    )
    require_private_values_absent(output_directory, private_values)
    result = require_mapping(
        json.loads((output_directory / "result.json").read_text(encoding="utf-8")),
        "Validation result",
    )
    if result.get("status") != "passed":
        raise LiveValidationError("Native HEVC High Tier live validation did not pass")
    summary = require_mapping(result.get("summary"), "Validation result summary")
    return {
        "failedCases": summary.get("failedCases"),
        "failedChecks": summary.get("failedChecks"),
        "outputName": output_directory.name,
        "passedCases": summary.get("passedCases"),
        "passedChecks": summary.get("passedChecks"),
        "productionProbeCount": 1,
        "status": "passed",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the live fixture validation without printing private state."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (LiveValidationError, OSError, json.JSONDecodeError) as error:
        print(f"Native HEVC High Tier live validation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
