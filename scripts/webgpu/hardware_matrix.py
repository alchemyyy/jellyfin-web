#!/usr/bin/env python3
"""Run the browser/GPU release matrix through the unified live validation tools."""

from __future__ import annotations

import argparse
import copy
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator, Mapping, Sequence, cast

from ab_harness import HarnessError, read_json, write_json


SCHEMA_VERSION = 1
SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parent.parent
VALIDATION_DIRECTORY = SCRIPT_DIRECTORY / "validation"
PLAN_PATH = VALIDATION_DIRECTORY / "hardware-matrix-plan.json"
BROWSER_PROBE_PATH = SCRIPT_DIRECTORY / "hardware-matrix-browser-probe.mjs"
LIVE_RUNNER_PATH = SCRIPT_DIRECTORY / "run_native_HEVC_High_Tier_live_validation.py"
DEFAULT_MEDIA_DIRECTORY = (
    REPOSITORY_ROOT / "artifacts" / "webgpu-validation" / "native-high-tier-repro"
)
DEFAULT_OUTPUT_ROOT = REPOSITORY_ROOT / "artifacts" / "webgpu-hardware-matrix"
DEFAULT_SERVER_URL = "http://localhost:8096"
DEFAULT_FRONTEND_URL = "http://localhost:8096/web/"
DEFAULT_BROWSER_PORTS: Mapping[str, int] = {"chrome": 9324, "edge": 9325}
EXPECTED_BROWSER_PRODUCTS: Mapping[str, tuple[str, ...]] = {
    "chrome": ("Chrome/", "HeadlessChrome/"),
    "edge": ("Edg/", "HeadlessEdg/"),
}
BROWSER_CANDIDATES: Mapping[str, tuple[str, ...]] = {
    "chrome": (
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    ),
    "edge": (
        r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    ),
}
VENDOR_IDENTIFIERS: Mapping[str, frozenset[int]] = {
    "nvidia": frozenset({0x10DE}),
    "amd": frozenset({0x1002}),
    "intel": frozenset({0x8086}),
}
WINDOWS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:[\\/][^\r\n\"'<>|]+")
URL_PATTERN = re.compile(r"\b(?:https?|wss?)://[^\s\"'<>]+", re.IGNORECASE)
SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"\b\"?(?:authorization|cookie|password|token|username)\"?\s*[:=][^\r\n]*",
    re.IGNORECASE,
)
GIT_COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40,64}$")


@dataclass(frozen=True)
class BrowserInstallation:
    """Records one locally installed Chromium browser without publishing its path."""

    executable: Path
    family: str


@dataclass(frozen=True)
class BrowserSession:
    """Records one isolated debugging endpoint and its owned process."""

    debug_url: str
    process: subprocess.Popen[bytes]


class HardwareMatrixError(HarnessError):
    """Reports a fail-closed hardware matrix contract error."""


def require_mapping(value: object, label: str) -> dict[str, object]:
    """Returns one JSON object or raises a precise contract error."""

    if not isinstance(value, dict):
        raise HardwareMatrixError(f"{label} must be an object")
    return cast(dict[str, object], value)


def require_array(value: object, label: str) -> list[object]:
    """Returns one JSON array or raises a precise contract error."""

    if not isinstance(value, list):
        raise HardwareMatrixError(f"{label} must be an array")
    return cast(list[object], value)


def require_string(value: object, label: str) -> str:
    """Returns one nonempty string or raises a precise contract error."""

    if not isinstance(value, str) or not value:
        raise HardwareMatrixError(f"{label} must be a nonempty string")
    return value


def require_exact_keys(
    value: Mapping[str, object],
    *,
    required: frozenset[str],
    optional: frozenset[str],
    label: str,
) -> None:
    """Rejects missing and unknown keys in checked hardware records."""

    keys = frozenset(value)
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise HardwareMatrixError(f"{label} is missing keys: {', '.join(missing)}")
    if unknown:
        raise HardwareMatrixError(f"{label} has unknown keys: {', '.join(unknown)}")


def load_plan(path: Path = PLAN_PATH) -> dict[str, object]:
    """Loads the fixed browser, vendor, exercise, and authorization axes."""

    plan = require_mapping(read_json(path), "Hardware matrix plan")
    require_exact_keys(
        plan,
        required=frozenset(
            {
                "$schema",
                "schemaVersion",
                "browserFamilies",
                "gpuVendors",
                "exerciseIds",
                "authorizationRoutes",
            }
        ),
        optional=frozenset(),
        label="Hardware matrix plan",
    )
    if plan["$schema"] != "hardware-matrix-plan-schema.json":
        raise HardwareMatrixError("Hardware matrix plan schema URI changed")
    if plan["schemaVersion"] != SCHEMA_VERSION:
        raise HardwareMatrixError("Hardware matrix plan schemaVersion changed")
    expected_browsers = ["chrome", "edge"]
    expected_vendors = ["nvidia", "amd", "intel"]
    expected_authorizations = [
        "external-hdr",
        "raw-hdr",
        "external-dolby-vision",
        "raw-dolby-vision",
        "dolby-vision-profile7",
        "dolby-vision-profile7-fel",
    ]
    if plan["browserFamilies"] != expected_browsers:
        raise HardwareMatrixError("Hardware matrix browser axis changed")
    if plan["gpuVendors"] != expected_vendors:
        raise HardwareMatrixError("Hardware matrix GPU axis changed")
    if plan["authorizationRoutes"] != expected_authorizations:
        raise HardwareMatrixError("Hardware matrix authorization axis changed")
    exercises = require_array(plan["exerciseIds"], "Hardware matrix exercises")
    if len(exercises) != len(set(cast(list[str], exercises))) or not exercises:
        raise HardwareMatrixError("Hardware matrix exercises must be unique and nonempty")
    return plan


