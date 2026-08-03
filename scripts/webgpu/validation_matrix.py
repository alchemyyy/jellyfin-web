#!/usr/bin/env python3
"""Run versioned, fail-closed WebGPU validation matrices."""

from __future__ import annotations

import argparse
import html
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence, cast

from ab_harness import (
    HarnessError,
    calculate_sha256,
    command_for_report,
    read_json,
    require_integer,
    require_mapping,
    require_string,
    run_command,
    write_json,
)
from validation_baseline import (
    approve_baseline,
    baseline_report_uri,
    compare_baseline,
    load_baseline,
)


SCHEMA_VERSION = 1
SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parent.parent
VALIDATION_DIRECTORY = SCRIPT_DIRECTORY / "validation"
DEFAULT_MANIFEST_PATH = VALIDATION_DIRECTORY / "manifest.json"
DEFAULT_OUTPUT_ROOT = REPOSITORY_ROOT / "artifacts" / "webgpu-validation"
IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TAG_PATTERN = re.compile(
    r"^(?:[a-z0-9][a-z0-9-]{0,31})(?::[a-z0-9][a-z0-9.-]{0,63})?$"
)
ENVIRONMENT_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
GIT_COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40,64}$")
URL_PATTERN = re.compile(r"\b(?:https?|wss?)://[^\s\"'<>]+", re.IGNORECASE)
QUERY_SECRET_PATTERN = re.compile(
    r"([?&](?:api_key|token|access_token)=)[^&#\s]+",
    re.IGNORECASE,
)
SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"\b(password|username|authorization|token|access[_-]?token|api[_-]?key|cookie)"
    r"\s*[:=]\s*[^\s,;]+",
    re.IGNORECASE,
)
WINDOWS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:[\\/][^\r\n\"'<>|]+")
MAXIMUM_DIAGNOSTIC_CHARACTERS = 24_000
MAXIMUM_TIMEOUT_SECONDS = 7_200
ALLOWED_ADAPTERS = frozenset(
    {
        "artifact-verifier",
        "browser-smoke",
        "eslint",
        "mpv-ab",
        "node-script",
        "node-test",
        "python-script",
        "python-unittest",
        "stylelint",
        "toolchain-probe",
        "typescript",
        "vite-node",
        "vitest",
        "webpack-development",
        "webpack-production",
        "worker-smoke",
    }
)
ENVIRONMENT_ARGUMENT_OPTIONS: Mapping[str, frozenset[str]] = {
    "browser-smoke": frozenset(),
    "mpv-ab": frozenset(
        {"--ffmpeg", "--manifest", "--mpv", "--node", "--output", "--source"}
    ),
    "toolchain-probe": frozenset(
        {"--debug-url", "--ffmpeg", "--frontend-url", "--mpv", "--node"}
    ),
    "worker-smoke": frozenset(
        {"--debug-url", "--frontend-url", "--media-url", "--worker-url"}
    ),
}
SENSITIVE_KEY_PARTS = (
    "authorization",
    "cookie",
    "itemid",
    "password",
    "token",
    "username",
)


@dataclass(frozen=True)
class ValidationManifest:
    """Contains normalized validation registries and the failure vocabulary."""

    cases: Mapping[str, dict[str, object]]
    checks: Mapping[str, dict[str, object]]
    failure_codes: Mapping[str, str]
    fixtures: Mapping[str, dict[str, object]]
    manifest_path: Path
    manifest_sha256: str
    matrices: Mapping[str, dict[str, object]]
    overlay_sha256: str | None


@dataclass(frozen=True)
class ValidationSelection:
    """Records one deterministic matrix expansion after filtering and deduplication."""

    case_ids: tuple[str, ...]
    check_ids: tuple[str, ...]
    fixture_ids: tuple[str, ...]
    matrix_id: str
    selectors: tuple[str, ...]
    superseded_checks: Mapping[str, str]


@dataclass(frozen=True)
class CommandSpecification:
    """Contains one fixed subprocess argument vector and its checked timeout."""

    arguments: tuple[str, ...]
    timeout_seconds: int


# Manifest schema


def require_exact_keys(
    value: Mapping[str, object],
    *,
    required: frozenset[str],
    optional: frozenset[str],
    label: str,
) -> None:
    """Rejects missing and unknown object keys instead of silently widening schemas."""

    keys = frozenset(value)
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise HarnessError(f"{label} is missing required keys: {', '.join(missing)}")
    if unknown:
        raise HarnessError(f"{label} contains unknown keys: {', '.join(unknown)}")


def require_array(value: object, label: str) -> list[object]:
    """Returns one JSON array or raises a precise manifest error."""

    if not isinstance(value, list):
        raise HarnessError(f"{label} must be an array")
    return cast(list[object], value)


def require_identifier(value: object, label: str) -> str:
    """Returns one stable lowercase identifier."""

    identifier = require_string(value, label)
    if not IDENTIFIER_PATTERN.fullmatch(identifier):
        raise HarnessError(f"{label} is not a valid lowercase identifier")
    return identifier


def require_string_array(
    value: object,
    label: str,
    *,
    allow_empty: bool = True,
) -> tuple[str, ...]:
    """Returns one duplicate-free string tuple."""

    values = require_array(value, label)
    if not allow_empty and not values:
        raise HarnessError(f"{label} must not be empty")
    strings = tuple(
        require_string(item, f"{label}[{item_index}]")
        for item_index, item in enumerate(values)
    )
    if len(set(strings)) != len(strings):
        raise HarnessError(f"{label} must not contain duplicates")
    return strings


def require_identifier_array(
    value: object,
    label: str,
    *,
    allow_empty: bool = True,
) -> tuple[str, ...]:
    """Returns one duplicate-free identifier tuple."""

    values = require_array(value, label)
    if not allow_empty and not values:
        raise HarnessError(f"{label} must not be empty")
    identifiers = tuple(
        require_identifier(item, f"{label}[{item_index}]")
        for item_index, item in enumerate(values)
    )
    if len(set(identifiers)) != len(identifiers):
        raise HarnessError(f"{label} must not contain duplicates")
    return identifiers


def require_safe_arguments(value: object, label: str) -> tuple[str, ...]:
    """Returns an argument vector that cannot contain command separators or newlines."""

    argument_values = require_array(value, label)
    arguments = tuple(
        require_string(argument, f"{label}[{argument_index}]")
        for argument_index, argument in enumerate(argument_values)
    )
    for argument in arguments:
        if "\x00" in argument or "\r" in argument or "\n" in argument:
            raise HarnessError(f"{label} contains a control character")
        if len(argument) > 512:
            raise HarnessError(f"{label} contains an argument longer than 512 characters")
    return arguments


def require_environment_name(value: object, label: str) -> str:
    """Returns one explicit uppercase environment variable name."""

    environment_name = require_string(value, label)
    if not ENVIRONMENT_NAME_PATTERN.fullmatch(environment_name):
        raise HarnessError(f"{label} is not a valid environment variable name")
    return environment_name


def repository_path(relative_path: str, label: str) -> Path:
    """Resolves one slash-delimited path and rejects repository traversal."""

    if "\\" in relative_path or "\x00" in relative_path:
        raise HarnessError(f"{label} must use forward slashes")
    pure_path = PurePosixPath(relative_path)
    if pure_path.is_absolute() or not pure_path.parts:
        raise HarnessError(f"{label} must be repository-relative")
    if any(part in {"", ".", ".."} for part in pure_path.parts):
        raise HarnessError(f"{label} must not traverse directories")
    resolved_path = REPOSITORY_ROOT.joinpath(*pure_path.parts).resolve()
    try:
        resolved_path.relative_to(REPOSITORY_ROOT)
    except ValueError as error:
        raise HarnessError(f"{label} resolves outside the repository") from error
    return resolved_path


def resolve_uri(uri: str, label: str) -> Path | None:
    """Resolves repository and private environment fixture URIs."""

    if uri.startswith("repo://"):
        return repository_path(uri.removeprefix("repo://"), label)
    if uri.startswith("env://"):
        environment_name = require_environment_name(
            uri.removeprefix("env://"),
            f"{label} environment name",
        )
        configured_path = os.environ.get(environment_name)
        if not configured_path:
            return None
        return Path(configured_path).expanduser().resolve()
    raise HarnessError(f"{label} must use repo:// or env://")


def path_to_repository_uri(path: Path) -> str:
    """Formats a checked repository file without exposing a machine path."""

    try:
        relative_path = path.resolve().relative_to(REPOSITORY_ROOT)
    except ValueError as error:
        raise HarnessError(f"Path is outside the repository: {path}") from error
    return f"repo://{relative_path.as_posix()}"


