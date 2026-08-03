#!/usr/bin/env python3
"""Run generated static HDR fixtures through Jellyfin and browser validation."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Sequence, cast

from ab_harness import calculate_sha256
from generate_static_HDR_validation_fixtures import (
    DEFAULT_OUTPUT_DIRECTORY,
    LIVE_SPEC_FILE_NAME,
    MANIFEST_FILE_NAME,
    get_source_environment_suffix,
)
from resolve_jellyfin_media_source import (
    CLIENT_AUTHORIZATION,
    SourceResolutionError,
    request_json,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIRECTORY = REPOSITORY_ROOT / "artifacts" / "webgpu-validation"
DEFAULT_OVERLAY_PATH = DEFAULT_ARTIFACT_DIRECTORY / "static-HDR-live-overlay.json"
PRODUCTION_PROBE_PATH = REPOSITORY_ROOT / "scripts" / "webgpu" / "probe_static_HDR_fixture.ts"
VITE_NODE_PATH = REPOSITORY_ROOT / "node_modules" / "vite-node" / "vite-node.mjs"
MAXIMUM_STATIC_HDR_SCAN_ACCESS_UNIT_COUNT = 16
MAXIMUM_STATIC_HDR_SCAN_BYTE_LENGTH = 8 * 1024 * 1024
STATIC_HDR_STATUSES = frozenset({"absent", "conflicting", "malformed", "valid"})
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class LiveValidationError(RuntimeError):
    """Reports a fixture discovery, privacy, or child-harness failure."""


class FixtureDiscoveryPending(LiveValidationError):
    """Reports generated fixtures that Jellyfin has not indexed yet."""


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the generated static-HDR live validation CLI."""

    default_log_directory = (
        Path(os.environ["LOCALAPPDATA"]) / "jellyfin" / "log"
        if os.environ.get("LOCALAPPDATA")
        else None
    )
    parser = argparse.ArgumentParser(
        description=(
            "Resolve generated static HDR fixtures by exact path and run their "
            "source-bound browser validation matrix."
        )
    )
    parser.add_argument(
        "--media-directory",
        default=str(DEFAULT_OUTPUT_DIRECTORY),
    )
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
        default=os.environ.get("WEBGPU_SMOKE_FRONTEND_URL", "http://localhost:8096/web"),
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
    parser.add_argument("--selector")
    parser.add_argument("--skip-library-refresh", action="store_true")
    parser.add_argument("--discovery-timeout-seconds", type=int, default=120)
    return parser


def require_array(value: object, label: str) -> list[object]:
    """Returns one JSON array or raises a bounded harness error."""

    if not isinstance(value, list):
        raise LiveValidationError(f"{label} must be an array")
    return value


def require_mapping(value: object, label: str) -> dict[str, object]:
    """Returns one JSON object or raises a bounded harness error."""

    if not isinstance(value, dict):
        raise LiveValidationError(f"{label} must be an object")
    return cast(dict[str, object], value)


def load_fixture_manifest(manifest_path: Path) -> list[dict[str, object]]:
    """Loads and verifies the four generated fixture identities."""

    try:
        manifest_value = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LiveValidationError(f"Unable to read generated fixture manifest: {error}") from error
    manifest = require_mapping(manifest_value, "Static HDR fixture manifest")
    if manifest.get("schemaVersion") != 1:
        raise LiveValidationError("Static HDR fixture manifest schemaVersion is unsupported")
    fixtures: list[dict[str, object]] = []
    statuses: set[str] = set()
    for fixture_index, fixture_value in enumerate(
        require_array(manifest.get("fixtures"), "Static HDR fixtures")
    ):
        fixture = require_mapping(fixture_value, f"Static HDR fixtures[{fixture_index}]")
        file_name = fixture.get("file")
        status = fixture.get("expectedStaticHDRMetadataStatus")
        byte_length = fixture.get("byteLength")
        SHA256 = fixture.get("sha256")
        if (
            not isinstance(file_name, str)
            or Path(file_name).name != file_name
            or not isinstance(status, str)
            or status not in STATIC_HDR_STATUSES
            or isinstance(byte_length, bool)
            or not isinstance(byte_length, int)
            or byte_length < 1
            or not isinstance(SHA256, str)
            or SHA256_PATTERN.fullmatch(SHA256) is None
        ):
            raise LiveValidationError(
                f"Static HDR fixtures[{fixture_index}] has an invalid identity"
            )
        if status in statuses:
            raise LiveValidationError(f"Static HDR fixture status is duplicated: {status}")
        statuses.add(status)
        fixtures.append(dict(fixture))
    if statuses != STATIC_HDR_STATUSES:
        raise LiveValidationError("Static HDR fixture manifest must cover all four statuses")
    return fixtures