def expand_path(candidate: str, environment: Mapping[str, str]) -> Path:
    """Expands a Windows-style browser candidate from an explicit environment."""

    expanded = candidate
    for environment_name, environment_value in environment.items():
        expanded = re.sub(
            re.escape(f"%{environment_name}%"),
            lambda _: environment_value,
            expanded,
            flags=re.IGNORECASE,
        )
    return Path(expanded)


def detect_browser_installations(
    environment: Mapping[str, str] | None = None,
) -> dict[str, BrowserInstallation | None]:
    """Finds Chrome and Edge from stable machine and user installation paths."""

    selected_environment = dict(os.environ if environment is None else environment)
    installations: dict[str, BrowserInstallation | None] = {}
    for browser_family, candidates in BROWSER_CANDIDATES.items():
        installation = None
        candidate_paths = [
            expand_path(candidate, selected_environment) for candidate in candidates
        ]
        if browser_family == "edge":
            versioned_paths: list[Path] = []
            for application_directory in {
                candidate_path.parent for candidate_path in candidate_paths
            }:
                if not application_directory.is_dir():
                    continue
                for version_directory in application_directory.iterdir():
                    if not version_directory.is_dir() \
                            or re.fullmatch(r"\d+(?:\.\d+){3}", version_directory.name) is None:
                        continue
                    versioned_executable = version_directory / "msedge.exe"
                    if versioned_executable.is_file():
                        versioned_paths.append(versioned_executable)
            versioned_paths.sort(
                key=lambda path: tuple(int(part) for part in path.parent.name.split(".")),
                reverse=True,
            )
            candidate_paths = [*versioned_paths, *candidate_paths]
        for executable in candidate_paths:
            if executable.is_file():
                installation = BrowserInstallation(executable, browser_family)
                break
        installations[browser_family] = installation
    return installations


def classify_vendor(*records: Mapping[str, object]) -> str | None:
    """Classifies one adapter by PCI vendor ID before bounded text evidence."""

    for record in records:
        vendor_identifier = record.get("vendorId")
        if isinstance(vendor_identifier, int):
            for vendor_name, identifiers in VENDOR_IDENTIFIERS.items():
                if vendor_identifier in identifiers:
                    return vendor_name
    combined_text = " ".join(
        str(record.get(field_name, ""))
        for record in records
        for field_name in (
            "vendor",
            "vendorString",
            "driverVendor",
            "deviceString",
            "name",
            "pnpDeviceID",
            "Name",
            "PNPDeviceID",
        )
    ).lower()
    if "nvidia" in combined_text or "ven_10de" in combined_text:
        return "nvidia"
    if "advanced micro devices" in combined_text or "amd" in combined_text \
            or "ven_1002" in combined_text:
        return "amd"
    if "intel" in combined_text or "ven_8086" in combined_text:
        return "intel"
    return None


def enumerate_windows_video_adapters() -> list[dict[str, object]]:
    """Reads bounded Windows adapter identity used only to mark physical availability."""

    if platform.system() != "Windows":
        return []
    command = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,DriverVersion,PNPDeviceID,Status | "
        "ConvertTo-Json -Compress"
    )
    try:
        completed_process = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed_process.returncode != 0 or not completed_process.stdout.strip():
        return []
    try:
        value = json.loads(completed_process.stdout)
    except json.JSONDecodeError:
        return []
    records = value if isinstance(value, list) else [value]
    return [dict(record) for record in records if isinstance(record, dict)]


def get_physical_vendors(adapter_records: Sequence[Mapping[str, object]]) -> set[str]:
    """Returns only explicitly observed NVIDIA, AMD, and Intel adapters."""

    vendors: set[str] = set()
    for adapter_record in adapter_records:
        vendor = classify_vendor(adapter_record)
        if vendor is not None:
            vendors.add(vendor)
    return vendors