def merge_overlay(
    manifest_value: dict[str, object],
    overlay_path: Path | None,
) -> tuple[dict[str, object], str | None]:
    """Appends private records while forbidding canonical record replacement."""

    if overlay_path is None:
        return manifest_value, None
    overlay_value = require_mapping(read_json(overlay_path), "Validation overlay")
    require_exact_keys(
        overlay_value,
        required=frozenset({"schemaVersion"}),
        optional=frozenset({"$schema", "fixtures", "checks", "cases", "matrices"}),
        label="Validation overlay",
    )
    if overlay_value["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError(f"Validation overlay schemaVersion must be {SCHEMA_VERSION}")
    merged_value = dict(manifest_value)
    for registry_name in ("fixtures", "checks", "cases", "matrices"):
        base_records = require_array(manifest_value.get(registry_name), registry_name)
        overlay_records = require_array(overlay_value.get(registry_name, []), registry_name)
        merged_value[registry_name] = [*base_records, *overlay_records]
    return merged_value, calculate_sha256(overlay_path)


def validate_license(value: object, label: str) -> None:
    """Checks one redistribution license record and its evidence path."""

    license_value = require_mapping(value, label)
    require_exact_keys(
        license_value,
        required=frozenset({"expression", "evidence"}),
        optional=frozenset(),
        label=label,
    )
    require_string(license_value["expression"], f"{label}.expression")
    evidence_uri = require_string(license_value["evidence"], f"{label}.evidence")
    evidence_path = resolve_uri(evidence_uri, f"{label}.evidence")
    if evidence_uri.startswith("repo://") and (
        evidence_path is None or not evidence_path.is_file()
    ):
        raise HarnessError(f"{label}.evidence does not exist: {evidence_uri}")


def validate_provenance(value: object, label: str) -> None:
    """Checks source, revision, and reproducible generation metadata."""

    provenance = require_mapping(value, label)
    require_exact_keys(
        provenance,
        required=frozenset({"kind", "source", "revision", "generatorArguments"}),
        optional=frozenset(),
        label=label,
    )
    kind = require_string(provenance["kind"], f"{label}.kind")
    if kind not in {"generated", "upstream"}:
        raise HarnessError(f"{label}.kind must be generated or upstream")
    require_string(provenance["source"], f"{label}.source")
    require_string(provenance["revision"], f"{label}.revision")
    require_safe_arguments(provenance["generatorArguments"], f"{label}.generatorArguments")


def validate_media(value: object, label: str) -> None:
    """Checks exact container and elementary media metadata without inferred defaults."""

    media = require_mapping(value, label)
    require_exact_keys(
        media,
        required=frozenset({"container", "packetization"}),
        optional=frozenset({"video", "audio"}),
        label=label,
    )
    require_string(media["container"], f"{label}.container")
    require_string(media["packetization"], f"{label}.packetization")
    if "video" not in media and "audio" not in media:
        raise HarnessError(f"{label} must describe video, audio, or both")
    if "video" in media:
        video = require_mapping(media["video"], f"{label}.video")
        required_video_keys = frozenset(
            {
                "codec",
                "profile",
                "width",
                "height",
                "frameRate",
                "bitDepth",
                "chroma",
                "range",
                "primaries",
                "transfer",
                "matrix",
                "progressive",
            }
        )
        require_exact_keys(
            video,
            required=required_video_keys,
            optional=frozenset(),
            label=f"{label}.video",
        )
        for string_key in (
            "codec",
            "profile",
            "chroma",
            "range",
            "primaries",
            "transfer",
            "matrix",
        ):
            require_string(video[string_key], f"{label}.video.{string_key}")
        require_integer(video["width"], f"{label}.video.width", 1, 65_535)
        require_integer(video["height"], f"{label}.video.height", 1, 65_535)
        require_integer(video["bitDepth"], f"{label}.video.bitDepth", 1, 64)
        frame_rate = video["frameRate"]
        if isinstance(frame_rate, bool) or not isinstance(frame_rate, (int, float)):
            raise HarnessError(f"{label}.video.frameRate must be a number")
        if float(frame_rate) <= 0 or float(frame_rate) > 1_000:
            raise HarnessError(f"{label}.video.frameRate is out of range")
        if not isinstance(video["progressive"], bool):
            raise HarnessError(f"{label}.video.progressive must be boolean")
    if "audio" in media:
        audio = require_mapping(media["audio"], f"{label}.audio")
        required_audio_keys = frozenset(
            {
                "codec",
                "profile",
                "sampleRate",
                "channelLayout",
                "channelCount",
                "bitsPerSample",
            }
        )
        require_exact_keys(
            audio,
            required=required_audio_keys,
            optional=frozenset(),
            label=f"{label}.audio",
        )
        for string_key in ("codec", "profile", "channelLayout"):
            require_string(audio[string_key], f"{label}.audio.{string_key}")
        require_integer(audio["sampleRate"], f"{label}.audio.sampleRate", 1, 768_000)
        require_integer(audio["channelCount"], f"{label}.audio.channelCount", 1, 32)
        require_integer(audio["bitsPerSample"], f"{label}.audio.bitsPerSample", 1, 64)


def validate_fixture(value: object, label: str) -> tuple[str, dict[str, object]]:
    """Checks one content-addressed fixture record."""

    fixture = require_mapping(value, label)
    require_exact_keys(
        fixture,
        required=frozenset(
            {"id", "uri", "byteLength", "sha256", "license", "provenance", "media"}
        ),
        optional=frozenset(),
        label=label,
    )
    fixture_id = require_identifier(fixture["id"], f"{label}.id")
    uri = require_string(fixture["uri"], f"{label}.uri")
    resolve_uri(uri, f"{label}.uri")
    require_integer(fixture["byteLength"], f"{label}.byteLength", 1)
    fixture_sha256 = require_string(fixture["sha256"], f"{label}.sha256")
    if not SHA256_PATTERN.fullmatch(fixture_sha256):
        raise HarnessError(f"{label}.sha256 must be lowercase SHA-256")
    validate_license(fixture["license"], f"{label}.license")
    validate_provenance(fixture["provenance"], f"{label}.provenance")
    validate_media(fixture["media"], f"{label}.media")
    return fixture_id, fixture


def validate_repository_target(value: str, label: str) -> None:
    """Checks one repository target or glob without invoking a shell."""

    wildcard_index = min(
        (value.find(character) for character in "*?[" if character in value),
        default=-1,
    )
    stable_prefix = value if wildcard_index < 0 else value[:wildcard_index]
    prefix_path = PurePosixPath(stable_prefix).parent if wildcard_index >= 0 else PurePosixPath(value)
    repository_path(prefix_path.as_posix(), label)
    if wildcard_index < 0 and not repository_path(value, label).is_file():
        raise HarnessError(f"{label} does not exist: {value}")


def validate_assertion(value: object, label: str) -> None:
    """Checks one explicit JSON Pointer assertion."""

    assertion = require_mapping(value, label)
    require_exact_keys(
        assertion,
        required=frozenset({"path", "operator"}),
        optional=frozenset({"value"}),
        label=label,
    )
    pointer = require_string(assertion["path"], f"{label}.path")
    if not pointer.startswith("/") or "//" in pointer:
        raise HarnessError(f"{label}.path must be a nonempty JSON Pointer")
    operator = require_string(assertion["operator"], f"{label}.operator")
    if operator not in {"absent", "empty", "equals", "zero"}:
        raise HarnessError(f"{label}.operator is unsupported")
    if operator == "equals" and "value" not in assertion:
        raise HarnessError(f"{label}.value is required for equals")
    if operator != "equals" and "value" in assertion:
        raise HarnessError(f"{label}.value is only valid for equals")


def validate_check(value: object, label: str) -> tuple[str, dict[str, object]]:
    """Checks one fixed adapter definition and its safe arguments."""

    check = require_mapping(value, label)
    require_exact_keys(
        check,
        required=frozenset({"id", "title", "adapter", "timeoutSeconds"}),
        optional=frozenset(
            {
                "targets",
                "arguments",
                "requiredEnvironment",
                "environmentArguments",
                "resultFormat",
                "resultAssertions",
                "dependsOn",
                "supersedes",
                "tags",
            }
        ),
        label=label,
    )
    check_id = require_identifier(check["id"], f"{label}.id")
    require_string(check["title"], f"{label}.title")
    adapter = require_string(check["adapter"], f"{label}.adapter")
    if adapter not in ALLOWED_ADAPTERS:
        raise HarnessError(f"{label}.adapter is unsupported: {adapter}")
    require_integer(
        check["timeoutSeconds"],
        f"{label}.timeoutSeconds",
        1,
        MAXIMUM_TIMEOUT_SECONDS,
    )
    targets = require_string_array(check.get("targets", []), f"{label}.targets")
    for target_index, target in enumerate(targets):
        validate_repository_target(target, f"{label}.targets[{target_index}]")
    require_safe_arguments(check.get("arguments", []), f"{label}.arguments")
    environment_names = require_string_array(
        check.get("requiredEnvironment", []),
        f"{label}.requiredEnvironment",
    )
    for environment_index, environment_name in enumerate(environment_names):
        require_environment_name(
            environment_name,
            f"{label}.requiredEnvironment[{environment_index}]",
        )
    environment_arguments = require_array(
        check.get("environmentArguments", []),
        f"{label}.environmentArguments",
    )
    allowed_options = ENVIRONMENT_ARGUMENT_OPTIONS.get(adapter, frozenset())
    for argument_index, argument_value in enumerate(environment_arguments):
        argument = require_mapping(
            argument_value,
            f"{label}.environmentArguments[{argument_index}]",
        )
        require_exact_keys(
            argument,
            required=frozenset({"option", "environment"}),
            optional=frozenset(),
            label=f"{label}.environmentArguments[{argument_index}]",
        )
        option = require_string(
            argument["option"],
            f"{label}.environmentArguments[{argument_index}].option",
        )
        if option not in allowed_options:
            raise HarnessError(f"{label} does not permit environment option {option}")
        require_environment_name(
            argument["environment"],
            f"{label}.environmentArguments[{argument_index}].environment",
        )
    result_format = require_string(check.get("resultFormat", "text"), f"{label}.resultFormat")
    if result_format not in {"text", "json"}:
        raise HarnessError(f"{label}.resultFormat must be text or json")
    assertions = require_array(check.get("resultAssertions", []), f"{label}.resultAssertions")
    if assertions and result_format != "json":
        raise HarnessError(f"{label}.resultAssertions require resultFormat json")
    for assertion_index, assertion in enumerate(assertions):
        validate_assertion(assertion, f"{label}.resultAssertions[{assertion_index}]")
    require_identifier_array(check.get("dependsOn", []), f"{label}.dependsOn")
    require_identifier_array(check.get("supersedes", []), f"{label}.supersedes")
    tags = require_string_array(check.get("tags", []), f"{label}.tags")
    for tag in tags:
        if not TAG_PATTERN.fullmatch(tag):
            raise HarnessError(f"{label}.tags contains an invalid tag: {tag}")
    if adapter in {"node-script", "python-script", "vite-node"} and len(targets) != 1:
        raise HarnessError(f"{label} requires exactly one target")
    adapters_without_targets = {
        "artifact-verifier",
        "browser-smoke",
        "mpv-ab",
        "python-unittest",
        "stylelint",
        "toolchain-probe",
        "typescript",
        "webpack-development",
        "webpack-production",
        "worker-smoke",
    }
    if adapter in adapters_without_targets and targets:
        raise HarnessError(f"{label} adapter does not accept targets")
    adapters_without_arguments = {
        "artifact-verifier",
        "eslint",
        "node-test",
        "stylelint",
        "typescript",
        "vitest",
        "webpack-development",
        "webpack-production",
    }
    if adapter in adapters_without_arguments and check.get("arguments"):
        raise HarnessError(f"{label} adapter does not accept arguments")
    return check_id, check


def validate_expectations(value: object, label: str) -> None:
    """Checks the authoritative expected route for one case."""

    expectations = require_mapping(value, label)
    required_keys = frozenset(
        {
            "capability",
            "decoderBackend",
            "frameMode",
            "presentationRoute",
            "fallback",
            "audioRoute",
            "jellyfinPlayMethod",
            "permittedTranscodeReasons",
        }
    )
    require_exact_keys(
        expectations,
        required=required_keys,
        optional=frozenset(),
        label=label,
    )
    capability = require_string(expectations["capability"], f"{label}.capability")
    if capability not in {"supported", "unsupported"}:
        raise HarnessError(f"{label}.capability is unsupported")
    for key in ("decoderBackend", "frameMode", "presentationRoute", "fallback"):
        require_string(expectations[key], f"{label}.{key}")
    audio_route = require_string(expectations["audioRoute"], f"{label}.audioRoute")
    if audio_route not in {"decoded-pcm", "disabled", "native-media"}:
        raise HarnessError(f"{label}.audioRoute is unsupported")
    play_method = require_string(
        expectations["jellyfinPlayMethod"],
        f"{label}.jellyfinPlayMethod",
    )
    if play_method not in {"DirectPlay", "DirectStream", "Transcode", "not-applicable"}:
        raise HarnessError(f"{label}.jellyfinPlayMethod is unsupported")
    require_string_array(
        expectations["permittedTranscodeReasons"],
        f"{label}.permittedTranscodeReasons",
    )


def validate_case(value: object, label: str) -> tuple[str, dict[str, object]]:
    """Checks one stable case, its references, tags, and expected route."""

    case = require_mapping(value, label)
    require_exact_keys(
        case,
        required=frozenset(
            {"id", "title", "fixtureIds", "checkIds", "tags", "expectations"}
        ),
        optional=frozenset({"manualSteps", "thresholds"}),
        label=label,
    )
    case_id = require_identifier(case["id"], f"{label}.id")
    require_string(case["title"], f"{label}.title")
    require_identifier_array(case["fixtureIds"], f"{label}.fixtureIds", allow_empty=False)
    require_identifier_array(case["checkIds"], f"{label}.checkIds", allow_empty=False)
    tags = require_string_array(case["tags"], f"{label}.tags", allow_empty=False)
    for tag in tags:
        if not TAG_PATTERN.fullmatch(tag):
            raise HarnessError(f"{label}.tags contains an invalid tag: {tag}")
    require_string_array(case.get("manualSteps", []), f"{label}.manualSteps")
    thresholds = require_mapping(case.get("thresholds", {}), f"{label}.thresholds")
    for threshold_name, threshold_value in thresholds.items():
        if isinstance(threshold_value, bool) or not isinstance(threshold_value, (int, float)):
            raise HarnessError(f"{label}.thresholds.{threshold_name} must be numeric")
    validate_expectations(case["expectations"], f"{label}.expectations")
    return case_id, case


def validate_matrix(value: object, label: str) -> tuple[str, dict[str, object]]:
    """Checks one named matrix and its required case/check sets."""

    matrix = require_mapping(value, label)
    require_exact_keys(
        matrix,
        required=frozenset(
            {"id", "title", "caseIds", "requiredCheckIds", "requireManualObservations"}
        ),
        optional=frozenset(),
        label=label,
    )
    matrix_id = require_identifier(matrix["id"], f"{label}.id")
    require_string(matrix["title"], f"{label}.title")
    require_identifier_array(matrix["caseIds"], f"{label}.caseIds", allow_empty=False)
    require_identifier_array(matrix["requiredCheckIds"], f"{label}.requiredCheckIds")
    if not isinstance(matrix["requireManualObservations"], bool):
        raise HarnessError(f"{label}.requireManualObservations must be boolean")
    return matrix_id, matrix


def index_records(
    values: object,
    label: str,
    validator: Callable[[object, str], tuple[str, dict[str, object]]],
) -> dict[str, dict[str, object]]:
    """Validates a registry and rejects duplicate stable IDs."""

    records: dict[str, dict[str, object]] = {}
    for record_index, record_value in enumerate(require_array(values, label)):
        record_id, record = validator(record_value, f"{label}[{record_index}]")
        if record_id in records:
            raise HarnessError(f"{label} contains duplicate ID: {record_id}")
        records[record_id] = record
    if not records:
        raise HarnessError(f"{label} must not be empty")
    return records


def validate_reference_graph(
    fixtures: Mapping[str, dict[str, object]],
    checks: Mapping[str, dict[str, object]],
    cases: Mapping[str, dict[str, object]],
    matrices: Mapping[str, dict[str, object]],
) -> None:
    """Rejects dangling case, check, dependency, and supersession references."""

    for check_id, check in checks.items():
        dependencies = require_identifier_array(check.get("dependsOn", []), f"Check {check_id} dependsOn")
        supersedes = require_identifier_array(check.get("supersedes", []), f"Check {check_id} supersedes")
        for referenced_id in (*dependencies, *supersedes):
            if referenced_id not in checks:
                raise HarnessError(f"Check {check_id} references missing check {referenced_id}")
            if referenced_id == check_id:
                raise HarnessError(f"Check {check_id} cannot reference itself")
        if set(dependencies) & set(supersedes):
            raise HarnessError(f"Check {check_id} cannot supersede one of its dependencies")
    for case_id, case in cases.items():
        for fixture_id in require_identifier_array(case["fixtureIds"], f"Case {case_id} fixtureIds"):
            if fixture_id not in fixtures:
                raise HarnessError(f"Case {case_id} references missing fixture {fixture_id}")
        for check_id in require_identifier_array(case["checkIds"], f"Case {case_id} checkIds"):
            if check_id not in checks:
                raise HarnessError(f"Case {case_id} references missing check {check_id}")
    for matrix_id, matrix in matrices.items():
        for case_id in require_identifier_array(matrix["caseIds"], f"Matrix {matrix_id} caseIds"):
            if case_id not in cases:
                raise HarnessError(f"Matrix {matrix_id} references missing case {case_id}")
        for check_id in require_identifier_array(
            matrix["requiredCheckIds"],
            f"Matrix {matrix_id} requiredCheckIds",
        ):
            if check_id not in checks:
                raise HarnessError(f"Matrix {matrix_id} references missing check {check_id}")
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(check_id: str) -> None:
        if check_id in visiting:
            raise HarnessError(f"Check dependency cycle includes {check_id}")
        if check_id in visited:
            return
        visiting.add(check_id)
        for dependency_id in require_identifier_array(
            checks[check_id].get("dependsOn", []),
            f"Check {check_id} dependsOn",
        ):
            visit(dependency_id)
        visiting.remove(check_id)
        visited.add(check_id)

    for check_id in checks:
        visit(check_id)


def load_failure_codes(uri: str) -> dict[str, str]:
    """Loads the sole checked failure vocabulary."""

    path = resolve_uri(uri, "failureVocabulary")
    if path is None or not path.is_file():
        raise HarnessError(f"Failure vocabulary is unavailable: {uri}")
    value = require_mapping(read_json(path), "Failure vocabulary")
    require_exact_keys(
        value,
        required=frozenset({"schemaVersion", "codes"}),
        optional=frozenset({"$schema"}),
        label="Failure vocabulary",
    )
    if value["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError(f"Failure vocabulary schemaVersion must be {SCHEMA_VERSION}")
    codes_value = require_mapping(value["codes"], "Failure vocabulary codes")
    codes: dict[str, str] = {}
    for code, description_value in codes_value.items():
        code_id = require_identifier(code, f"Failure code {code}")
        codes[code_id] = require_string(description_value, f"Failure code {code} description")
    if not codes:
        raise HarnessError("Failure vocabulary must not be empty")
    return codes


# Registry loading


def load_manifest(
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
    overlay_path: Path | None = None,
) -> ValidationManifest:
    """Loads, merges, and fully validates the canonical manifest and private overlay."""

    resolved_manifest_path = manifest_path.expanduser().resolve()
    raw_manifest = require_mapping(read_json(resolved_manifest_path), "Validation manifest")
    require_exact_keys(
        raw_manifest,
        required=frozenset(
            {"schemaVersion", "failureVocabulary", "fixtures", "checks", "cases", "matrices"}
        ),
        optional=frozenset({"$schema"}),
        label="Validation manifest",
    )
    if raw_manifest["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError(f"Validation manifest schemaVersion must be {SCHEMA_VERSION}")
    merged_manifest, overlay_sha256 = merge_overlay(raw_manifest, overlay_path)
    fixtures = index_records(merged_manifest["fixtures"], "fixtures", validate_fixture)
    checks = index_records(merged_manifest["checks"], "checks", validate_check)
    cases = index_records(merged_manifest["cases"], "cases", validate_case)
    matrices = index_records(merged_manifest["matrices"], "matrices", validate_matrix)
    validate_reference_graph(fixtures, checks, cases, matrices)
    failure_vocabulary_uri = require_string(
        merged_manifest["failureVocabulary"],
        "failureVocabulary",
    )
    failure_codes = load_failure_codes(failure_vocabulary_uri)
    return ValidationManifest(
        cases=cases,
        checks=checks,
        failure_codes=failure_codes,
        fixtures=fixtures,
        manifest_path=resolved_manifest_path,
        manifest_sha256=calculate_sha256(resolved_manifest_path),
        matrices=matrices,
        overlay_sha256=overlay_sha256,
    )


# Matrix selection


def case_matches_selectors(case: Mapping[str, object], selectors: Sequence[str]) -> bool:
    """Applies OR within a selector axis and AND across distinct axes."""

    grouped_values: dict[str, set[str]] = {}
    for selector in selectors:
        if selector == "soak":
            grouped_values.setdefault("tag", set()).add("soak")
            continue
        if ":" not in selector:
            raise HarnessError(f"Unsupported selector: {selector}")
        axis, value = selector.split(":", 1)
        if axis not in {"case", "codec", "route", "gpu", "tag"} or not value:
            raise HarnessError(f"Unsupported selector: {selector}")
        grouped_values.setdefault(axis, set()).add(value)
    case_id = cast(str, case["id"])
    tags = set(require_string_array(case["tags"], f"Case {case_id} tags"))
    for axis, values in grouped_values.items():
        if axis == "case":
            if case_id not in values:
                return False
            continue
        expected_tags = values if axis == "tag" else {f"{axis}:{value}" for value in values}
        if tags.isdisjoint(expected_tags):
            return False
    return True


def expand_dependencies(
    check_ids: set[str],
    checks: Mapping[str, dict[str, object]],
) -> None:
    """Adds transitive check dependencies through iteration."""

    pending_ids = list(check_ids)
    while pending_ids:
        check_id = pending_ids.pop()
        dependencies = require_identifier_array(
            checks[check_id].get("dependsOn", []),
            f"Check {check_id} dependsOn",
        )
        for dependency_id in dependencies:
            if dependency_id in check_ids:
                continue
            check_ids.add(dependency_id)
            pending_ids.append(dependency_id)


def apply_supersession(
    check_ids: set[str],
    checks: Mapping[str, dict[str, object]],
) -> dict[str, str]:
    """Removes explicitly covered checks and rejects ambiguous replacements."""

    superseded_checks: dict[str, str] = {}
    for check_id in sorted(check_ids):
        for superseded_id in require_identifier_array(
            checks[check_id].get("supersedes", []),
            f"Check {check_id} supersedes",
        ):
            if superseded_id not in check_ids:
                continue
            existing_replacement = superseded_checks.get(superseded_id)
            if existing_replacement is not None and existing_replacement != check_id:
                raise HarnessError(
                    f"Checks {existing_replacement} and {check_id} both supersede {superseded_id}"
                )
            superseded_checks[superseded_id] = check_id
    for superseded_id in superseded_checks:
        check_ids.discard(superseded_id)
    return superseded_checks


def topological_check_order(
    check_ids: set[str],
    checks: Mapping[str, dict[str, object]],
    superseded_checks: Mapping[str, str],
) -> tuple[str, ...]:
    """Orders selected checks after their effective dependencies."""

    remaining = set(check_ids)
    ordered_ids: list[str] = []
    while remaining:
        ready_ids: list[str] = []
        for check_id in sorted(remaining):
            dependencies = require_identifier_array(
                checks[check_id].get("dependsOn", []),
                f"Check {check_id} dependsOn",
            )
            effective_dependencies = {
                superseded_checks.get(dependency_id, dependency_id)
                for dependency_id in dependencies
            }
            if effective_dependencies.isdisjoint(remaining):
                ready_ids.append(check_id)
        if not ready_ids:
            raise HarnessError("Selected checks contain an unresolved dependency cycle")
        for check_id in ready_ids:
            remaining.remove(check_id)
            ordered_ids.append(check_id)
    return tuple(ordered_ids)


def select_matrix(
    manifest: ValidationManifest,
    matrix_id: str,
    selectors: Sequence[str] = (),
) -> ValidationSelection:
    """Expands one matrix, filters cases, and deduplicates shared checks."""

    if matrix_id not in manifest.matrices:
        raise HarnessError(f"Unknown validation matrix: {matrix_id}")
    matrix = manifest.matrices[matrix_id]
    candidate_ids = require_identifier_array(matrix["caseIds"], f"Matrix {matrix_id} caseIds")
    case_ids = tuple(
        case_id
        for case_id in candidate_ids
        if case_matches_selectors(manifest.cases[case_id], selectors)
    )
    if not case_ids:
        raise HarnessError("The selected matrix and selectors contain no cases")
    fixture_ids: set[str] = set()
    check_ids: set[str] = set(
        require_identifier_array(
            matrix["requiredCheckIds"],
            f"Matrix {matrix_id} requiredCheckIds",
        )
    )
    for case_id in case_ids:
        case = manifest.cases[case_id]
        fixture_ids.update(
            require_identifier_array(case["fixtureIds"], f"Case {case_id} fixtureIds")
        )
        check_ids.update(
            require_identifier_array(case["checkIds"], f"Case {case_id} checkIds")
        )
    expand_dependencies(check_ids, manifest.checks)
    superseded_checks = apply_supersession(check_ids, manifest.checks)
    ordered_check_ids = topological_check_order(
        check_ids,
        manifest.checks,
        superseded_checks,
    )
    return ValidationSelection(
        case_ids=case_ids,
        check_ids=ordered_check_ids,
        fixture_ids=tuple(sorted(fixture_ids)),
        matrix_id=matrix_id,
        selectors=tuple(selectors),
        superseded_checks=dict(sorted(superseded_checks.items())),
    )


# Fixed adapters


def expand_targets(targets: Sequence[str]) -> tuple[str, ...]:
    """Expands repository globs deterministically without shell wildcard behavior."""

    expanded_targets: list[str] = []
    for target in targets:
        if not any(character in target for character in "*?["):
            expanded_targets.append(target)
            continue
        matches = sorted(
            path.relative_to(REPOSITORY_ROOT).as_posix()
            for path in REPOSITORY_ROOT.glob(target)
            if path.is_file()
        )
        if not matches:
            raise HarnessError(f"Validation target pattern matched no files: {target}")
        expanded_targets.extend(matches)
    return tuple(expanded_targets)


def command_for_check(check: Mapping[str, object]) -> CommandSpecification:
    """Maps one checked adapter to a fixed executable and argument vector."""

    adapter = cast(str, check["adapter"])
    targets = expand_targets(
        require_string_array(check.get("targets", []), f"Check {check['id']} targets")
    )
    arguments = require_safe_arguments(
        check.get("arguments", []),
        f"Check {check['id']} arguments",
    )
    match adapter:
        case "artifact-verifier":
            command_arguments = [
                "node",
                "scripts/webgpu/verify-custom-codec-artifacts.mjs",
            ]
        case "browser-smoke":
            command_arguments = [
                "node",
                "scripts/webgpu/run-browser-playback-smoke.mjs",
                *arguments,
            ]
        case "eslint":
            command_arguments = ["npm", "run", "lint", "--", *targets]
        case "mpv-ab":
            command_arguments = [
                sys.executable,
                "scripts/webgpu/run_mpv_ab.py",
                *arguments,
            ]
        case "node-script":
            command_arguments = ["node", targets[0], *arguments]
        case "node-test":
            command_arguments = ["node", "--test", *targets]
        case "python-script":
            command_arguments = [sys.executable, targets[0], *arguments]
        case "python-unittest":
            command_arguments = [sys.executable, "-m", "unittest", *arguments]
        case "stylelint":
            command_arguments = ["npm", "run", "stylelint"]
        case "toolchain-probe":
            command_arguments = [
                sys.executable,
                "scripts/webgpu/probe_webgpu_toolchain.py",
                *arguments,
            ]
        case "typescript":
            command_arguments = ["npm", "run", "build:check"]
        case "vite-node":
            command_arguments = [
                "npx",
                "--no-install",
                "vite-node",
                "--script",
                targets[0],
                *arguments,
            ]
        case "vitest":
            command_arguments = ["npm", "test", "--", *targets]
        case "webpack-development":
            command_arguments = ["npm", "run", "build:development"]
        case "webpack-production":
            command_arguments = ["npm", "run", "build:production"]
        case "worker-smoke":
            command_arguments = [
                "node",
                "scripts/webgpu/run-dolby-vision-worker-smoke.mjs",
                *arguments,
            ]
        case _:
            raise HarnessError(f"Unsupported validation adapter: {adapter}")
    for environment_argument_value in require_array(
        check.get("environmentArguments", []),
        f"Check {check['id']} environmentArguments",
    ):
        environment_argument = require_mapping(
            environment_argument_value,
            f"Check {check['id']} environmentArgument",
        )
        environment_name = cast(str, environment_argument["environment"])
        environment_value = os.environ.get(environment_name)
        if environment_value:
            command_arguments.extend(
                [cast(str, environment_argument["option"]), environment_value]
            )
    timeout_seconds = cast(int, check["timeoutSeconds"])
    return CommandSpecification(tuple(command_arguments), timeout_seconds)


def check_environment_names(check: Mapping[str, object]) -> tuple[str, ...]:
    """Returns every direct and argument-backed environment dependency."""

    names = set(
        require_string_array(
            check.get("requiredEnvironment", []),
            f"Check {check['id']} requiredEnvironment",
        )
    )
    for environment_argument_value in require_array(
        check.get("environmentArguments", []),
        f"Check {check['id']} environmentArguments",
    ):
        environment_argument = require_mapping(
            environment_argument_value,
            f"Check {check['id']} environmentArgument",
        )
        names.add(cast(str, environment_argument["environment"]))
    return tuple(sorted(names))


def report_replacements(checks: Sequence[Mapping[str, object]]) -> dict[str, str]:
    """Creates deterministic replacements for private inputs and machine paths."""

    replacements: dict[str, str] = {
        str(REPOSITORY_ROOT): "<REPOSITORY_ROOT>",
        str(REPOSITORY_ROOT).replace("\\", "/"): "<REPOSITORY_ROOT>",
        sys.executable: "<PYTHON>",
    }
    for check in checks:
        for environment_name in check_environment_names(check):
            environment_value = os.environ.get(environment_name)
            if environment_value:
                replacements[environment_value] = f"<ENV:{environment_name}>"
    return replacements


# Evidence and sanitization


def sanitize_text(value: str, replacements: Mapping[str, str]) -> str:
    """Removes declared inputs, URLs, assignments, and absolute Windows paths."""

    sanitized_value = command_for_report([value], replacements)[0]
    sanitized_value = QUERY_SECRET_PATTERN.sub(r"\1[redacted]", sanitized_value)
    sanitized_value = SENSITIVE_ASSIGNMENT_PATTERN.sub(
        lambda match: f"{match.group(1)}=[redacted]",
        sanitized_value,
    )
    sanitized_value = URL_PATTERN.sub("[redacted-url]", sanitized_value)
    sanitized_value = WINDOWS_PATH_PATTERN.sub("[redacted-path]", sanitized_value)
    return sanitized_value


def sanitize_value(value: object, replacements: Mapping[str, str]) -> object:
    """Recursively sanitizes structured adapter evidence."""

    if isinstance(value, str):
        return sanitize_text(value, replacements)
    if isinstance(value, list):
        return [sanitize_value(item, replacements) for item in value]
    if isinstance(value, dict):
        sanitized_mapping: dict[str, object] = {}
        for key, child_value in value.items():
            string_key = str(key)
            normalized_key = string_key.lower().replace("_", "").replace("-", "")
            if any(part in normalized_key for part in SENSITIVE_KEY_PARTS):
                sanitized_mapping[string_key] = "[redacted]"
            elif normalized_key.endswith("url"):
                sanitized_mapping[string_key] = "[redacted-url]"
            else:
                sanitized_mapping[string_key] = sanitize_value(child_value, replacements)
        return sanitized_mapping
    return value


def diagnostic_tail(value: str, replacements: Mapping[str, str]) -> str:
    """Returns a bounded sanitized diagnostic tail."""

    sanitized_value = sanitize_text(value, replacements)
    if len(sanitized_value) <= MAXIMUM_DIAGNOSTIC_CHARACTERS:
        return sanitized_value
    return sanitized_value[-MAXIMUM_DIAGNOSTIC_CHARACTERS:]


def parse_structured_output(standard_output: str, standard_error: str) -> object:
    """Parses one exact JSON document from stdout or stderr."""

    candidates = [standard_output.strip(), standard_error.strip()]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise HarnessError("Adapter did not emit one valid JSON document")


MISSING_JSON_VALUE = object()


def json_pointer_value(value: object, pointer: str) -> object:
    """Resolves an RFC 6901 JSON Pointer or returns a missing sentinel."""

    current_value = value
    for encoded_part in pointer.removeprefix("/").split("/"):
        part = encoded_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current_value, dict):
            if part not in current_value:
                return MISSING_JSON_VALUE
            current_value = current_value[part]
            continue
        if isinstance(current_value, list) and part.isdigit():
            item_index = int(part)
            if item_index >= len(current_value):
                return MISSING_JSON_VALUE
            current_value = current_value[item_index]
            continue
        return MISSING_JSON_VALUE
    return current_value


def assertion_matches(value: object, assertion: Mapping[str, object]) -> bool:
    """Evaluates one checked structured-output assertion."""

    actual_value = json_pointer_value(value, cast(str, assertion["path"]))
    operator = cast(str, assertion["operator"])
    if operator == "absent":
        return actual_value is MISSING_JSON_VALUE
    if actual_value is MISSING_JSON_VALUE:
        return False
    if operator == "equals":
        return actual_value == assertion.get("value")
    if operator == "zero":
        return actual_value == 0 and not isinstance(actual_value, bool)
    if operator == "empty":
        return actual_value in (None, "", [], {})
    return False


def failure(code: str, message: str, failure_codes: Mapping[str, str]) -> dict[str, str]:
    """Creates one vocabulary-checked failure record."""

    if code not in failure_codes:
        raise HarnessError(f"Runner referenced unknown failure code: {code}")
    return {"code": code, "message": message}


def classify_structured_failures(value: object) -> set[str]:
    """Maps known live-harness failures onto the shared failure vocabulary."""

    failure_tokens: list[str] = []
    if isinstance(value, dict):
        failures_value = value.get("failures")
        if isinstance(failures_value, list):
            failure_tokens.extend(str(item).lower() for item in failures_value)
        error_value = value.get("error")
        if isinstance(error_value, dict):
            failure_tokens.extend(str(item).lower() for item in error_value.values())
    combined_tokens = " ".join(failure_tokens)
    codes: set[str] = set()
    classification_tokens = (
        ("ownership-warning", ("ownership", "finalizer", "garbage collected")),
        ("unexpected-transcode", ("transcod",)),
        ("console-error", ("console", "browser-error", "player-error")),
        ("resource-leak", ("leak", "retained", "memory-growth", "not-retired")),
        ("capability-unknown", ("capability-unknown", "unknown-capability")),
    )
    for code, tokens in classification_tokens:
        if any(token in combined_tokens for token in tokens):
            codes.add(code)
    return codes


# Fixture and check execution


def verify_fixture(
    fixture: Mapping[str, object],
    failure_codes: Mapping[str, str],
) -> dict[str, object]:
    """Checks fixture availability, byte length, and SHA-256 before adapters run."""

    fixture_id = cast(str, fixture["id"])
    uri = cast(str, fixture["uri"])
    expected_byte_length = cast(int, fixture["byteLength"])
    expected_sha256 = cast(str, fixture["sha256"])
    failures: list[dict[str, str]] = []
    license_value = require_mapping(fixture["license"], f"Fixture {fixture_id} license")
    license_evidence_uri = cast(str, license_value["evidence"])
    license_evidence_path = resolve_uri(
        license_evidence_uri,
        f"Fixture {fixture_id} license evidence",
    )
    if license_evidence_path is None or not license_evidence_path.is_file():
        failures.append(
            failure(
                "fixture-missing",
                f"Fixture {fixture_id} license evidence is unavailable through {license_evidence_uri}",
                failure_codes,
            )
        )
    fixture_path = resolve_uri(uri, f"Fixture {fixture_id} URI")
    if fixture_path is None or not fixture_path.is_file():
        failures.append(
            failure(
                "fixture-missing",
                f"Fixture {fixture_id} is unavailable through {uri}",
                failure_codes,
            )
        )
    else:
        actual_byte_length = fixture_path.stat().st_size
        if actual_byte_length != expected_byte_length:
            failures.append(
                failure(
                    "fixture-size-mismatch",
                    f"Fixture {fixture_id} has {actual_byte_length} bytes; expected {expected_byte_length}",
                    failure_codes,
                )
            )
        actual_sha256 = calculate_sha256(fixture_path)
        if actual_sha256 != expected_sha256:
            failures.append(
                failure(
                    "fixture-hash-mismatch",
                    f"Fixture {fixture_id} SHA-256 does not match the reviewed record",
                    failure_codes,
                )
            )
    return {
        "id": fixture_id,
        "uri": uri,
        "byteLength": expected_byte_length,
        "sha256": expected_sha256,
        "license": cast(str, license_value["expression"]),
        "status": "passed" if not failures else "failed",
        "failures": failures,
    }


def run_check(
    check: Mapping[str, object],
    *,
    evidence_directory: Path,
    failure_codes: Mapping[str, str],
    replacements: Mapping[str, str],
) -> tuple[dict[str, object], object | None]:
    """Runs one adapter and stores sanitized structured evidence when declared."""

    check_id = cast(str, check["id"])
    missing_environment = [
        environment_name
        for environment_name in check_environment_names(check)
        if not os.environ.get(environment_name)
    ]
    if missing_environment:
        failures = [
            failure(
                "input-missing",
                f"Check {check_id} requires environment input {environment_name}",
                failure_codes,
            )
            for environment_name in missing_environment
        ]
        return (
            {
                "id": check_id,
                "title": check["title"],
                "adapter": check["adapter"],
                "status": "blocked",
                "durationMilliseconds": 0,
                "arguments": [],
                "exitCode": None,
                "standardOutputTail": "",
                "standardErrorTail": "",
                "evidence": None,
                "failures": failures,
            },
            None,
        )
    try:
        specification = command_for_check(check)
    except HarnessError as error:
        return (
            {
                "id": check_id,
                "title": check["title"],
                "adapter": check["adapter"],
                "status": "failed",
                "durationMilliseconds": 0,
                "arguments": [],
                "exitCode": None,
                "standardOutputTail": "",
                "standardErrorTail": diagnostic_tail(str(error), replacements),
                "evidence": None,
                "failures": [
                    failure("configuration-invalid", str(error), failure_codes)
                ],
            },
            None,
        )
    reported_arguments = command_for_report(specification.arguments, replacements)
    executable_path = shutil.which(specification.arguments[0])
    if executable_path is None and Path(specification.arguments[0]).is_file():
        executable_path = specification.arguments[0]
    if executable_path is None:
        message = f"Unable to resolve validation tool: {specification.arguments[0]}"
        return (
            {
                "id": check_id,
                "title": check["title"],
                "adapter": check["adapter"],
                "status": "failed",
                "durationMilliseconds": 0,
                "arguments": reported_arguments,
                "exitCode": None,
                "standardOutputTail": "",
                "standardErrorTail": message,
                "evidence": None,
                "failures": [failure("tool-missing", message, failure_codes)],
            },
            None,
        )
    execution_arguments = (executable_path, *specification.arguments[1:])
    started_at = time.monotonic()
    completed_command = None
    command_error: HarnessError | None = None
    try:
        completed_command = run_command(
            execution_arguments,
            working_directory=REPOSITORY_ROOT,
            timeout_seconds=specification.timeout_seconds,
        )
    except HarnessError as error:
        command_error = error
    duration_milliseconds = round((time.monotonic() - started_at) * 1_000)
    if command_error is not None:
        error_text = str(command_error)
        failure_code = "command-timeout" if "exceeded" in error_text else "tool-missing"
        return (
            {
                "id": check_id,
                "title": check["title"],
                "adapter": check["adapter"],
                "status": "failed",
                "durationMilliseconds": duration_milliseconds,
                "arguments": reported_arguments,
                "exitCode": None,
                "standardOutputTail": "",
                "standardErrorTail": diagnostic_tail(error_text, replacements),
                "evidence": None,
                "failures": [failure(failure_code, error_text, failure_codes)],
            },
            None,
        )
    if completed_command is None:
        raise HarnessError("Adapter command result was unexpectedly unavailable")
    failures: list[dict[str, str]] = []
    structured_output: object | None = None
    evidence_path: str | None = None
    if check.get("resultFormat", "text") == "json":
        try:
            structured_output = parse_structured_output(
                completed_command.standard_output,
                completed_command.standard_error,
            )
        except HarnessError as error:
            failures.append(failure("result-invalid", str(error), failure_codes))
        if structured_output is not None:
            assertions = require_array(
                check.get("resultAssertions", []),
                f"Check {check_id} resultAssertions",
            )
            for assertion_index, assertion_value in enumerate(assertions):
                assertion = require_mapping(
                    assertion_value,
                    f"Check {check_id} resultAssertions[{assertion_index}]",
                )
                if not assertion_matches(structured_output, assertion):
                    failures.append(
                        failure(
                            "expectation-mismatch",
                            f"Check {check_id} assertion {assertion['path']} {assertion['operator']} failed",
                            failure_codes,
                        )
                    )
            for classified_code in sorted(classify_structured_failures(structured_output)):
                failures.append(
                    failure(
                        classified_code,
                        f"Check {check_id} emitted {classified_code} evidence",
                        failure_codes,
                    )
                )
            sanitized_evidence = sanitize_value(structured_output, replacements)
            evidence_file = evidence_directory / f"{check_id}.json"
            write_json(evidence_file, sanitized_evidence)
            evidence_path = evidence_file.relative_to(evidence_directory.parent).as_posix()
    if completed_command.return_code != 0 and not failures:
        failures.append(
            failure(
                "command-failed",
                f"Check {check_id} exited with code {completed_command.return_code}",
                failure_codes,
            )
        )
    return (
        {
            "id": check_id,
            "title": check["title"],
            "adapter": check["adapter"],
            "status": "passed" if not failures else "failed",
            "durationMilliseconds": duration_milliseconds,
            "arguments": reported_arguments,
            "exitCode": completed_command.return_code,
            "standardOutputTail": diagnostic_tail(
                completed_command.standard_output,
                replacements,
            ),
            "standardErrorTail": diagnostic_tail(
                completed_command.standard_error,
                replacements,
            ),
            "evidence": evidence_path,
            "failures": failures,
        },
        structured_output,
    )


def skipped_check_result(
    check: Mapping[str, object],
    failure_codes: Mapping[str, str],
) -> dict[str, object]:
    """Creates one explicit fail-fast skip record."""

    check_id = cast(str, check["id"])
    return {
        "id": check_id,
        "title": check["title"],
        "adapter": check["adapter"],
        "status": "skipped",
        "durationMilliseconds": 0,
        "arguments": [],
        "exitCode": None,
        "standardOutputTail": "",
        "standardErrorTail": "",
        "evidence": None,
        "failures": [
            failure(
                "required-check-missing",
                f"Check {check_id} was skipped after an earlier fail-fast failure",
                failure_codes,
            )
        ],
    }


# Environment and reports


def read_short_command(arguments: Sequence[str]) -> str:
    """Reads one bounded tool or repository fact without failing the run."""

    executable_path = shutil.which(arguments[0])
    if executable_path is None and Path(arguments[0]).is_file():
        executable_path = arguments[0]
    if executable_path is None:
        return "unknown"
    try:
        completed_process = subprocess.run(
            [executable_path, *arguments[1:]],
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
    standard_output = completed_process.stdout.strip()
    return standard_output.splitlines()[0] if standard_output else ""


def capture_environment() -> dict[str, object]:
    """Captures stable host, repository, and tool facts without private paths."""

    commit = read_short_command(("git", "rev-parse", "HEAD"))
    if not GIT_COMMIT_PATTERN.fullmatch(commit):
        commit = "0" * 40
    dirty_output = read_short_command(("git", "status", "--porcelain"))
    return {
        "repository": {
            "commit": commit,
            "dirty": dirty_output not in {"", "unknown"},
        },
        "host": {
            "architecture": platform.machine() or "unknown",
            "operatingSystem": platform.system() or "unknown",
            "release": platform.release() or "unknown",
        },
        "tools": {
            "node": read_short_command(("node", "--version")),
            "npm": read_short_command(("npm", "--version")),
            "python": platform.python_version(),
        },
        "browser": {"status": "not-recorded"},
        "gpu": {"status": "not-recorded"},
        "server": {"status": "not-recorded"},
        "featureFlags": {"status": "not-recorded"},
    }


def merge_environment_evidence(
    environment: dict[str, object],
    check: Mapping[str, object],
    structured_output: object | None,
    replacements: Mapping[str, str],
) -> None:
    """Copies only explicit adapter environment records into the run header."""

    if not isinstance(structured_output, dict):
        return
    adapter = check["adapter"]
    if adapter == "browser-smoke" and isinstance(structured_output.get("browser"), dict):
        environment["browser"] = sanitize_value(structured_output["browser"], replacements)
    if adapter == "toolchain-probe":
        runtime = structured_output.get("runtime")
        if isinstance(runtime, dict) and isinstance(runtime.get("chromium"), dict):
            environment["browser"] = sanitize_value(runtime["chromium"], replacements)
        if isinstance(runtime, dict) and isinstance(runtime.get("frontend"), dict):
            environment["server"] = sanitize_value(runtime["frontend"], replacements)
        tools = structured_output.get("tools")
        if isinstance(tools, dict):
            sanitized_tools = sanitize_value(tools, replacements)
            if isinstance(sanitized_tools, dict):
                environment["tools"] = sanitized_tools


def create_case_results(
    manifest: ValidationManifest,
    selection: ValidationSelection,
    fixture_results: Mapping[str, dict[str, object]],
    check_results: Mapping[str, dict[str, object]],
) -> list[dict[str, object]]:
    """Combines effective fixture and check outcomes into authoritative case results."""

    matrix = manifest.matrices[selection.matrix_id]
    require_manual = cast(bool, matrix["requireManualObservations"])
    case_results: list[dict[str, object]] = []
    for case_id in selection.case_ids:
        case = manifest.cases[case_id]
        fixture_ids = require_identifier_array(case["fixtureIds"], f"Case {case_id} fixtureIds")
        declared_check_ids = require_identifier_array(case["checkIds"], f"Case {case_id} checkIds")
        effective_check_ids = tuple(
            selection.superseded_checks.get(check_id, check_id)
            for check_id in declared_check_ids
        )
        failures: list[dict[str, str]] = []
        statuses = [fixture_results[fixture_id]["status"] for fixture_id in fixture_ids]
        statuses.extend(check_results[check_id]["status"] for check_id in effective_check_ids)
        for fixture_id in fixture_ids:
            failures.extend(cast(list[dict[str, str]], fixture_results[fixture_id]["failures"]))
        for check_id in effective_check_ids:
            failures.extend(cast(list[dict[str, str]], check_results[check_id]["failures"]))
        manual_steps = require_string_array(case.get("manualSteps", []), f"Case {case_id} manualSteps")
        manual_observation = "not-required"
        if require_manual and manual_steps:
            manual_observation = "not-recorded"
            statuses.append("blocked")
        if "failed" in statuses:
            status = "failed"
        elif any(value in {"blocked", "skipped"} for value in statuses):
            status = "incomplete"
        else:
            status = "passed"
        case_results.append(
            {
                "id": case_id,
                "title": case["title"],
                "status": status,
                "fixtureIds": list(fixture_ids),
                "checkIds": list(effective_check_ids),
                "expectations": dict(
                    require_mapping(
                        case["expectations"],
                        f"Case {case_id} expectations",
                    )
                ),
                "thresholds": dict(
                    require_mapping(
                        case.get("thresholds", {}),
                        f"Case {case_id} thresholds",
                    )
                ),
                "manualObservation": manual_observation,
                "failures": failures,
            }
        )
    return case_results


def count_status(records: Sequence[Mapping[str, object]], status: str) -> int:
    """Counts records having one exact status."""

    return sum(1 for record in records if record.get("status") == status)


def create_summary(
    fixture_results: Sequence[Mapping[str, object]],
    check_results: Sequence[Mapping[str, object]],
    case_results: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    """Creates stable aggregate counts used by reports and release automation."""

    return {
        "totalFixtures": len(fixture_results),
        "passedFixtures": count_status(fixture_results, "passed"),
        "failedFixtures": count_status(fixture_results, "failed"),
        "totalChecks": len(check_results),
        "passedChecks": count_status(check_results, "passed"),
        "failedChecks": count_status(check_results, "failed"),
        "blockedChecks": count_status(check_results, "blocked")
        + count_status(check_results, "skipped"),
        "totalCases": len(case_results),
        "passedCases": count_status(case_results, "passed"),
        "failedCases": count_status(case_results, "failed"),
        "incompleteCases": count_status(case_results, "incomplete"),
    }


def aggregate_failures(
    fixture_results: Sequence[Mapping[str, object]],
    check_results: Sequence[Mapping[str, object]],
) -> list[dict[str, str]]:
    """Deduplicates top-level failures while preserving deterministic order."""

    failures: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for record in (*fixture_results, *check_results):
        for failure_value in cast(list[dict[str, str]], record["failures"]):
            key = (failure_value["code"], failure_value["message"])
            if key in seen:
                continue
            seen.add(key)
            failures.append(failure_value)
    return failures


def markdown_report(result: Mapping[str, object], manifest: ValidationManifest) -> str:
    """Generates a compact human-readable summary from the canonical JSON result."""

    lines = [
        "# WebGPU Validation Result",
        "",
        f"- Run: `{result['runId']}`",
        f"- Matrix: `{result['matrix']}`",
        f"- Status: **{str(result['status']).upper()}**",
        f"- Commit: `{cast(dict[str, object], result['environment'])['repository']['commit']}`",
        "",
    ]
    baseline = result.get("baseline")
    if isinstance(baseline, dict):
        lines.extend(
            [
                "## Reviewed baseline",
                "",
                f"- Status: **{str(baseline['status']).upper()}**",
                f"- Source run: `{baseline['sourceRunId']}`",
                f"- Approved: `{baseline['approvedAtUTC']}`",
                f"- SHA-256: `{baseline['sha256']}`",
                f"- URI: `{baseline['uri']}`",
                "",
            ]
        )
    lines.extend(
        [
            "## Fixtures",
            "",
            "| ID | Status | SHA-256 | License |",
            "| --- | --- | --- | --- |",
        ]
    )
    for fixture in cast(list[dict[str, object]], result["fixtures"]):
        lines.append(
            f"| `{fixture['id']}` | {fixture['status']} | `{fixture['sha256']}` | "
            f"`{fixture['license']}` |"
        )
    lines.extend(
        [
            "",
            "## Checks",
            "",
            "| ID | Adapter | Status | Duration (ms) |",
            "| --- | --- | --- | ---: |",
        ]
    )
    for check in cast(list[dict[str, object]], result["checks"]):
        lines.append(
            f"| `{check['id']}` | `{check['adapter']}` | {check['status']} | "
            f"{check['durationMilliseconds']} |"
        )
    lines.extend(
        [
            "",
            "## Cases",
            "",
            "| ID | Status |",
            "| --- | --- |",
        ]
    )
    for case in cast(list[dict[str, object]], result["cases"]):
        lines.append(f"| `{case['id']}` | {case['status']} |")
    failures = cast(list[dict[str, str]], result["failures"])
    lines.extend(["", "## Failures", ""])
    if failures:
        for failure_value in failures:
            lines.append(f"- `{failure_value['code']}`: {failure_value['message']}")
    else:
        lines.append("None.")
    lines.extend(["", "## Manual checklist", ""])
    has_manual_steps = False
    for case_id in cast(dict[str, object], result["selection"])["caseIds"]:
        case = manifest.cases[cast(str, case_id)]
        steps = require_string_array(case.get("manualSteps", []), f"Case {case_id} manualSteps")
        if not steps:
            continue
        has_manual_steps = True
        lines.append(f"### `{case_id}`")
        lines.append("")
        for step in steps:
            lines.append(f"- [ ] {step}")
        lines.append("")
    if not has_manual_steps:
        lines.append("No manual observations are defined for this selection.")
    return "\n".join(lines).rstrip() + "\n"


def html_report(result: Mapping[str, object]) -> str:
    """Generates a standalone HTML status summary without external assets."""

    def rows(records: Sequence[Mapping[str, object]], columns: Sequence[str]) -> str:
        rendered_rows: list[str] = []
        for record in records:
            cells = "".join(
                f"<td>{html.escape(str(record.get(column, '')))}</td>"
                for column in columns
            )
            rendered_rows.append(f"<tr>{cells}</tr>")
        return "".join(rendered_rows)

    fixtures = cast(list[dict[str, object]], result["fixtures"])
    checks = cast(list[dict[str, object]], result["checks"])
    cases = cast(list[dict[str, object]], result["cases"])
    baseline = result.get("baseline")
    baseline_html = ""
    if isinstance(baseline, dict):
        baseline_html = (
            "<h2>Reviewed baseline</h2><dl>"
            f"<dt>Status</dt><dd>{html.escape(str(baseline['status']))}</dd>"
            f"<dt>Source run</dt><dd><code>{html.escape(str(baseline['sourceRunId']))}</code></dd>"
            f"<dt>Approved</dt><dd><code>{html.escape(str(baseline['approvedAtUTC']))}</code></dd>"
            f"<dt>SHA-256</dt><dd><code>{html.escape(str(baseline['sha256']))}</code></dd>"
            "</dl>"
        )
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>WebGPU validation result</title><style>"
        "body{font:14px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}"
        "table{border-collapse:collapse;width:100%;margin-bottom:2rem}"
        "th,td{border:1px solid #888;padding:.4rem;text-align:left}"
        "code{font-family:ui-monospace,monospace}</style></head><body>"
        f"<h1>WebGPU validation: {html.escape(str(result['status']))}</h1>"
        f"<p>Run <code>{html.escape(str(result['runId']))}</code>; matrix "
        f"<code>{html.escape(str(result['matrix']))}</code>.</p>"
        f"{baseline_html}"
        "<h2>Fixtures</h2><table><thead><tr><th>ID</th><th>Status</th><th>License</th>"
        f"</tr></thead><tbody>{rows(fixtures, ('id', 'status', 'license'))}</tbody></table>"
        "<h2>Checks</h2><table><thead><tr><th>ID</th><th>Adapter</th><th>Status</th>"
        f"</tr></thead><tbody>{rows(checks, ('id', 'adapter', 'status'))}</tbody></table>"
        "<h2>Cases</h2><table><thead><tr><th>ID</th><th>Status</th></tr></thead>"
        f"<tbody>{rows(cases, ('id', 'status'))}</tbody></table></body></html>\n"
    )


def manual_checklist(result: Mapping[str, object], manifest: ValidationManifest) -> str:
    """Generates a case-ID-bound manual observation form."""

    lines = [
        "# WebGPU Manual Validation Checklist",
        "",
        f"Run: `{result['runId']}`",
        "",
        "Record the browser, OS, GPU/driver, display HDR state, server version, "
        "feature flags, and fixture hash with every observation.",
        "",
    ]
    baseline = result.get("baseline")
    if isinstance(baseline, dict):
        lines.extend(
            [
                "## Baseline",
                "",
                f"- Status: **{str(baseline['status']).upper()}**",
                f"- Source run: `{baseline['sourceRunId']}`",
                f"- SHA-256: `{baseline['sha256']}`",
                "",
            ]
        )
    step_count = 0
    for case_id_value in cast(dict[str, object], result["selection"])["caseIds"]:
        case_id = cast(str, case_id_value)
        case = manifest.cases[case_id]
        steps = require_string_array(case.get("manualSteps", []), f"Case {case_id} manualSteps")
        if not steps:
            continue
        step_count += len(steps)
        lines.extend([f"## `{case_id}`", ""])
        for step in steps:
            lines.append(f"- [ ] {step}")
        lines.append("")
    if step_count == 0:
        lines.append("No manual observations are defined for this selection.")
    return "\n".join(lines).rstrip() + "\n"


def validate_result(result: Mapping[str, object], failure_codes: Mapping[str, str]) -> None:
    """Checks the emitted result's core invariants before writing it."""

    if result.get("schemaVersion") != SCHEMA_VERSION:
        raise HarnessError("Result schemaVersion is invalid")
    if result.get("status") not in {"passed", "failed", "incomplete"}:
        raise HarnessError("Result status is invalid")
    if "baseline" not in result:
        raise HarnessError("Result baseline record is missing")
    for collection_name in ("fixtures", "checks", "cases", "failures"):
        if not isinstance(result.get(collection_name), list):
            raise HarnessError(f"Result {collection_name} must be an array")
    for failure_value in cast(list[dict[str, object]], result["failures"]):
        code = failure_value.get("code")
        if code not in failure_codes:
            raise HarnessError(f"Result contains unknown failure code: {code}")


def execute_run(
    manifest: ValidationManifest,
    selection: ValidationSelection,
    *,
    output_directory: Path,
    fail_fast: bool,
    started_at: datetime | None = None,
    baseline_path: Path | None = None,
) -> dict[str, object]:
    """Executes one complete selected matrix and writes reproducible reports."""

    output_directory.mkdir(parents=True, exist_ok=False)
    evidence_directory = output_directory / "evidence"
    evidence_directory.mkdir()
    selected_checks = [manifest.checks[check_id] for check_id in selection.check_ids]
    replacements = report_replacements(selected_checks)
    environment = capture_environment()
    run_started_at = started_at or datetime.now(UTC)
    fixture_results = [
        verify_fixture(manifest.fixtures[fixture_id], manifest.failure_codes)
        for fixture_id in selection.fixture_ids
    ]
    fixture_results_by_id = {
        cast(str, fixture_result["id"]): fixture_result
        for fixture_result in fixture_results
    }
    check_results: list[dict[str, object]] = []
    check_results_by_id: dict[str, dict[str, object]] = {}
    previous_failure = False
    for check_id in selection.check_ids:
        check = manifest.checks[check_id]
        if fail_fast and previous_failure:
            check_result = skipped_check_result(check, manifest.failure_codes)
            structured_output = None
        else:
            check_result, structured_output = run_check(
                check,
                evidence_directory=evidence_directory,
                failure_codes=manifest.failure_codes,
                replacements=replacements,
            )
            merge_environment_evidence(
                environment,
                check,
                structured_output,
                replacements,
            )
        check_results.append(check_result)
        check_results_by_id[check_id] = check_result
        previous_failure = previous_failure or check_result["status"] == "failed"
    case_results = create_case_results(
        manifest,
        selection,
        fixture_results_by_id,
        check_results_by_id,
    )
    summary = create_summary(fixture_results, check_results, case_results)
    failures = aggregate_failures(fixture_results, check_results)
    manifest_record: dict[str, object] = {
        "uri": path_to_repository_uri(manifest.manifest_path),
        "sha256": manifest.manifest_sha256,
        "overlaySHA256": manifest.overlay_sha256,
        "schemaVersion": SCHEMA_VERSION,
    }
    selection_result: dict[str, object] = {
        "selectors": list(selection.selectors),
        "caseIds": list(selection.case_ids),
        "checkIds": list(selection.check_ids),
        "fixtureIds": list(selection.fixture_ids),
        "supersededChecks": dict(selection.superseded_checks),
    }
    baseline_result: dict[str, object] | None = None
    baseline_failures: list[dict[str, str]] = []
    if baseline_path is not None:
        resolved_baseline_path = baseline_path.expanduser().resolve()
        baseline = load_baseline(resolved_baseline_path)
        comparison_input: dict[str, object] = {
            "matrix": selection.matrix_id,
            "manifest": manifest_record,
            "selection": selection_result,
            "environment": environment,
            "fixtures": fixture_results,
            "checks": check_results,
            "cases": case_results,
        }
        baseline_failures = compare_baseline(
            baseline,
            comparison_input,
            manifest.failure_codes,
        )
        baseline_source = require_mapping(baseline["source"], "Baseline source")
        baseline_result = {
            "uri": baseline_report_uri(resolved_baseline_path, REPOSITORY_ROOT),
            "sha256": calculate_sha256(resolved_baseline_path),
            "sourceRunId": baseline_source["runId"],
            "approvedAtUTC": baseline["approvedAtUTC"],
            "status": "passed" if not baseline_failures else "failed",
            "failures": baseline_failures,
        }
        failures.extend(baseline_failures)
    if (
        summary["failedFixtures"]
        or summary["failedChecks"]
        or summary["failedCases"]
        or baseline_failures
    ):
        status = "failed"
    elif summary["blockedChecks"] or summary["incompleteCases"]:
        status = "incomplete"
    else:
        status = "passed"
    repository = cast(dict[str, object], environment["repository"])
    commit = cast(str, repository["commit"])
    run_id = f"{run_started_at.strftime('%Y%m%dT%H%M%SZ')}-{commit[:12]}"
    result: dict[str, object] = {
        "$schema": "scripts/webgpu/validation/result-schema.json",
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "startedAtUTC": run_started_at.isoformat(),
        "completedAtUTC": datetime.now(UTC).isoformat(),
        "status": status,
        "matrix": selection.matrix_id,
        "manifest": manifest_record,
        "selection": selection_result,
        "baseline": baseline_result,
        "environment": environment,
        "fixtures": fixture_results,
        "checks": check_results,
        "cases": case_results,
        "failures": failures,
        "summary": summary,
        "artifacts": {
            "json": "result.json",
            "markdown": "summary.md",
            "html": "summary.html",
            "manualChecklist": "manual-checklist.md",
        },
    }
    sanitized_result = sanitize_value(result, replacements)
    if not isinstance(sanitized_result, dict):
        raise HarnessError("Sanitized result is not an object")
    serialized_result = json.dumps(sanitized_result, sort_keys=True)
    leaked_environment_names = [
        environment_name
        for check in selected_checks
        for environment_name in check_environment_names(check)
        if os.environ.get(environment_name)
        and cast(str, os.environ[environment_name]) in serialized_result
    ]
    if leaked_environment_names:
        raise HarnessError(
            "Report sanitization retained declared private inputs: "
            + ", ".join(sorted(set(leaked_environment_names)))
        )
    validate_result(sanitized_result, manifest.failure_codes)
    write_json(output_directory / "result.json", sanitized_result)
    (output_directory / "summary.md").write_text(
        markdown_report(sanitized_result, manifest),
        encoding="utf-8",
    )
    (output_directory / "summary.html").write_text(
        html_report(sanitized_result),
        encoding="utf-8",
    )
    (output_directory / "manual-checklist.md").write_text(
        manual_checklist(sanitized_result, manifest),
        encoding="utf-8",
    )
    return sanitized_result


# Command-line interface


def selection_record(selection: ValidationSelection) -> dict[str, object]:
    """Serializes a dry-run selection without machine-specific data."""

    return {
        "matrix": selection.matrix_id,
        "selectors": list(selection.selectors),
        "caseIds": list(selection.case_ids),
        "checkIds": list(selection.check_ids),
        "fixtureIds": list(selection.fixture_ids),
        "supersededChecks": dict(selection.superseded_checks),
    }


def add_manifest_arguments(parser: argparse.ArgumentParser) -> None:
    """Adds canonical manifest and ignored private overlay options."""

    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST_PATH,
        help="Canonical validation manifest",
    )
    parser.add_argument(
        "--overlay",
        type=Path,
        help="Ignored private fixture/check/case overlay",
    )


def add_selection_arguments(parser: argparse.ArgumentParser) -> None:
    """Adds matrix and repeatable selector options."""

    parser.add_argument("--matrix", default="static", help="Named validation matrix")
    parser.add_argument(
        "--selector",
        action="append",
        default=[],
        help="case:, codec:, route:, gpu:, tag:, or soak selector",
    )


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the standalone validation-matrix CLI."""

    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate", help="Validate registries")
    add_manifest_arguments(validate_parser)
    validate_parser.add_argument(
        "--verify-fixtures",
        action="store_true",
        help="Also verify every registered fixture hash",
    )
    list_parser = subparsers.add_parser("list", help="List stable registry IDs")
    add_manifest_arguments(list_parser)
    list_parser.add_argument(
        "--kind",
        choices=("cases", "checks", "fixtures", "matrices"),
        default="matrices",
    )
    plan_parser = subparsers.add_parser("plan", help="Print a deduplicated run plan")
    add_manifest_arguments(plan_parser)
    add_selection_arguments(plan_parser)
    run_parser = subparsers.add_parser("run", help="Run a selected matrix")
    add_manifest_arguments(run_parser)
    add_selection_arguments(run_parser)
    run_parser.add_argument("--output", type=Path, help="Ignored result directory")
    run_parser.add_argument(
        "--baseline",
        type=Path,
        help="Read-only reviewed baseline used for strict comparison",
    )
    run_parser.add_argument("--fail-fast", action="store_true")
    approve_parser = subparsers.add_parser(
        "approve-baseline",
        help="Create or explicitly replace a reviewed baseline",
    )
    approve_parser.add_argument("--result", required=True, type=Path)
    approve_parser.add_argument("--output", required=True, type=Path)
    approve_parser.add_argument("--reviewed-by", required=True)
    approve_parser.add_argument(
        "--duration-tolerance-percent",
        required=True,
        type=int,
    )
    approve_parser.add_argument(
        "--accept-reviewed-result",
        action="store_true",
        help="Required acknowledgement that the source result was reviewed",
    )
    approve_parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="Explicitly replace an existing reviewed baseline",
    )
    return parser


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs one CLI action and reports expected errors without a traceback."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        if arguments.command == "approve-baseline":
            if not arguments.accept_reviewed_result:
                raise HarnessError(
                    "Baseline approval requires --accept-reviewed-result"
                )
            baseline = approve_baseline(
                result_path=arguments.result,
                output_path=arguments.output,
                reviewed_by=arguments.reviewed_by,
                duration_tolerance_percent=arguments.duration_tolerance_percent,
                replace_existing=arguments.replace_existing,
            )
            print(
                json.dumps(
                    {
                        "output": str(arguments.output.expanduser().resolve()),
                        "sourceRunId": cast(dict[str, object], baseline["source"])["runId"],
                        "status": "approved",
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0
        manifest = load_manifest(arguments.manifest, arguments.overlay)
        if arguments.command == "validate":
            fixture_results: list[dict[str, object]] = []
            if arguments.verify_fixtures:
                fixture_results = [
                    verify_fixture(fixture, manifest.failure_codes)
                    for fixture in manifest.fixtures.values()
                ]
                if any(result["status"] != "passed" for result in fixture_results):
                    print(json.dumps(fixture_results, indent=2, sort_keys=True))
                    return 1
            print(
                json.dumps(
                    {
                        "cases": len(manifest.cases),
                        "checks": len(manifest.checks),
                        "fixtures": len(manifest.fixtures),
                        "fixtureIntegrity": "passed" if arguments.verify_fixtures else "not-run",
                        "matrices": len(manifest.matrices),
                        "schemaVersion": SCHEMA_VERSION,
                        "status": "valid",
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0
        if arguments.command == "list":
            registry = cast(Mapping[str, dict[str, object]], getattr(manifest, arguments.kind))
            print("\n".join(sorted(registry)))
            return 0
        selection = select_matrix(manifest, arguments.matrix, arguments.selector)
        if arguments.command == "plan":
            print(json.dumps(selection_record(selection), indent=2, sort_keys=True))
            return 0
        environment = capture_environment()
        repository = cast(dict[str, object], environment["repository"])
        commit = cast(str, repository["commit"])
        run_started_at = datetime.now(UTC)
        output_directory = (
            arguments.output.expanduser().resolve()
            if arguments.output
            else DEFAULT_OUTPUT_ROOT
            / f"{run_started_at.strftime('%Y%m%dT%H%M%SZ')}-{commit[:12]}"
        )
        result = execute_run(
            manifest,
            selection,
            output_directory=output_directory,
            fail_fast=arguments.fail_fast,
            started_at=run_started_at,
            baseline_path=arguments.baseline,
        )
        print(
            json.dumps(
                {
                    "outputDirectory": str(output_directory),
                    "runId": result["runId"],
                    "status": result["status"],
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0 if result["status"] == "passed" else 1
    except (HarnessError, OSError) as error:
        print(f"WebGPU validation matrix failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
