#!/usr/bin/env python3
"""Generate content-addressed private live cases from stable route exercises."""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
from pathlib import Path
from typing import Mapping, Sequence, cast

from ab_harness import (
    HarnessError,
    calculate_sha256,
    normalize_manifest,
    read_json,
    require_integer,
    require_mapping,
    require_string,
    write_json,
)
from validation_matrix import (
    TAG_PATTERN,
    load_manifest,
    require_array,
    require_environment_name,
    require_exact_keys,
    require_identifier,
    require_identifier_array,
    require_safe_arguments,
    require_string_array,
    validate_media,
    validate_provenance,
)


SCHEMA_VERSION = 1
SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CATALOG_PATH = SCRIPT_DIRECTORY / "validation" / "live-case-catalog.json"
INCOMPATIBLE_AUDIO_SELECTION_EXERCISES = frozenset(
    {"natural-end", "retention-thirty", "startup-ten"}
)
ROUTE_DECODER_BACKENDS = frozenset({"bundled-hevc", "native"})
ROUTE_FRAME_MODES = frozenset({"raw-planes", "video-frame"})
ROUTE_PRESENTATION_ROUTES = frozenset(
    {
        "external-dolby-vision-profile5",
        "external-hdr-hlg",
        "external-hdr-pq",
        "identity-sdr",
        "raw-dolby-vision-profile5",
        "raw-dolby-vision-profile7-base-fallback",
        "raw-dolby-vision-profile7-fel",
        "raw-dolby-vision-profile7-mel",
        "raw-dolby-vision-profile8",
        "raw-hdr-hlg",
        "raw-hdr-pq",
    }
)
STATIC_HDR_METADATA_PRESENTATION_ROUTES = frozenset(
    {"external-hdr-pq", "raw-hdr-pq"}
)
STATIC_HDR_METADATA_STATUSES = frozenset(
    {"absent", "conflicting", "malformed", "valid"}
)
MAXIMUM_STATIC_HDR_PEAK_NITS = 10_000
AUDIO_ROUTE_BY_PATH = {
    "disabled": "disabled",
    "native-media": "native-media",
    "ready": "decoded-pcm",
}


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the private-overlay generator CLI."""

    parser = argparse.ArgumentParser(
        description=(
            "Generate an ignored private validation overlay without recording local paths, "
            "item IDs, URLs, or credentials."
        )
    )
    parser.add_argument("--spec", help="Ignored live source specification JSON")
    parser.add_argument("--output", help="Ignored output overlay JSON")
    parser.add_argument(
        "--catalog",
        default=str(DEFAULT_CATALOG_PATH),
        help="Stable route and lifecycle catalog",
    )
    parser.add_argument(
        "--list-catalog",
        action="store_true",
        help="Print route and exercise IDs without requiring private inputs",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing ignored output explicitly",
    )
    return parser


def require_tags(value: object, label: str) -> tuple[str, ...]:
    """Returns a duplicate-free validated tag tuple."""

    tags = require_string_array(value, label, allow_empty=False)
    for tag_index, tag in enumerate(tags):
        if not TAG_PATTERN.fullmatch(tag):
            raise HarnessError(f"{label}[{tag_index}] is not a valid tag")
    return tags


def require_thresholds(value: object, label: str) -> dict[str, float | int]:
    """Returns bounded numeric threshold fields without accepting booleans."""

    thresholds = require_mapping(value, label)
    normalized: dict[str, float | int] = {}
    for name, threshold in thresholds.items():
        if not isinstance(name, str) or not name:
            raise HarnessError(f"{label} contains an invalid threshold name")
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
            raise HarnessError(f"{label}.{name} must be numeric")
        normalized[name] = threshold
    return normalized


def load_live_catalog(
    catalog_path: Path,
) -> tuple[dict[str, dict[str, object]], dict[str, dict[str, object]]]:
    """Loads and strictly validates the stable route and exercise catalog."""

    catalog = require_mapping(read_json(catalog_path), "Live case catalog")
    require_exact_keys(
        catalog,
        required=frozenset({"schemaVersion", "routes", "exercises"}),
        optional=frozenset({"$schema"}),
        label="Live case catalog",
    )
    if catalog["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError("Live case catalog schemaVersion is unsupported")

    routes: dict[str, dict[str, object]] = {}
    for route_index, route_value in enumerate(require_array(catalog["routes"], "Routes")):
        label = f"Routes[{route_index}]"
        route = require_mapping(route_value, label)
        require_exact_keys(
            route,
            required=frozenset(
                {
                    "id",
                    "title",
                    "decoderBackend",
                    "frameMode",
                    "presentationRoute",
                    "tags",
                }
            ),
            optional=frozenset(),
            label=label,
        )
        route_identifier = require_identifier(route["id"], f"{label}.id")
        require_string(route["title"], f"{label}.title")
        decoder_backend = require_string(
            route["decoderBackend"], f"{label}.decoderBackend"
        )
        frame_mode = require_string(route["frameMode"], f"{label}.frameMode")
        presentation_route = require_string(
            route["presentationRoute"], f"{label}.presentationRoute"
        )
        if decoder_backend not in ROUTE_DECODER_BACKENDS:
            raise HarnessError(f"{label}.decoderBackend is unsupported")
        if frame_mode not in ROUTE_FRAME_MODES:
            raise HarnessError(f"{label}.frameMode is unsupported")
        if presentation_route not in ROUTE_PRESENTATION_ROUTES:
            raise HarnessError(f"{label}.presentationRoute is unsupported")
        require_tags(route["tags"], f"{label}.tags")
        if route_identifier in routes:
            raise HarnessError(f"Live case catalog has duplicate route {route_identifier}")
        routes[route_identifier] = dict(route)

    exercises: dict[str, dict[str, object]] = {}
    for exercise_index, exercise_value in enumerate(
        require_array(catalog["exercises"], "Exercises")
    ):
        label = f"Exercises[{exercise_index}]"
        exercise = require_mapping(exercise_value, label)
        require_exact_keys(
            exercise,
            required=frozenset(
                {
                    "id",
                    "title",
                    "arguments",
                    "timeoutSeconds",
                    "fallback",
                    "tags",
                    "thresholds",
                }
            ),
            optional=frozenset(),
            label=label,
        )
        exercise_identifier = require_identifier(exercise["id"], f"{label}.id")
        require_string(exercise["title"], f"{label}.title")
        require_safe_arguments(exercise["arguments"], f"{label}.arguments")
        require_integer(exercise["timeoutSeconds"], f"{label}.timeoutSeconds", 1, 7_200)
        require_string(exercise["fallback"], f"{label}.fallback")
        require_tags(exercise["tags"], f"{label}.tags")
        require_thresholds(exercise["thresholds"], f"{label}.thresholds")
        if exercise_identifier in exercises:
            raise HarnessError(
                f"Live case catalog has duplicate exercise {exercise_identifier}"
            )
        exercises[exercise_identifier] = dict(exercise)
    return routes, exercises


def require_environment_value(environment_name: str, label: str) -> str:
    """Returns one present private value without including it in diagnostics."""

    value = os.environ.get(environment_name)
    if not value:
        raise HarnessError(f"{label} requires environment input {environment_name}")
    return value


def require_environment_file(environment_name: str, label: str) -> Path:
    """Returns one existing private file resolved from an environment variable."""

    value = require_environment_value(environment_name, label)
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise HarnessError(f"{label} environment input is not an existing file")
    return path


def validate_audio_selection(
    value: object,
    *,
    source_exercise_ids: tuple[str, ...],
    audio_path: str,
    label: str,
) -> dict[str, object]:
    """Validates an exact stream-switch expectation and its exercise scope."""

    selection = require_mapping(value, label)
    required_keys = frozenset({"streamIndex", "expectedCodec", "exerciseIds"})
    shape_keys = frozenset(
        {
            "sourceChannelCount",
            "sourceSampleRate",
            "outputChannelCount",
            "outputSampleRate",
        }
    )
    require_exact_keys(
        selection,
        required=required_keys,
        optional=shape_keys,
        label=label,
    )
    require_integer(selection["streamIndex"], f"{label}.streamIndex", 0, 10_000)
    require_string(selection["expectedCodec"], f"{label}.expectedCodec")
    exercise_ids = require_identifier_array(
        selection["exerciseIds"], f"{label}.exerciseIds", allow_empty=False
    )
    unknown_exercise_ids = sorted(set(exercise_ids) - set(source_exercise_ids))
    if unknown_exercise_ids:
        raise HarnessError(
            f"{label}.exerciseIds are not selected by the source: "
            + ", ".join(unknown_exercise_ids)
        )
    incompatible_exercise_ids = sorted(
        set(exercise_ids) & INCOMPATIBLE_AUDIO_SELECTION_EXERCISES
    )
    if incompatible_exercise_ids:
        raise HarnessError(
            f"{label}.exerciseIds cannot switch audio in: "
            + ", ".join(incompatible_exercise_ids)
        )
    if audio_path == "disabled":
        raise HarnessError(f"{label} requires an enabled audio path")
    present_shape_keys = shape_keys & frozenset(selection)
    if present_shape_keys and present_shape_keys != shape_keys:
        raise HarnessError(f"{label} must define every source/output audio shape field")
    for shape_key in shape_keys:
        if shape_key in selection:
            maximum = 32 if "ChannelCount" in shape_key else 192_000
            require_integer(selection[shape_key], f"{label}.{shape_key}", 1, maximum)
    return dict(selection)


def validate_MPV_configuration(
    value: object,
    *,
    audio_path: str,
    item_environment: str,
    route: Mapping[str, object],
    label: str,
) -> dict[str, object]:
    """Validates a private mpv plan against the source route and item."""

    configuration = require_mapping(value, label)
    require_exact_keys(
        configuration,
        required=frozenset({"planEnvironment"}),
        optional=frozenset(),
        label=label,
    )
    environment_name = require_environment_name(
        configuration["planEnvironment"], f"{label}.planEnvironment"
    )
    plan_path = require_environment_file(environment_name, f"{label}.planEnvironment")
    plan = normalize_manifest(read_json(plan_path))
    jellyfin = cast(Mapping[str, object], plan["jellyfin"])
    expected = cast(Mapping[str, object], jellyfin["expected"])
    item_identifier = require_environment_value(item_environment, f"{label}.item")
    if jellyfin["itemId"] != item_identifier:
        raise HarnessError(f"{label} item does not match the source item environment")
    exact_expectations = {
        "audioPath": audio_path,
        "videoDecoder": route["decoderBackend"],
        "videoOutput": route["frameMode"],
    }
    for expectation_name, expectation_value in exact_expectations.items():
        if expected[expectation_name] != expectation_value:
            raise HarnessError(
                f"{label} {expectation_name} does not match the source route"
            )
    return dict(configuration)


def validate_worker_configuration(
    value: object,
    *,
    route: Mapping[str, object],
    media: Mapping[str, object],
    label: str,
) -> dict[str, object]:
    """Validates the exact Profile 7 FEL worker-smoke inputs."""

    configuration = require_mapping(value, label)
    require_exact_keys(
        configuration,
        required=frozenset(
            {"debugURLEnvironment", "frontendURLEnvironment", "mediaURLEnvironment"}
        ),
        optional=frozenset({"workerURLEnvironment"}),
        label=label,
    )
    if route["presentationRoute"] != "raw-dolby-vision-profile7-fel":
        raise HarnessError(f"{label} is supported only for a Profile 7 FEL route")
    if not isinstance(media.get("video"), dict):
        raise HarnessError(f"{label} requires video geometry")
    for environment_key, environment_value in configuration.items():
        environment_name = require_environment_name(
            environment_value, f"{label}.{environment_key}"
        )
        require_environment_value(environment_name, f"{label}.{environment_key}")
    return dict(configuration)


def validate_route_media_contract(
    route: Mapping[str, object], media: Mapping[str, object], label: str
) -> None:
    """Rejects private media metadata that contradicts the selected route."""

    video_value = media.get("video")
    if not isinstance(video_value, dict):
        raise HarnessError(f"{label} requires video metadata")
    video = cast(Mapping[str, object], video_value)
    presentation_route = cast(str, route["presentationRoute"])
    expected_transfer: str | None = None
    if presentation_route in {"external-hdr-pq", "raw-hdr-pq"}:
        expected_transfer = "pq"
    elif presentation_route in {"external-hdr-hlg", "raw-hdr-hlg"}:
        expected_transfer = "hlg"
    if expected_transfer is None:
        return
    exact_metadata = {
        "bitDepth": 10,
        "chroma": "4:2:0",
        "matrix": "bt2020-ncl",
        "primaries": "bt2020",
        "range": "limited",
        "transfer": expected_transfer,
    }
    for metadata_name, expected_value in exact_metadata.items():
        if video.get(metadata_name) != expected_value:
            raise HarnessError(
                f"{label}.video.{metadata_name} contradicts the selected HDR route"
            )


def validate_static_HDR_metadata(
    value: object,
    *,
    route: Mapping[str, object],
    label: str,
) -> dict[str, object]:
    """Validates one exact bounded static HDR scan expectation."""

    configuration = require_mapping(value, label)
    require_exact_keys(
        configuration,
        required=frozenset({"status", "toneMappingPeakNits"}),
        optional=frozenset(),
        label=label,
    )
    presentation_route = cast(str, route["presentationRoute"])
    if presentation_route not in STATIC_HDR_METADATA_PRESENTATION_ROUTES:
        raise HarnessError(
            f"{label} is supported only for ordinary PQ HDR presentation routes"
        )
    status = require_string(configuration["status"], f"{label}.status")
    if status not in STATIC_HDR_METADATA_STATUSES:
        raise HarnessError(f"{label}.status is unsupported")
    peak_nits = configuration["toneMappingPeakNits"]
    if (
        isinstance(peak_nits, bool)
        or not isinstance(peak_nits, (int, float))
        or not math.isfinite(peak_nits)
        or peak_nits < 1
        or peak_nits > MAXIMUM_STATIC_HDR_PEAK_NITS
    ):
        raise HarnessError(
            f"{label}.toneMappingPeakNits must be between 1 and "
            f"{MAXIMUM_STATIC_HDR_PEAK_NITS}"
        )
    return {"status": status, "toneMappingPeakNits": peak_nits}


def load_live_spec(
    spec_path: Path,
    *,
    routes: Mapping[str, dict[str, object]],
    exercises: Mapping[str, dict[str, object]],
) -> list[dict[str, object]]:
    """Loads private source records while keeping their values out of output JSON."""

    spec = require_mapping(read_json(spec_path), "Live overlay specification")
    require_exact_keys(
        spec,
        required=frozenset({"schemaVersion", "sources"}),
        optional=frozenset({"$schema"}),
        label="Live overlay specification",
    )
    if spec["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError("Live overlay specification schemaVersion is unsupported")

    sources: list[dict[str, object]] = []
    source_identifiers: set[str] = set()
    for source_index, source_value in enumerate(require_array(spec["sources"], "Sources")):
        label = f"Sources[{source_index}]"
        source = require_mapping(source_value, label)
        require_exact_keys(
            source,
            required=frozenset(
                {
                    "id",
                    "title",
                    "routeId",
                    "mediaEnvironment",
                    "licenseEnvironment",
                    "licenseExpression",
                    "itemEnvironment",
                    "audioPath",
                    "exerciseIds",
                    "provenance",
                    "media",
                }
            ),
            optional=frozenset(
                {"audioSelection", "MPV", "staticHDRMetadata", "worker"}
            ),
            label=label,
        )
        source_identifier = require_identifier(source["id"], f"{label}.id")
        if source_identifier in source_identifiers:
            raise HarnessError(f"Live overlay specification has duplicate source {source_identifier}")
        source_identifiers.add(source_identifier)
        require_string(source["title"], f"{label}.title")
        route_identifier = require_identifier(source["routeId"], f"{label}.routeId")
        route = routes.get(route_identifier)
        if route is None:
            raise HarnessError(f"{label}.routeId does not exist in the catalog")
        exercise_ids = require_identifier_array(
            source["exerciseIds"], f"{label}.exerciseIds", allow_empty=False
        )
        missing_exercise_ids = sorted(set(exercise_ids) - set(exercises))
        if missing_exercise_ids:
            raise HarnessError(
                f"{label}.exerciseIds do not exist in the catalog: "
                + ", ".join(missing_exercise_ids)
            )
        media_environment = require_environment_name(
            source["mediaEnvironment"], f"{label}.mediaEnvironment"
        )
        license_environment = require_environment_name(
            source["licenseEnvironment"], f"{label}.licenseEnvironment"
        )
        item_environment = require_environment_name(
            source["itemEnvironment"], f"{label}.itemEnvironment"
        )
        require_environment_file(media_environment, f"{label}.mediaEnvironment")
        require_environment_file(license_environment, f"{label}.licenseEnvironment")
        require_environment_value(item_environment, f"{label}.itemEnvironment")
        require_string(source["licenseExpression"], f"{label}.licenseExpression")
        validate_provenance(source["provenance"], f"{label}.provenance")
        validate_media(source["media"], f"{label}.media")
        media = require_mapping(source["media"], f"{label}.media")
        validate_route_media_contract(route, media, f"{label}.media")
        audio_path = require_string(source["audioPath"], f"{label}.audioPath")
        if audio_path not in AUDIO_ROUTE_BY_PATH:
            raise HarnessError(f"{label}.audioPath is unsupported")
        if audio_path != "disabled" and "audio" not in media:
            raise HarnessError(f"{label}.audioPath requires exact audio metadata")

        normalized_source = dict(source)
        if "staticHDRMetadata" in source:
            normalized_source["staticHDRMetadata"] = validate_static_HDR_metadata(
                source["staticHDRMetadata"],
                route=route,
                label=f"{label}.staticHDRMetadata",
            )
        if "audioSelection" in source:
            normalized_source["audioSelection"] = validate_audio_selection(
                source["audioSelection"],
                source_exercise_ids=exercise_ids,
                audio_path=audio_path,
                label=f"{label}.audioSelection",
            )
        if "MPV" in source:
            normalized_source["MPV"] = validate_MPV_configuration(
                source["MPV"],
                audio_path=audio_path,
                item_environment=item_environment,
                route=route,
                label=f"{label}.MPV",
            )
        if "worker" in source:
            normalized_source["worker"] = validate_worker_configuration(
                source["worker"],
                route=route,
                media=media,
                label=f"{label}.worker",
            )
        sources.append(normalized_source)
    if not sources:
        raise HarnessError("Live overlay specification must contain at least one source")
    return sources


def audio_selection_arguments(
    selection: Mapping[str, object] | None,
    exercise_identifier: str,
) -> list[str]:
    """Builds exact audio-switch arguments only for their declared exercises."""

    arguments: list[str] = []
    if selection is None:
        return arguments
    exercise_ids = cast(list[str], selection["exerciseIds"])
    if exercise_identifier not in exercise_ids:
        return arguments
    arguments.extend(
        [
            "--audio-stream-index",
            str(selection["streamIndex"]),
            "--expected-audio-codec",
            cast(str, selection["expectedCodec"]),
        ]
    )
    shape_options = (
        ("sourceChannelCount", "--expected-audio-source-channels"),
        ("sourceSampleRate", "--expected-audio-source-rate"),
        ("outputChannelCount", "--expected-audio-output-channels"),
        ("outputSampleRate", "--expected-audio-output-rate"),
    )
    for field_name, option_name in shape_options:
        if field_name in selection:
            arguments.extend([option_name, str(selection[field_name])])
    return arguments


def create_fixture(source: Mapping[str, object]) -> dict[str, object]:
    """Creates one exact private fixture record without copying its local path."""

    source_identifier = cast(str, source["id"])
    media_environment = cast(str, source["mediaEnvironment"])
    license_environment = cast(str, source["licenseEnvironment"])
    media_path = require_environment_file(media_environment, "Private media fixture")
    return {
        "id": f"{source_identifier}-media",
        "uri": f"env://{media_environment}",
        "byteLength": media_path.stat().st_size,
        "sha256": calculate_sha256(media_path),
        "license": {
            "expression": source["licenseExpression"],
            "evidence": f"env://{license_environment}",
        },
        "provenance": copy.deepcopy(source["provenance"]),
        "media": copy.deepcopy(source["media"]),
    }


def create_browser_records(
    source: Mapping[str, object],
    route: Mapping[str, object],
    exercise: Mapping[str, object],
    fixture_identifier: str,
) -> tuple[dict[str, object], dict[str, object]]:
    """Creates one browser adapter and its authoritative live case."""

    source_identifier = cast(str, source["id"])
    exercise_identifier = cast(str, exercise["id"])
    record_identifier = f"{source_identifier}-{exercise_identifier}"
    check_identifier = f"{record_identifier}-check"
    arguments = [
        "--expected-video-output",
        cast(str, route["frameMode"]),
        "--expected-video-decoder",
        cast(str, route["decoderBackend"]),
        "--expected-presentation-route",
        cast(str, route["presentationRoute"]),
        "--expected-play-method",
        "DirectPlay",
        "--expected-audio",
        cast(str, source["audioPath"]),
    ]
    static_HDR_metadata = source.get("staticHDRMetadata")
    if static_HDR_metadata is not None:
        static_HDR_configuration = cast(Mapping[str, object], static_HDR_metadata)
        arguments.extend(
            [
                "--expected-static-hdr-metadata-status",
                cast(str, static_HDR_configuration["status"]),
                "--expected-static-hdr-peak-nits",
                str(static_HDR_configuration["toneMappingPeakNits"]),
            ]
        )
    arguments.extend(cast(list[str], exercise["arguments"]))
    selection = source.get("audioSelection")
    arguments.extend(
        audio_selection_arguments(
            cast(Mapping[str, object] | None, selection),
            exercise_identifier,
        )
    )
    item_environment = cast(str, source["itemEnvironment"])
    check = {
        "id": check_identifier,
        "title": f"{source['title']}: {exercise['title']}",
        "adapter": "browser-smoke",
        "timeoutSeconds": exercise["timeoutSeconds"],
        "requiredEnvironment": [
            item_environment,
            "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY",
            "WEBGPU_SMOKE_USERNAME",
            "WEBGPU_SMOKE_PASSWORD",
        ],
        "environmentArguments": [
            {"option": "--item-id", "environment": item_environment},
            {
                "option": "--server-log-directory",
                "environment": "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY",
            },
        ],
        "arguments": arguments,
        "resultFormat": "json",
        "resultAssertions": [
            {"path": "/status", "operator": "equals", "value": "passed"},
            {"path": "/failures", "operator": "empty"},
        ],
        "tags": ["live", *cast(list[str], exercise["tags"])],
    }
    tags = list(
        dict.fromkeys(
            [
                "live",
                "private",
                *cast(list[str], route["tags"]),
                *cast(list[str], exercise["tags"]),
            ]
        )
    )
    case = {
        "id": record_identifier,
        "title": f"{source['title']}: {exercise['title']}",
        "fixtureIds": [fixture_identifier],
        "checkIds": [check_identifier],
        "tags": tags,
        "expectations": {
            "capability": "supported",
            "decoderBackend": route["decoderBackend"],
            "frameMode": route["frameMode"],
            "presentationRoute": route["presentationRoute"],
            "fallback": exercise["fallback"],
            "audioRoute": AUDIO_ROUTE_BY_PATH[cast(str, source["audioPath"])],
            "jellyfinPlayMethod": "DirectPlay",
            "permittedTranscodeReasons": [],
        },
        "thresholds": copy.deepcopy(exercise["thresholds"]),
    }
    return check, case


def create_MPV_records(
    source: Mapping[str, object], fixture_identifier: str
) -> tuple[dict[str, object], dict[str, object]]:
    """Creates one portable mpv/browser A/B check using only environment paths."""

    source_identifier = cast(str, source["id"])
    configuration = cast(Mapping[str, object], source["MPV"])
    plan_environment = cast(str, configuration["planEnvironment"])
    media_environment = cast(str, source["mediaEnvironment"])
    check_identifier = f"{source_identifier}-mpv-ab-check"
    check = {
        "id": check_identifier,
        "title": f"{source['title']}: browser versus mpv A/B",
        "adapter": "mpv-ab",
        "timeoutSeconds": 7200,
        "requiredEnvironment": [
            plan_environment,
            media_environment,
            "WEBGPU_AB_USERNAME",
            "WEBGPU_AB_PASSWORD",
        ],
        "environmentArguments": [
            {"option": "--manifest", "environment": plan_environment},
            {"option": "--source", "environment": media_environment},
        ],
        "resultFormat": "json",
        "resultAssertions": [
            {"path": "/status", "operator": "equals", "value": "completed"}
        ],
        "tags": ["live", "reference:mpv"],
    }
    case = {
        "id": f"{source_identifier}-mpv-ab",
        "title": f"{source['title']}: browser versus mpv A/B",
        "fixtureIds": [fixture_identifier],
        "checkIds": [check_identifier],
        "tags": ["live", "private", "reference:mpv"],
        "expectations": {
            "capability": "supported",
            "decoderBackend": "reference-comparison",
            "frameMode": "captured-frames",
            "presentationRoute": "browser-versus-mpv",
            "fallback": "none",
            "audioRoute": AUDIO_ROUTE_BY_PATH[cast(str, source["audioPath"])],
            "jellyfinPlayMethod": "DirectPlay",
            "permittedTranscodeReasons": [],
        },
    }
    return check, case


def create_worker_records(
    source: Mapping[str, object], fixture_identifier: str
) -> tuple[dict[str, object], dict[str, object]]:
    """Creates one exact Profile 7 FEL worker integration case."""

    source_identifier = cast(str, source["id"])
    configuration = cast(Mapping[str, object], source["worker"])
    video = cast(Mapping[str, object], cast(Mapping[str, object], source["media"])["video"])
    environment_arguments = [
        {
            "option": "--debug-url",
            "environment": configuration["debugURLEnvironment"],
        },
        {
            "option": "--frontend-url",
            "environment": configuration["frontendURLEnvironment"],
        },
        {
            "option": "--media-url",
            "environment": configuration["mediaURLEnvironment"],
        },
    ]
    if "workerURLEnvironment" in configuration:
        environment_arguments.append(
            {
                "option": "--worker-url",
                "environment": configuration["workerURLEnvironment"],
            }
        )
    required_environment = [
        cast(str, configuration["debugURLEnvironment"]),
        cast(str, configuration["frontendURLEnvironment"]),
        cast(str, configuration["mediaURLEnvironment"]),
    ]
    if "workerURLEnvironment" in configuration:
        required_environment.append(cast(str, configuration["workerURLEnvironment"]))
    check_identifier = f"{source_identifier}-worker-check"
    check = {
        "id": check_identifier,
        "title": f"{source['title']}: Profile 7 FEL worker integration",
        "adapter": "worker-smoke",
        "timeoutSeconds": 600,
        "requiredEnvironment": required_environment,
        "environmentArguments": environment_arguments,
        "arguments": [
            "--expected-base-width",
            str(video["width"]),
            "--expected-base-height",
            str(video["height"]),
        ],
        "resultFormat": "json",
        "resultAssertions": [
            {"path": "/status", "operator": "equals", "value": "passed"},
            {"path": "/failures", "operator": "empty"},
        ],
        "tags": ["live", "profile:dovi-p7-fel", "route:worker"],
    }
    case = {
        "id": f"{source_identifier}-worker",
        "title": f"{source['title']}: Profile 7 FEL worker integration",
        "fixtureIds": [fixture_identifier],
        "checkIds": [check_identifier],
        "tags": [
            "live",
            "private",
            "profile:dovi-p7-fel",
            "route:worker",
        ],
        "expectations": {
            "capability": "supported",
            "decoderBackend": "worker-integration",
            "frameMode": "raw-planes",
            "presentationRoute": "profile7-fel-worker",
            "fallback": "none",
            "audioRoute": "disabled",
            "jellyfinPlayMethod": "not-applicable",
            "permittedTranscodeReasons": [],
        },
    }
    return check, case


def create_overlay(
    sources: Sequence[Mapping[str, object]],
    *,
    routes: Mapping[str, dict[str, object]],
    exercises: Mapping[str, dict[str, object]],
) -> dict[str, object]:
    """Expands private sources through the stable live exercise catalog."""

    fixtures: list[dict[str, object]] = []
    checks: list[dict[str, object]] = []
    cases: list[dict[str, object]] = []
    matrices: list[dict[str, object]] = []
    all_case_identifiers: list[str] = []
    for source in sources:
        source_identifier = cast(str, source["id"])
        fixture = create_fixture(source)
        fixture_identifier = cast(str, fixture["id"])
        fixtures.append(fixture)
        source_case_identifiers: list[str] = []
        route = routes[cast(str, source["routeId"])]
        for exercise_identifier in cast(list[str], source["exerciseIds"]):
            check, case = create_browser_records(
                source,
                route,
                exercises[exercise_identifier],
                fixture_identifier,
            )
            checks.append(check)
            cases.append(case)
            source_case_identifiers.append(cast(str, case["id"]))
        if "MPV" in source:
            check, case = create_MPV_records(source, fixture_identifier)
            checks.append(check)
            cases.append(case)
            source_case_identifiers.append(cast(str, case["id"]))
        if "worker" in source:
            check, case = create_worker_records(source, fixture_identifier)
            checks.append(check)
            cases.append(case)
            source_case_identifiers.append(cast(str, case["id"]))
        source_matrix_identifier = f"{source_identifier}-live"
        matrices.append(
            {
                "id": source_matrix_identifier,
                "title": f"{source['title']}: complete private live matrix",
                "caseIds": source_case_identifiers,
                "requiredCheckIds": ["local-runtime-toolchain"],
                "requireManualObservations": False,
            }
        )
        all_case_identifiers.extend(source_case_identifiers)
    if any(matrix["id"] == "private-live" for matrix in matrices):
        raise HarnessError("Source IDs must not produce the reserved private-live matrix ID")
    matrices.append(
        {
            "id": "private-live",
            "title": "Complete private live WebGPU validation",
            "caseIds": all_case_identifiers,
            "requiredCheckIds": ["local-runtime-toolchain"],
            "requireManualObservations": False,
        }
    )
    return {
        "$schema": "scripts/webgpu/validation/overlay-schema.json",
        "schemaVersion": SCHEMA_VERSION,
        "fixtures": fixtures,
        "checks": checks,
        "cases": cases,
        "matrices": matrices,
    }


def persist_validated_overlay(
    overlay: Mapping[str, object],
    output_path: Path,
    *,
    overwrite: bool,
) -> None:
    """Validates through the production loader before atomically publishing output."""

    output_path = output_path.expanduser().resolve()
    if output_path.exists() and not overwrite:
        raise HarnessError("Output already exists; pass --overwrite to replace it")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    try:
        write_json(temporary_path, overlay)
        load_manifest(overlay_path=temporary_path)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def catalog_summary(
    routes: Mapping[str, dict[str, object]],
    exercises: Mapping[str, dict[str, object]],
) -> dict[str, object]:
    """Returns a stable navigation summary without private values."""

    return {
        "schemaVersion": SCHEMA_VERSION,
        "routes": [
            {"id": route_identifier, "title": routes[route_identifier]["title"]}
            for route_identifier in sorted(routes)
        ],
        "exercises": [
            {
                "id": exercise_identifier,
                "title": exercises[exercise_identifier]["title"],
            }
            for exercise_identifier in sorted(exercises)
        ],
    }


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Lists the catalog or generates one validated private overlay."""

    catalog_path = Path(arguments.catalog).expanduser().resolve()
    routes, exercises = load_live_catalog(catalog_path)
    if arguments.list_catalog:
        return catalog_summary(routes, exercises)
    if not arguments.spec or not arguments.output:
        raise HarnessError("--spec and --output are required unless --list-catalog is used")
    sources = load_live_spec(
        Path(arguments.spec).expanduser().resolve(),
        routes=routes,
        exercises=exercises,
    )
    overlay = create_overlay(sources, routes=routes, exercises=exercises)
    output_path = Path(arguments.output).expanduser().resolve()
    persist_validated_overlay(overlay, output_path, overwrite=arguments.overwrite)
    return {
        "caseCount": len(cast(list[object], overlay["cases"])),
        "checkCount": len(cast(list[object], overlay["checks"])),
        "fixtureCount": len(cast(list[object], overlay["fixtures"])),
        "matrixCount": len(cast(list[object], overlay["matrices"])),
        "overlaySHA256": calculate_sha256(output_path),
        "schemaVersion": SCHEMA_VERSION,
        "status": "generated",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the generator without printing private environment values on failure."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (HarnessError, OSError, ValueError) as error:
        print(f"Live validation overlay generation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