def read_short_command(arguments: Sequence[str]) -> str:
    """Runs one bounded metadata command without exposing diagnostics."""

    try:
        completed_process = subprocess.run(
            list(arguments),
            capture_output=True,
            check=False,
            cwd=REPOSITORY_ROOT,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    if completed_process.returncode != 0:
        return "unknown"
    return completed_process.stdout.strip().splitlines()[0]


def capture_repository() -> dict[str, object]:
    """Captures the same bounded repository identity as validation_matrix.py."""

    commit = read_short_command(("git", "rev-parse", "HEAD"))
    if GIT_COMMIT_PATTERN.fullmatch(commit) is None:
        commit = "0" * 40
    dirty = read_short_command(("git", "status", "--porcelain")) not in {"", "unknown"}
    return {"commit": commit, "dirty": dirty}


def wait_for_debug_endpoint(debug_url: str, process: subprocess.Popen[bytes]) -> None:
    """Waits for one isolated Chromium endpoint or fails with no process output."""

    deadline = time.monotonic() + 45
    version_url = f"{debug_url.rstrip('/')}/json/version"
    last_error: Exception | None = None
    while time.monotonic() <= deadline:
        if process.poll() is not None:
            raise HardwareMatrixError("Browser exited before CDP became available")
        try:
            with urllib.request.urlopen(version_url, timeout=2) as response:
                if 200 <= response.status < 400:
                    return
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(0.25)
    raise HardwareMatrixError(
        "Browser CDP did not become available"
        + (f": {type(last_error).__name__}" if last_error else "")
    )


@contextmanager
def launch_browser(
    installation: BrowserInstallation,
    *,
    port: int,
    profile_directory: Path,
    frontend_url: str,
) -> Iterator[BrowserSession]:
    """Launches and reliably closes one isolated headless hardware browser."""

    profile_directory.mkdir(parents=True, exist_ok=True)
    arguments = [
        str(installation.executable),
        "--headless=new",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_directory}",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-background-networking",
        "--window-size=1280,720",
        frontend_url,
    ]
    creation_flags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if platform.system() == "Windows"
        else 0
    )
    process = subprocess.Popen(
        arguments,
        cwd=REPOSITORY_ROOT,
        creationflags=creation_flags,
        stderr=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
    debug_url = f"http://localhost:{port}"
    try:
        wait_for_debug_endpoint(debug_url, process)
        yield BrowserSession(debug_url, process)
    finally:
        if platform.system() == "Windows" and process.poll() is None:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                check=False,
                timeout=30,
            )
        elif process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=15)


def run_json_command(
    arguments: Sequence[str],
    *,
    environment: Mapping[str, str] | None = None,
    timeout_seconds: int,
    label: str,
) -> dict[str, object]:
    """Runs one fixed JSON command and returns only its parsed object."""

    completed_process = subprocess.run(
        list(arguments),
        capture_output=True,
        check=False,
        cwd=REPOSITORY_ROOT,
        encoding="utf-8",
        env=None if environment is None else dict(environment),
        errors="replace",
        timeout=timeout_seconds,
    )
    if completed_process.returncode != 0:
        diagnostic = sanitize_diagnostic(
            f"{completed_process.stderr}\n{completed_process.stdout}".strip()
        )
        suffix = f": {diagnostic}" if diagnostic else ""
        raise HardwareMatrixError(
            f"{label} failed with exit code {completed_process.returncode}{suffix}"
        )
    try:
        return require_mapping(json.loads(completed_process.stdout), label)
    except json.JSONDecodeError as error:
        raise HardwareMatrixError(f"{label} did not emit one JSON object") from error