def normalize_local_path(path_value: str) -> str:
    """Normalizes one local media path for exact same-host comparison."""

    return os.path.normcase(os.path.abspath(path_value))


def get_item_path_candidates(item: Mapping[str, object]) -> tuple[str, ...]:
    """Returns unique item and media-source paths without retaining URLs."""

    candidates: list[str] = []
    seen_paths: set[str] = set()

    def append_path(path_value: object) -> None:
        if not isinstance(path_value, str) or not path_value:
            return
        normalized_path = normalize_local_path(path_value)
        if normalized_path in seen_paths:
            return
        seen_paths.add(normalized_path)
        candidates.append(normalized_path)

    append_path(item.get("Path"))
    media_sources = item.get("MediaSources")
    if isinstance(media_sources, list):
        for media_source in media_sources:
            if isinstance(media_source, dict):
                append_path(media_source.get("Path"))
    return tuple(candidates)


def resolve_fixture_items(
    fixtures: Sequence[Mapping[str, object]],
    items: Sequence[Mapping[str, object]],
    media_directory: Path,
) -> dict[str, dict[str, str]]:
    """Matches every fixture to exactly one Jellyfin item by absolute path."""

    item_identifiers_by_path: dict[str, list[str]] = {}
    for item in items:
        item_identifier = item.get("Id")
        if not isinstance(item_identifier, str) or not item_identifier:
            continue
        for candidate_path in get_item_path_candidates(item):
            item_identifiers_by_path.setdefault(candidate_path, []).append(item_identifier)

    resolved: dict[str, dict[str, str]] = {}
    for fixture in fixtures:
        file_name = cast(str, fixture["file"])
        status = cast(str, fixture["expectedStaticHDRMetadataStatus"])
        media_path = (media_directory / file_name).resolve()
        if not media_path.is_file():
            raise LiveValidationError(f"Generated fixture is missing: {file_name}")
        expected_byte_length = cast(int, fixture["byteLength"])
        expected_SHA256 = cast(str, fixture["sha256"])
        if media_path.stat().st_size != expected_byte_length:
            raise LiveValidationError(f"Generated fixture size changed: {file_name}")
        if calculate_sha256(media_path) != expected_SHA256:
            raise LiveValidationError(f"Generated fixture hash changed: {file_name}")
        matching_identifiers = item_identifiers_by_path.get(
            normalize_local_path(str(media_path)), []
        )
        unique_identifiers = tuple(dict.fromkeys(matching_identifiers))
        if not unique_identifiers:
            raise FixtureDiscoveryPending(f"Jellyfin has not indexed {file_name}")
        if len(unique_identifiers) != 1:
            raise LiveValidationError(f"Jellyfin has duplicate items for {file_name}")
        resolved[status] = {
            "itemID": unique_identifiers[0],
            "mediaPath": str(media_path),
        }
    return resolved