def run_browser_probe(
    *,
    debug_url: str,
    frontend_url: str,
    output_path: Path,
) -> dict[str, object]:
    """Captures browser, driver, WebGPU, and configuration support evidence."""

    node_path = shutil.which("node")
    if node_path is None or not BROWSER_PROBE_PATH.is_file():
        raise HardwareMatrixError("Node or the browser hardware probe is missing")
    result = run_json_command(
        (node_path, str(BROWSER_PROBE_PATH), debug_url, frontend_url),
        timeout_seconds=120,
        label="Browser hardware probe",
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(output_path, result)
    return result


def prepare_live_spec(
    source_path: Path,
    output_path: Path,
    exercise_ids: Sequence[str],
) -> None:
    """Copies one checked source record and selects the hardware release exercises."""

    specification = require_mapping(read_json(source_path), "Hardware live specification")
    sources = require_array(specification.get("sources"), "Hardware live sources")
    if len(sources) != 1:
        raise HardwareMatrixError("Hardware live specification must contain one source")
    source = require_mapping(sources[0], "Hardware live source")
    selected_source = copy.deepcopy(source)
    selected_source["exerciseIds"] = list(exercise_ids)
    selected_specification = copy.deepcopy(specification)
    selected_specification["sources"] = [selected_source]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(output_path, selected_specification)


def run_live_validation(
    *,
    debug_url: str,
    frontend_url: str,
    media_directory: Path,
    live_spec_path: Path,
    output_directory: Path,
    overlay_path: Path,
    server_url: str,
    server_log_directory: Path,
    username: str,
    password: str,
) -> tuple[dict[str, object], bool]:
    """Runs every selected cell exercise through validation_matrix.py."""

    child_environment = os.environ.copy()
    child_environment.update(
        {
            "WEBGPU_SMOKE_DEBUG_URL": debug_url,
            "WEBGPU_SMOKE_FRONTEND_URL": frontend_url,
            "WEBGPU_SMOKE_PASSWORD": password,
            "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY": str(server_log_directory),
            "WEBGPU_SMOKE_SERVER_URL": server_url,
            "WEBGPU_SMOKE_USERNAME": username,
        }
    )
    arguments = [
        sys.executable,
        str(LIVE_RUNNER_PATH),
        "--media-directory",
        str(media_directory),
        "--live-spec",
        str(live_spec_path),
        "--overlay",
        str(overlay_path),
        "--output",
        str(output_directory),
        "--server-url",
        server_url,
        "--frontend-url",
        frontend_url,
        "--debug-url",
        debug_url,
        "--server-log-directory",
        str(server_log_directory),
    ]
    completed_process = subprocess.run(
        arguments,
        capture_output=True,
        check=False,
        cwd=REPOSITORY_ROOT,
        encoding="utf-8",
        env=child_environment,
        errors="replace",
        timeout=14_400,
    )
    runner_diagnostic = sanitize_diagnostic(
        f"{completed_process.stderr}\n{completed_process.stdout}".strip()
    )
    write_json(
        output_directory.parent / "live-runner.json",
        {
            "exitCode": completed_process.returncode,
            "reason": runner_diagnostic,
            "schemaVersion": SCHEMA_VERSION,
            "status": "passed" if completed_process.returncode == 0 else "failed",
        },
    )
    result_path = output_directory / "result.json"
    if not result_path.is_file():
        return {}, False
    result = require_mapping(read_json(result_path), "Live validation result")
    return result, completed_process.returncode == 0 and result.get("status") == "passed"


def artifact_uri(relative_path: str) -> str:
    """Returns a machine-independent link within the ignored output directory."""

    return f"artifact://{relative_path.replace(os.sep, '/')}"


def create_status_record(status: str, evidence: str | None = None) -> dict[str, object]:
    """Creates one schema-stable exercise or authorization disposition."""

    return {"status": status, "evidence": evidence}


def create_empty_records(
    identifiers: Sequence[str],
    status: str = "not-run",
) -> dict[str, dict[str, object]]:
    """Creates explicit non-pass records for an unavailable matrix cell."""

    return {
        identifier: create_status_record(status)
        for identifier in identifiers
    }


def find_lifecycle_evidence(
    live_result: Mapping[str, object],
    result_directory: Path,
) -> tuple[dict[str, object], str] | None:
    """Loads the source lifecycle smoke evidence selected by the unified result."""

    checks = require_array(live_result.get("checks", []), "Live validation checks")
    for check_value in checks:
        check = require_mapping(check_value, "Live validation check")
        check_identifier = check.get("id")
        evidence_path = check.get("evidence")
        if (
            isinstance(check_identifier, str)
            and check_identifier.endswith("-lifecycle-check")
            and isinstance(evidence_path, str)
        ):
            resolved_evidence = result_directory / evidence_path
            if resolved_evidence.is_file():
                return (
                    require_mapping(read_json(resolved_evidence), "Lifecycle evidence"),
                    artifact_uri(f"live-validation/{evidence_path}"),
                )
    return None


def extract_playback_snapshot(evidence: Mapping[str, object]) -> dict[str, object]:
    """Returns active or final bounded playback state from browser-smoke evidence."""

    observations = evidence.get("observations")
    if isinstance(observations, dict) and isinstance(observations.get("playback"), dict):
        return cast(dict[str, object], observations["playback"])
    diagnostics = evidence.get("diagnostics")
    if isinstance(diagnostics, dict):
        last_observation = diagnostics.get("lastObservation")
        if isinstance(last_observation, dict) \
                and isinstance(last_observation.get("snapshot"), dict):
            return cast(dict[str, object], last_observation["snapshot"])
    return {}


def authorization_status(
    telemetry: object,
    evidence_uri: str,
) -> dict[str, object]:
    """Converts exact-device authorization telemetry without treating absence as pass."""

    if not isinstance(telemetry, dict):
        return create_status_record("not-run")
    status = telemetry.get("status")
    pending_routes = telemetry.get("pendingRouteKeys", [])
    rejected_routes = telemetry.get("rejectedRouteKeys", [])
    passed = status == "authorized" \
        and (not isinstance(pending_routes, list) or not pending_routes) \
        and (not isinstance(rejected_routes, list) or not rejected_routes)
    return create_status_record("passed" if passed else "failed", evidence_uri)


def extract_authorizations(
    snapshot: Mapping[str, object],
    evidence_uri: str,
) -> dict[str, dict[str, object]]:
    """Extracts all prewarmed external, raw, and Dolby Vision exact-device routes."""

    return {
        "external-hdr": authorization_status(
            snapshot.get("externalHDRValidation"), evidence_uri
        ),
        "raw-hdr": authorization_status(
            snapshot.get("settledRawHDRValidation"), evidence_uri
        ),
        "external-dolby-vision": authorization_status(
            snapshot.get("externalDolbyVisionValidation"), evidence_uri
        ),
        "raw-dolby-vision": authorization_status(
            snapshot.get("settledRawDolbyVisionValidation"), evidence_uri
        ),
        "dolby-vision-profile7": authorization_status(
            snapshot.get("profile7DolbyVisionValidation"), evidence_uri
        ),
        "dolby-vision-profile7-fel": authorization_status(
            snapshot.get("profile7FELDolbyVisionValidation"), evidence_uri
        ),
    }


def extract_exercises(
    live_result: Mapping[str, object],
    exercise_ids: Sequence[str],
) -> dict[str, dict[str, object]]:
    """Maps every requested live case to passed, failed, or explicit not-run."""

    case_records = require_array(live_result.get("cases", []), "Live validation cases")
    results: dict[str, dict[str, object]] = {}
    for exercise_identifier in exercise_ids:
        matching_case = None
        for case_value in case_records:
            case = require_mapping(case_value, "Live validation case")
            case_identifier = case.get("id")
            if isinstance(case_identifier, str) \
                    and case_identifier.endswith(f"-{exercise_identifier}"):
                matching_case = case
                break
        if matching_case is None:
            results[exercise_identifier] = create_status_record("not-run")
            continue
        case_identifier = cast(str, matching_case["id"])
        case_status = "passed" if matching_case.get("status") == "passed" else "failed"
        results[exercise_identifier] = create_status_record(
            case_status,
            artifact_uri(f"live-validation/result.json#case={case_identifier}"),
        )
    return results


def primary_CDP_device(probe: Mapping[str, object]) -> dict[str, object]:
    """Returns the hardware device matching the WebGPU adapter when possible."""

    GPU = require_mapping(probe.get("gpu"), "Browser probe GPU")
    CDP = require_mapping(GPU.get("CDP"), "Browser probe CDP GPU")
    devices = require_array(CDP.get("devices", []), "Browser probe CDP devices")
    adapter = require_mapping(GPU.get("adapter"), "Browser probe adapter")
    adapter_vendor = classify_vendor(adapter)
    for device_value in devices:
        device = require_mapping(device_value, "Browser probe CDP device")
        if classify_vendor(device) == adapter_vendor:
            return device
    if devices:
        return require_mapping(devices[0], "Browser probe primary CDP device")
    return {}


def create_adapter_record(probe: Mapping[str, object]) -> dict[str, object]:
    """Combines WebGPU adapter identity with the matching CDP driver."""

    GPU = require_mapping(probe.get("gpu"), "Browser probe GPU")
    adapter = require_mapping(GPU.get("adapter"), "Browser probe adapter")
    CDP_device = primary_CDP_device(probe)
    return {
        "vendor": str(adapter.get("vendor", "not-exposed")),
        "architecture": str(adapter.get("architecture", "not-exposed")),
        "description": str(adapter.get("description", "not-exposed")),
        "device": str(CDP_device.get("deviceString", adapter.get("device", "not-exposed"))),
        "isFallbackAdapter": adapter.get("isFallbackAdapter") is True,
        "driverVendor": str(CDP_device.get("driverVendor", "not-exposed")),
        "driverVersion": str(CDP_device.get("driverVersion", "not-exposed")),
    }


def create_webGPU_record(probe: Mapping[str, object]) -> dict[str, object]:
    """Copies complete exposed adapter/device features and numeric limits."""

    GPU = require_mapping(probe.get("gpu"), "Browser probe GPU")
    adapter = require_mapping(GPU.get("adapter"), "Browser probe adapter")
    device = require_mapping(GPU.get("device"), "Browser probe device")
    CDP = require_mapping(GPU.get("CDP"), "Browser probe CDP GPU")
    return {
        "canvasFormat": str(GPU.get("canvasFormat", "unavailable")),
        "adapterFeatures": sorted(cast(list[str], adapter.get("features", []))),
        "adapterLimits": dict(cast(dict[str, object], adapter.get("limits", {}))),
        "deviceFeatures": sorted(cast(list[str], device.get("features", []))),
        "deviceLimits": dict(cast(dict[str, object], device.get("limits", {}))),
        "featureStatus": dict(cast(dict[str, object], CDP.get("featureStatus", {}))),
    }


def create_unavailable_cell(
    *,
    browser_family: str,
    browser_availability: str,
    browser_product: str | None,
    browser_protocol: str | None,
    browser_version: str | None,
    disposition: str,
    GPU_vendor: str,
    plan: Mapping[str, object],
    status: str = "not-run",
) -> dict[str, object]:
    """Creates one explicit unavailable browser/vendor cell with no inferred passes."""

    return {
        "id": f"{browser_family}-{GPU_vendor}",
        "browser": {
            "family": browser_family,
            "availability": browser_availability,
            "version": browser_version,
            "product": browser_product,
            "protocolVersion": browser_protocol,
        },
        "gpuVendor": GPU_vendor,
        "status": status,
        "dispositionCode": disposition,
        "adapter": None,
        "webGPU": None,
        "nativeCodecConfigurations": None,
        "productionCapabilities": None,
        "authorizations": create_empty_records(
            cast(list[str], plan["authorizationRoutes"])
        ),
        "exercises": create_empty_records(cast(list[str], plan["exerciseIds"])),
    }


def execute_browser_cell(
    *,
    installation: BrowserInstallation,
    plan: Mapping[str, object],
    physical_vendors: set[str],
    output_root: Path,
    media_directory: Path,
    source_live_spec_path: Path,
    frontend_url: str,
    server_url: str,
    server_log_directory: Path | None,
    username: str | None,
    password: str | None,
    probe_only: bool,
    reuse_live_results: bool,
) -> tuple[dict[str, object], dict[str, object]]:
    """Runs the selected adapter cell and returns it with reusable browser identity."""

    browser_family = installation.family
    browser_root = output_root / browser_family
    probe_path = browser_root / "runtime-probe.json"
    profile_directory = browser_root / "browser-profile"
    debug_port = DEFAULT_BROWSER_PORTS[browser_family]
    with launch_browser(
        installation,
        port=debug_port,
        profile_directory=profile_directory,
        frontend_url=frontend_url,
    ) as session:
        probe = run_browser_probe(
            debug_url=session.debug_url,
            frontend_url=frontend_url,
            output_path=probe_path,
        )
        browser = require_mapping(probe.get("browser"), "Browser probe identity")
        product = require_string(browser.get("product"), "Browser probe product")
        if not any(token in product for token in EXPECTED_BROWSER_PRODUCTS[browser_family]):
            raise HardwareMatrixError(
                f"{browser_family} endpoint returned an unexpected browser product"
            )
        adapter_record = create_adapter_record(probe)
        GPU = require_mapping(probe.get("gpu"), "Browser probe GPU")
        adapter = require_mapping(GPU.get("adapter"), "Browser probe adapter")
        CDP_device = primary_CDP_device(probe)
        selected_vendor = classify_vendor(adapter, CDP_device)
        if selected_vendor is None:
            raise HardwareMatrixError("Unable to classify the selected WebGPU adapter")
        browser_identity = {
            "availability": "installed",
            "product": product,
            "protocolVersion": str(browser.get("protocolVersion", "unknown")),
            "version": product.split("/", maxsplit=1)[-1],
        }
        authorization_records = create_empty_records(
            cast(list[str], plan["authorizationRoutes"])
        )
        exercise_records = create_empty_records(cast(list[str], plan["exerciseIds"]))
        production_capabilities = None
        status = "not-run"
        disposition = "live-input-unavailable"
        if probe.get("status") != "ready" or adapter_record["isFallbackAdapter"] is True:
            status = "unsupported"
            disposition = "webgpu-unavailable"
            authorization_records = create_empty_records(
                cast(list[str], plan["authorizationRoutes"]), "unsupported"
            )
            exercise_records = create_empty_records(
                cast(list[str], plan["exerciseIds"]), "unsupported"
            )
        elif selected_vendor not in physical_vendors:
            status = "unsupported"
            disposition = "adapter-vendor-mismatch"
        elif not probe_only and username and password and server_log_directory:
            live_spec_path = browser_root / "hardware-live-spec.json"
            live_output_directory = browser_root / "live-validation"
            prepare_live_spec(
                source_live_spec_path,
                live_spec_path,
                cast(list[str], plan["exerciseIds"]),
            )
            existing_result_path = live_output_directory / "result.json"
            if reuse_live_results and existing_result_path.is_file():
                live_result = require_mapping(
                    read_json(existing_result_path), "Reused live validation result"
                )
                live_passed = live_result.get("status") == "passed"
            else:
                live_result, live_passed = run_live_validation(
                    debug_url=session.debug_url,
                    frontend_url=frontend_url,
                    media_directory=media_directory,
                    live_spec_path=live_spec_path,
                    output_directory=live_output_directory,
                    overlay_path=browser_root / "private-live-overlay.json",
                    server_url=server_url,
                    server_log_directory=server_log_directory,
                    username=username,
                    password=password,
                )
            exercise_records = extract_exercises(
                live_result,
                cast(list[str], plan["exerciseIds"]),
            )
            lifecycle = find_lifecycle_evidence(live_result, live_output_directory)
            if lifecycle is not None:
                lifecycle_evidence, lifecycle_uri = lifecycle
                snapshot = extract_playback_snapshot(lifecycle_evidence)
                authorization_records = extract_authorizations(snapshot, lifecycle_uri)
                capabilities = snapshot.get("customDecodeCapabilities")
                if isinstance(capabilities, dict):
                    production_capabilities = capabilities
            all_exercises_passed = all(
                record["status"] == "passed" for record in exercise_records.values()
            )
            all_authorizations_passed = all(
                record["status"] == "passed"
                for record in authorization_records.values()
            )
            status = (
                "passed"
                if live_passed and all_exercises_passed and all_authorizations_passed
                else "failed"
            )
            disposition = "validated" if status == "passed" else "validation-failed"

        cell = {
            "id": f"{browser_family}-{selected_vendor}",
            "browser": {
                "family": browser_family,
                **browser_identity,
            },
            "gpuVendor": selected_vendor,
            "status": status,
            "dispositionCode": disposition,
            "adapter": adapter_record,
            "webGPU": create_webGPU_record(probe),
            "nativeCodecConfigurations": probe.get("codecs"),
            "productionCapabilities": production_capabilities,
            "authorizations": authorization_records,
            "exercises": exercise_records,
        }
        return cell, browser_identity


def validate_result(result: Mapping[str, object]) -> None:
    """Validates cross-field completeness and rejects private report content."""

    require_exact_keys(
        result,
        required=frozenset(
            {
                "$schema",
                "schemaVersion",
                "generatedAtUTC",
                "repository",
                "host",
                "plan",
                "coverage",
                "cells",
            }
        ),
        optional=frozenset(),
        label="Hardware matrix result",
    )
    if result["$schema"] != (
        "scripts/webgpu/validation/hardware-matrix-result-schema.json"
    ):
        raise HardwareMatrixError("Hardware result schema URI changed")
    if result["schemaVersion"] != SCHEMA_VERSION:
        raise HardwareMatrixError("Hardware result schemaVersion changed")
    plan = require_mapping(result["plan"], "Hardware result plan")
    cells = require_array(result["cells"], "Hardware result cells")
    expected_cell_ids = {
        f"{browser_family}-{GPU_vendor}"
        for browser_family in cast(list[str], plan["browserFamilies"])
        for GPU_vendor in cast(list[str], plan["gpuVendors"])
    }
    actual_cell_ids = {
        require_string(require_mapping(cell, "Hardware cell").get("id"), "Hardware cell ID")
        for cell in cells
    }
    if actual_cell_ids != expected_cell_ids or len(cells) != len(expected_cell_ids):
        raise HardwareMatrixError("Hardware result does not cover each browser/vendor cell once")
    status_counts = {"passed": 0, "failed": 0, "unsupported": 0, "not-run": 0}
    for cell_value in cells:
        cell = require_mapping(cell_value, "Hardware cell")
        status = require_string(cell.get("status"), "Hardware cell status")
        if status not in status_counts:
            raise HardwareMatrixError(f"Unknown hardware cell status: {status}")
        status_counts[status] += 1
        if status == "passed":
            adapter = require_mapping(cell.get("adapter"), "Passed hardware adapter")
            if adapter.get("isFallbackAdapter") is True:
                raise HardwareMatrixError("A fallback adapter cannot pass a hardware cell")
            if classify_vendor(adapter) != cell.get("gpuVendor"):
                raise HardwareMatrixError("Passed cell adapter vendor does not match its axis")
            for record_group_name in ("authorizations", "exercises"):
                records = require_mapping(cell.get(record_group_name), record_group_name)
                if any(
                    require_mapping(record, record_group_name).get("status") != "passed"
                    for record in records.values()
                ):
                    raise HardwareMatrixError(
                        f"Passed cell has an incomplete {record_group_name} record"
                    )
    coverage = require_mapping(result["coverage"], "Hardware result coverage")
    expected_coverage = {
        "total": len(cells),
        "passed": status_counts["passed"],
        "failed": status_counts["failed"],
        "unsupported": status_counts["unsupported"],
        "notRun": status_counts["not-run"],
    }
    if coverage != expected_coverage:
        raise HardwareMatrixError("Hardware result coverage does not match its cells")
    serialized_result = json.dumps(result, sort_keys=True)
    if WINDOWS_PATH_PATTERN.search(serialized_result):
        raise HardwareMatrixError("Hardware result contains a machine path")
    if URL_PATTERN.search(serialized_result):
        raise HardwareMatrixError("Hardware result contains a network URL")
    if SECRET_ASSIGNMENT_PATTERN.search(serialized_result):
        raise HardwareMatrixError("Hardware result contains secret-shaped content")


def sanitize_diagnostic(value: str) -> str:
    """Bounds and redacts one local failure reason before persisting it."""

    sanitized = WINDOWS_PATH_PATTERN.sub("[redacted-path]", value[-2_000:])
    sanitized = URL_PATTERN.sub("[redacted-url]", sanitized)
    return SECRET_ASSIGNMENT_PATTERN.sub("[redacted-secret]", sanitized)


def create_summary(result: Mapping[str, object]) -> str:
    """Creates a concise Markdown coverage table from the authoritative JSON."""

    lines = [
        "# WebGPU hardware matrix result",
        "",
        "| Browser | GPU | Status | Disposition |",
        "| --- | --- | --- | --- |",
    ]
    for cell_value in cast(list[object], result["cells"]):
        cell = cast(dict[str, object], cell_value)
        browser = cast(dict[str, object], cell["browser"])
        lines.append(
            f"| {browser['family']} {browser['version'] or 'unavailable'} "
            f"| {cell['gpuVendor']} | {cell['status']} | {cell['dispositionCode']} |"
        )
    coverage = cast(dict[str, object], result["coverage"])
    lines.extend(
        [
            "",
            f"Passed: {coverage['passed']}; failed: {coverage['failed']}; "
            f"unsupported: {coverage['unsupported']}; not run: {coverage['notRun']}.",
            "",
        ]
    )
    return "\n".join(lines)


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Executes every physically addressable browser/GPU cell on this host."""

    plan = load_plan(Path(arguments.plan).resolve())
    installations = detect_browser_installations()
    physical_adapters = enumerate_windows_video_adapters()
    physical_vendors = get_physical_vendors(physical_adapters)
    output_root = Path(arguments.output).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    media_directory = Path(arguments.media_directory).expanduser().resolve()
    source_live_spec_path = Path(arguments.live_spec).expanduser().resolve()
    server_log_directory = (
        Path(arguments.server_log_directory).expanduser().resolve()
        if arguments.server_log_directory
        else None
    )
    cells_by_identifier: dict[str, dict[str, object]] = {}
    browser_identities: dict[str, dict[str, object]] = {}

    for browser_family in cast(list[str], plan["browserFamilies"]):
        installation = installations[browser_family]
        if installation is None:
            continue
        try:
            cell, browser_identity = execute_browser_cell(
                installation=installation,
                plan=plan,
                physical_vendors=physical_vendors,
                output_root=output_root,
                media_directory=media_directory,
                source_live_spec_path=source_live_spec_path,
                frontend_url=arguments.frontend_url,
                server_url=arguments.server_url,
                server_log_directory=server_log_directory,
                username=arguments.username,
                password=arguments.password,
                probe_only=arguments.probe_only,
                reuse_live_results=arguments.reuse_live_results,
            )
            cells_by_identifier[cast(str, cell["id"])] = cell
            browser_identities[browser_family] = browser_identity
        except (HardwareMatrixError, OSError, subprocess.TimeoutExpired) as error:
            error_path = output_root / browser_family / "probe-error.json"
            error_path.parent.mkdir(parents=True, exist_ok=True)
            write_json(
                error_path,
                {
                    "errorType": type(error).__name__,
                    "reason": sanitize_diagnostic(str(error)),
                    "schemaVersion": SCHEMA_VERSION,
                    "stage": "browser-cell",
                },
            )
            browser_identities[browser_family] = {
                "availability": "installed",
                "product": None,
                "protocolVersion": None,
                "version": None,
            }

    cells: list[dict[str, object]] = []
    for browser_family in cast(list[str], plan["browserFamilies"]):
        installation = installations[browser_family]
        identity = browser_identities.get(
            browser_family,
            {
                "availability": "unavailable",
                "product": None,
                "protocolVersion": None,
                "version": None,
            },
        )
        for GPU_vendor in cast(list[str], plan["gpuVendors"]):
            cell_identifier = f"{browser_family}-{GPU_vendor}"
            observed_cell = cells_by_identifier.get(cell_identifier)
            if observed_cell is not None:
                cells.append(observed_cell)
                continue
            if installation is None:
                disposition = "browser-unavailable"
                cell_status = "not-run"
            elif GPU_vendor not in physical_vendors:
                disposition = "hardware-unavailable"
                cell_status = "not-run"
            elif any(
                cell["browser"]["family"] == browser_family
                for cell in cells_by_identifier.values()
            ):
                disposition = "adapter-vendor-mismatch"
                cell_status = "unsupported"
            else:
                disposition = "probe-failed"
                cell_status = "failed"
            cells.append(
                create_unavailable_cell(
                    browser_family=browser_family,
                    browser_availability=cast(str, identity["availability"]),
                    browser_product=cast(str | None, identity["product"]),
                    browser_protocol=cast(str | None, identity["protocolVersion"]),
                    browser_version=cast(str | None, identity["version"]),
                    disposition=disposition,
                    GPU_vendor=GPU_vendor,
                    plan=plan,
                    status=cell_status,
                )
            )

    status_counts = {
        status: sum(1 for cell in cells if cell["status"] == status)
        for status in ("passed", "failed", "unsupported", "not-run")
    }
    result = {
        "$schema": "scripts/webgpu/validation/hardware-matrix-result-schema.json",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAtUTC": datetime.now(UTC).isoformat(),
        "repository": capture_repository(),
        "host": {
            "architecture": platform.machine() or "unknown",
            "operatingSystem": platform.system() or "unknown",
            "release": platform.release() or "unknown",
        },
        "plan": {
            key: copy.deepcopy(plan[key])
            for key in (
                "browserFamilies",
                "gpuVendors",
                "exerciseIds",
                "authorizationRoutes",
            )
        },
        "coverage": {
            "total": len(cells),
            "passed": status_counts["passed"],
            "failed": status_counts["failed"],
            "unsupported": status_counts["unsupported"],
            "notRun": status_counts["not-run"],
        },
        "cells": cells,
    }
    validate_result(result)
    write_json(output_root / "result.json", result)
    (output_root / "summary.md").write_text(
        create_summary(result), encoding="utf-8", newline="\n"
    )
    return result


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the hardware matrix CLI."""

    default_log_directory = (
        Path(os.environ["LOCALAPPDATA"]) / "jellyfin" / "log"
        if os.environ.get("LOCALAPPDATA")
        else None
    )
    default_output = DEFAULT_OUTPUT_ROOT / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    parser = argparse.ArgumentParser(
        description="Run Chrome/Edge x NVIDIA/AMD/Intel WebGPU release coverage."
    )
    parser.add_argument("--plan", default=str(PLAN_PATH))
    parser.add_argument("--media-directory", default=str(DEFAULT_MEDIA_DIRECTORY))
    parser.add_argument(
        "--live-spec",
        default=str(DEFAULT_MEDIA_DIRECTORY / "native-HEVC-High-Tier-live-spec.json"),
    )
    parser.add_argument("--output", default=str(default_output))
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WEBGPU_SMOKE_SERVER_URL", DEFAULT_SERVER_URL),
    )
    parser.add_argument(
        "--frontend-url",
        default=os.environ.get("WEBGPU_SMOKE_FRONTEND_URL", DEFAULT_FRONTEND_URL),
    )
    parser.add_argument(
        "--server-log-directory",
        default=os.environ.get(
            "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY",
            str(default_log_directory) if default_log_directory else None,
        ),
    )
    parser.add_argument("--username", default=os.environ.get("WEBGPU_SMOKE_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("WEBGPU_SMOKE_PASSWORD"))
    parser.add_argument(
        "--probe-only",
        action="store_true",
        help="Record runtime evidence but mark live exercises not run",
    )
    parser.add_argument(
        "--reuse-live-results",
        action="store_true",
        help="Reassemble an output after verifying its existing live result files",
    )
    return parser


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the matrix and prints only sanitized coverage counts."""

    arguments = create_argument_parser().parse_args(command_arguments)
    if not arguments.probe_only and (
        not arguments.username
        or not arguments.password
        or not arguments.server_log_directory
    ):
        print(
            "Hardware matrix requires smoke credentials and a server log directory",
            file=sys.stderr,
        )
        return 2
    try:
        result = execute(arguments)
    except (HardwareMatrixError, OSError, json.JSONDecodeError) as error:
        print(f"Hardware matrix failed: {error}", file=sys.stderr)
        return 1
    coverage = cast(dict[str, object], result["coverage"])
    print(json.dumps({"coverage": coverage, "status": "complete"}, indent=2))
    return 0 if coverage["failed"] == 0 and coverage["unsupported"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