def authenticate(
    server_url: str,
    username: str,
    password: str,
) -> tuple[str, str]:
    """Authenticates once and returns the private token and user identifier."""

    authentication = require_mapping(
        request_json(
            method="POST",
            url=f"{server_url.rstrip('/')}/Users/AuthenticateByName",
            body={"Pw": password, "Username": username},
        ),
        "Authentication",
    )
    token = authentication.get("AccessToken")
    user = authentication.get("User")
    if not isinstance(token, str) or not isinstance(user, dict):
        raise LiveValidationError("Jellyfin authentication response was incomplete")
    user_identifier = user.get("Id")
    if not isinstance(user_identifier, str):
        raise LiveValidationError("Jellyfin authentication returned no user ID")
    return token, user_identifier


def create_authorization_header(token: str) -> str:
    """Creates the Jellyfin 12 Authorization header without logging its token."""

    encoded_token = urllib.parse.quote(token, safe="")
    return f'{CLIENT_AUTHORIZATION}, Token="{encoded_token}"'


def refresh_library(server_url: str, token: str) -> None:
    """Requests one local Jellyfin library refresh and accepts an empty body."""

    request = urllib.request.Request(
        f"{server_url.rstrip('/')}/Library/Refresh",
        headers={"Authorization": create_authorization_header(token)},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except (OSError, urllib.error.URLError) as error:
        raise LiveValidationError(f"Jellyfin library refresh failed: {error}") from error


def read_library_items(
    server_url: str,
    token: str,
    user_identifier: str,
) -> list[dict[str, object]]:
    """Reads bounded item records needed for exact local-path matching."""

    encoded_user_identifier = urllib.parse.quote(user_identifier, safe="")
    response = require_mapping(
        request_json(
            method="GET",
            url=(
                f"{server_url.rstrip('/')}/Users/{encoded_user_identifier}/Items"
                "?Recursive=true&Fields=Path,MediaSources&Limit=10000"
            ),
            token=token,
        ),
        "Items",
    )
    items: list[dict[str, object]] = []
    for item_value in require_array(response.get("Items"), "Items.Items"):
        if isinstance(item_value, dict):
            items.append(cast(dict[str, object], item_value))
    return items


def wait_for_fixture_items(
    fixtures: Sequence[Mapping[str, object]],
    media_directory: Path,
    *,
    server_url: str,
    token: str,
    user_identifier: str,
    timeout_seconds: int,
) -> dict[str, dict[str, str]]:
    """Polls bounded library state until every exact fixture path is indexed."""

    deadline = time.monotonic() + timeout_seconds
    last_error: FixtureDiscoveryPending | None = None
    while time.monotonic() <= deadline:
        try:
            return resolve_fixture_items(
                fixtures,
                read_library_items(server_url, token, user_identifier),
                media_directory,
            )
        except FixtureDiscoveryPending as error:
            last_error = error
            time.sleep(2)
    raise last_error or FixtureDiscoveryPending(
        "Jellyfin did not index the generated static HDR fixtures"
    )


def run_child(arguments: Sequence[str], environment: Mapping[str, str], label: str) -> str:
    """Runs one fixed validation command and returns its standard output."""

    result = subprocess.run(
        list(arguments),
        cwd=REPOSITORY_ROOT,
        env=dict(environment),
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout).strip()
        raise LiveValidationError(f"{label} failed: {diagnostic}")
    return result.stdout


def require_production_probe_result(
    output: str,
    *,
    expected_status: str,
    expected_peak_nits: int,
) -> None:
    """Validates one Mediabunny packet scan using the production TypeScript parser."""

    try:
        probe = require_mapping(json.loads(output), "Static HDR production probe")
    except json.JSONDecodeError as error:
        raise LiveValidationError(
            f"Static HDR production probe returned invalid JSON: {error}"
        ) from error
    result = require_mapping(probe.get("result"), "Static HDR production probe result")
    status = result.get("status")
    access_unit_count = result.get("accessUnitCount")
    first_metadata_index = result.get("firstMetadataAccessUnitIndex")
    scanned_byte_length = probe.get("scannedByteLength")
    if status != expected_status:
        raise LiveValidationError(
            "Static HDR production probe status mismatch: "
            f"expected {expected_status}, received {status}"
        )
    if (
        isinstance(access_unit_count, bool)
        or not isinstance(access_unit_count, int)
        or access_unit_count < 1
        or access_unit_count > MAXIMUM_STATIC_HDR_SCAN_ACCESS_UNIT_COUNT
    ):
        raise LiveValidationError("Static HDR production probe exceeded its access-unit bound")
    if (
        isinstance(scanned_byte_length, bool)
        or not isinstance(scanned_byte_length, int)
        or scanned_byte_length < 1
        or scanned_byte_length > MAXIMUM_STATIC_HDR_SCAN_BYTE_LENGTH
    ):
        raise LiveValidationError("Static HDR production probe exceeded its byte bound")
    expected_first_metadata_index = 0 if expected_status == "valid" else None
    if first_metadata_index != expected_first_metadata_index:
        raise LiveValidationError(
            "Static HDR production probe returned an unexpected first metadata index"
        )
    metadata = result.get("metadata")
    if expected_status != "valid":
        if metadata is not None:
            raise LiveValidationError(
                "Static HDR production probe retained metadata for a rejected state"
            )
        return
    metadata_mapping = require_mapping(metadata, "Static HDR production probe metadata")
    if metadata_mapping.get("masteringDisplayMaximumLuminanceNits") != expected_peak_nits:
        raise LiveValidationError(
            "Static HDR production probe returned an unexpected mastering peak"
        )


def run_production_probe_preflight(
    fixtures: Sequence[Mapping[str, object]],
    resolved: Mapping[str, Mapping[str, str]],
) -> None:
    """Runs the exact production packetizer and parser against every fixture."""

    node_path = shutil.which("node")
    if node_path is None:
        raise LiveValidationError("Node.js is required for the static HDR production probe")
    if not VITE_NODE_PATH.is_file() or not PRODUCTION_PROBE_PATH.is_file():
        raise LiveValidationError("Static HDR production probe tooling is missing")
    probe_environment = os.environ.copy()
    for fixture in fixtures:
        status = cast(str, fixture["expectedStaticHDRMetadataStatus"])
        expected_peak_nits = fixture.get("expectedToneMappingPeakNits")
        if isinstance(expected_peak_nits, bool) or not isinstance(expected_peak_nits, int):
            raise LiveValidationError("Static HDR fixture has no integer tone-mapping peak")
        media_path = resolved[status]["mediaPath"]
        output = run_child(
            (
                node_path,
                str(VITE_NODE_PATH),
                "--script",
                str(PRODUCTION_PROBE_PATH),
                media_path,
            ),
            probe_environment,
            f"Static HDR production probe for {status}",
        )
        require_production_probe_result(
            output,
            expected_status=status,
            expected_peak_nits=expected_peak_nits,
        )


def require_private_values_absent(
    output_directory: Path,
    private_values: Sequence[str],
) -> None:
    """Rejects retained item IDs, paths, tokens, or credentials in result files."""

    encoded_values = [
        value.encode("utf-8") for value in private_values if isinstance(value, str) and value
    ]
    for evidence_path in output_directory.rglob("*"):
        if not evidence_path.is_file():
            continue
        evidence = evidence_path.read_bytes()
        if any(encoded_value in evidence for encoded_value in encoded_values):
            raise LiveValidationError(
                "Private generated-fixture data survived evidence sanitization"
            )


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Resolves local fixtures, generates an overlay, and runs its live matrix."""

    if not arguments.username or not arguments.password:
        raise LiveValidationError(
            "Pass --username/--password or set WEBGPU_SMOKE_USERNAME/WEBGPU_SMOKE_PASSWORD"
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
    license_path = REPOSITORY_ROOT / "LICENSE"
    server_log_directory = Path(arguments.server_log_directory).expanduser().resolve()
    if not live_spec_path.is_file():
        raise LiveValidationError("Generated static HDR live specification is missing")
    if not license_path.is_file():
        raise LiveValidationError("Repository license evidence is missing")
    if not server_log_directory.is_dir():
        raise LiveValidationError("Jellyfin server log directory is missing")

    fixtures = load_fixture_manifest(manifest_path)
    server_url = arguments.server_url.rstrip("/")
    try:
        token, user_identifier = authenticate(
            server_url,
            arguments.username,
            arguments.password,
        )
    except SourceResolutionError as error:
        raise LiveValidationError(str(error)) from error
    if not arguments.skip_library_refresh:
        refresh_library(server_url, token)
    resolved = wait_for_fixture_items(
        fixtures,
        media_directory,
        server_url=server_url,
        token=token,
        user_identifier=user_identifier,
        timeout_seconds=arguments.discovery_timeout_seconds,
    )
    run_production_probe_preflight(fixtures, resolved)

    child_environment = os.environ.copy()
    private_values = [
        arguments.username,
        arguments.password,
        token,
        user_identifier,
    ]
    for fixture in fixtures:
        status = cast(str, fixture["expectedStaticHDRMetadataStatus"])
        environment_suffix = get_source_environment_suffix(
            "valid-4000" if status == "valid" else status
        )
        fixture_resolution = resolved[status]
        child_environment[
            f"WEBGPU_VALIDATION_STATIC_HDR_{environment_suffix}_MEDIA"
        ] = fixture_resolution["mediaPath"]
        child_environment[
            f"WEBGPU_VALIDATION_STATIC_HDR_{environment_suffix}_ITEM_ID"
        ] = fixture_resolution["itemID"]
        private_values.extend(
            [fixture_resolution["mediaPath"], fixture_resolution["itemID"]]
        )
    child_environment["WEBGPU_VALIDATION_STATIC_HDR_LICENSE"] = str(license_path)
    child_environment["WEBGPU_SMOKE_DEBUG_URL"] = arguments.debug_url
    child_environment["WEBGPU_SMOKE_FRONTEND_URL"] = arguments.frontend_url
    child_environment["WEBGPU_SMOKE_PASSWORD"] = arguments.password
    child_environment["WEBGPU_SMOKE_SERVER_LOG_DIRECTORY"] = str(server_log_directory)
    child_environment["WEBGPU_SMOKE_SERVER_URL"] = server_url
    child_environment["WEBGPU_SMOKE_USERNAME"] = arguments.username
    private_values.extend(
        [str(license_path), str(media_directory), str(server_log_directory)]
    )

    overlay_path = Path(arguments.overlay).expanduser().resolve()
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    output_directory = (
        Path(arguments.output).expanduser().resolve()
        if arguments.output
        else DEFAULT_ARTIFACT_DIRECTORY
        / f"static-HDR-live-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
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
        "Static HDR live overlay generation",
    )
    validation_arguments = [
        sys.executable,
        "scripts/webgpu/validation_matrix.py",
        "run",
        "--overlay",
        str(overlay_path),
        "--matrix",
        "private-live",
        "--output",
        str(output_directory),
    ]
    if arguments.selector:
        validation_arguments.extend(["--selector", arguments.selector])
    run_child(
        validation_arguments,
        child_environment,
        "Static HDR live validation matrix",
    )
    require_private_values_absent(output_directory, private_values)
    result_path = output_directory / "result.json"
    result = require_mapping(
        json.loads(result_path.read_text(encoding="utf-8")),
        "Validation result",
    )
    if result.get("status") != "passed":
        raise LiveValidationError("Static HDR live validation did not pass")
    summary = require_mapping(result.get("summary"), "Validation result summary")
    return {
        "failedCases": summary.get("failedCases"),
        "failedChecks": summary.get("failedChecks"),
        "outputName": output_directory.name,
        "passedCases": summary.get("passedCases"),
        "passedChecks": summary.get("passedChecks"),
        "productionProbeCount": len(fixtures),
        "status": "passed",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs generated static-HDR live validation without printing private state."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (LiveValidationError, OSError, json.JSONDecodeError) as error:
        print(f"Static HDR live validation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
