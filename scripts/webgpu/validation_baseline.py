"""Reviewed baseline approval and comparison for WebGPU validation results."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, cast

from ab_harness import (
    HarnessError,
    calculate_sha256,
    read_json,
    require_integer,
    require_mapping,
    require_string,
    write_json,
)


SCHEMA_VERSION = 1
IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40,64}$")
RUN_IDENTIFIER_PATTERN = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}$")
URL_PATTERN = re.compile(r"\b(?:https?|wss?)://", re.IGNORECASE)
WINDOWS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:[\\/]")
MAXIMUM_REVIEWER_LENGTH = 128
MAXIMUM_DURATION_TOLERANCE_PERCENT = 1_000


def require_exact_keys(
    value: Mapping[str, object],
    *,
    required: frozenset[str],
    optional: frozenset[str],
    label: str,
) -> None:
    """Rejects missing and unknown baseline keys."""

    keys = frozenset(value)
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise HarnessError(f"{label} is missing required keys: {', '.join(missing)}")
    if unknown:
        raise HarnessError(f"{label} contains unknown keys: {', '.join(unknown)}")


def require_array(value: object, label: str) -> list[object]:
    """Returns one JSON array."""

    if not isinstance(value, list):
        raise HarnessError(f"{label} must be an array")
    return cast(list[object], value)


def require_identifier(value: object, label: str) -> str:
    """Returns one stable lowercase identifier."""

    identifier = require_string(value, label)
    if not IDENTIFIER_PATTERN.fullmatch(identifier):
        raise HarnessError(f"{label} is not a valid identifier")
    return identifier


def require_identifier_array(value: object, label: str) -> tuple[str, ...]:
    """Returns one duplicate-free identifier tuple."""

    identifiers = tuple(
        require_identifier(item, f"{label}[{item_index}]")
        for item_index, item in enumerate(require_array(value, label))
    )
    if len(set(identifiers)) != len(identifiers):
        raise HarnessError(f"{label} must not contain duplicates")
    return identifiers


def require_sha256(value: object, label: str) -> str:
    """Returns one lowercase SHA-256 digest."""

    digest = require_string(value, label)
    if not SHA256_PATTERN.fullmatch(digest):
        raise HarnessError(f"{label} must be lowercase SHA-256")
    return digest


def require_optional_sha256(value: object, label: str) -> str | None:
    """Returns a lowercase SHA-256 digest or JSON null."""

    if value is None:
        return None
    return require_sha256(value, label)


def require_utc_datetime(value: object, label: str) -> str:
    """Returns one ISO 8601 timestamp with an explicit UTC offset."""

    timestamp = require_string(value, label)
    try:
        parsed_timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise HarnessError(f"{label} must be an ISO 8601 date-time") from error
    if parsed_timestamp.utcoffset() != UTC.utcoffset(parsed_timestamp):
        raise HarnessError(f"{label} must use UTC")
    return timestamp


def require_passed_records(
    value: object,
    label: str,
) -> list[dict[str, object]]:
    """Returns uniquely identified passed result records."""

    records: list[dict[str, object]] = []
    identifiers: set[str] = set()
    for record_index, record_value in enumerate(require_array(value, label)):
        record = require_mapping(record_value, f"{label}[{record_index}]")
        record_id = require_identifier(record.get("id"), f"{label}[{record_index}].id")
        if record_id in identifiers:
            raise HarnessError(f"{label} contains duplicate ID: {record_id}")
        if record.get("status") != "passed":
            raise HarnessError(f"{label} record {record_id} did not pass")
        identifiers.add(record_id)
        records.append(record)
    return records


def baseline_environment(result: Mapping[str, object]) -> dict[str, object]:
    """Removes commit and dirty state from the reusable environment identity."""

    environment = require_mapping(result.get("environment"), "Result environment")
    reusable_environment = {
        key: value
        for key, value in environment.items()
        if key != "repository"
    }
    normalized_environment = cast(
        dict[str, object],
        json.loads(json.dumps(reusable_environment, sort_keys=True)),
    )
    validate_sanitized_environment(normalized_environment)
    return normalized_environment


def validate_sanitized_environment(environment: Mapping[str, object]) -> None:
    """Rejects private URLs and machine paths in reusable baseline evidence."""

    serialized_environment = json.dumps(environment, sort_keys=True)
    if URL_PATTERN.search(serialized_environment):
        raise HarnessError("Baseline environment contains an unsanitized URL")
    if WINDOWS_PATH_PATTERN.search(serialized_environment):
        raise HarnessError("Baseline environment contains an unsanitized machine path")


def maximum_duration(baseline_milliseconds: int, tolerance_percent: int) -> int:
    """Applies an integer percentage tolerance with an exact ceiling."""

    numerator = baseline_milliseconds * (100 + tolerance_percent)
    return (numerator + 99) // 100


def approve_baseline(
    *,
    result_path: Path,
    output_path: Path,
    reviewed_by: str,
    duration_tolerance_percent: int,
    replace_existing: bool,
) -> dict[str, object]:
    """Creates one baseline only from an explicitly reviewed clean passing result."""

    if not reviewed_by.strip() or len(reviewed_by) > MAXIMUM_REVIEWER_LENGTH:
        raise HarnessError(
            f"Baseline reviewer must contain from 1 through {MAXIMUM_REVIEWER_LENGTH} characters"
        )
    if any(character in reviewed_by for character in ("\x00", "\r", "\n")):
        raise HarnessError("Baseline reviewer must not contain control characters")
    if (
        duration_tolerance_percent < 0
        or duration_tolerance_percent > MAXIMUM_DURATION_TOLERANCE_PERCENT
    ):
        raise HarnessError(
            "Baseline duration tolerance must be from 0 through "
            f"{MAXIMUM_DURATION_TOLERANCE_PERCENT} percent"
        )
    resolved_result_path = result_path.expanduser().resolve()
    resolved_output_path = output_path.expanduser().resolve()
    if resolved_output_path == resolved_result_path:
        raise HarnessError("Baseline output must not replace its source result")
    if resolved_output_path.exists() and not replace_existing:
        raise HarnessError(
            "Baseline output already exists; pass --replace-existing only after review"
        )
    if resolved_output_path.exists() and replace_existing:
        load_baseline(resolved_output_path)
    result = require_mapping(read_json(resolved_result_path), "Baseline source result")
    if result.get("schemaVersion") != SCHEMA_VERSION:
        raise HarnessError(f"Baseline source result schemaVersion must be {SCHEMA_VERSION}")
    if result.get("status") != "passed":
        raise HarnessError("A baseline can only be approved from a passing result")
    repository = require_mapping(
        require_mapping(result.get("environment"), "Result environment").get("repository"),
        "Result repository",
    )
    commit = require_string(repository.get("commit"), "Result commit")
    if not COMMIT_PATTERN.fullmatch(commit):
        raise HarnessError("Result commit is invalid")
    if repository.get("dirty") is not False:
        raise HarnessError("A baseline can only be approved from a clean worktree result")
    run_id = require_string(result.get("runId"), "Result runId")
    if not RUN_IDENTIFIER_PATTERN.fullmatch(run_id):
        raise HarnessError("Result runId is invalid")
    matrix_id = require_identifier(result.get("matrix"), "Result matrix")
    manifest = require_mapping(result.get("manifest"), "Result manifest")
    manifest_sha256 = require_sha256(manifest.get("sha256"), "Result manifest SHA-256")
    overlay_sha256 = require_optional_sha256(
        manifest.get("overlaySHA256"),
        "Result overlay SHA-256",
    )
    selection = require_mapping(result.get("selection"), "Result selection")
    case_ids = require_identifier_array(selection.get("caseIds"), "Result caseIds")
    check_ids = require_identifier_array(selection.get("checkIds"), "Result checkIds")
    fixture_ids = require_identifier_array(selection.get("fixtureIds"), "Result fixtureIds")
    selectors = tuple(
        require_string(selector, f"Result selectors[{selector_index}]")
        for selector_index, selector in enumerate(
            require_array(selection.get("selectors"), "Result selectors")
        )
    )
    fixture_records = require_passed_records(result.get("fixtures"), "Result fixtures")
    check_records = require_passed_records(result.get("checks"), "Result checks")
    case_records = require_passed_records(result.get("cases"), "Result cases")
    if set(case_ids) != {cast(str, record["id"]) for record in case_records}:
        raise HarnessError("Result case records do not match the selected case IDs")
    if set(check_ids) != {cast(str, record["id"]) for record in check_records}:
        raise HarnessError("Result check records do not match the selected check IDs")
    if set(fixture_ids) != {cast(str, record["id"]) for record in fixture_records}:
        raise HarnessError("Result fixture records do not match the selected fixture IDs")
    fixtures: list[dict[str, object]] = []
    for record in sorted(fixture_records, key=lambda item: cast(str, item["id"])):
        fixtures.append(
            {
                "id": record["id"],
                "status": "passed",
                "byteLength": require_integer(
                    record.get("byteLength"),
                    f"Fixture {record['id']} byteLength",
                    1,
                ),
                "sha256": require_sha256(
                    record.get("sha256"),
                    f"Fixture {record['id']} SHA-256",
                ),
            }
        )
    checks: list[dict[str, object]] = []
    for record in sorted(check_records, key=lambda item: cast(str, item["id"])):
        duration_milliseconds = require_integer(
            record.get("durationMilliseconds"),
            f"Check {record['id']} durationMilliseconds",
            0,
        )
        checks.append(
            {
                "id": record["id"],
                "status": "passed",
                "baselineDurationMilliseconds": duration_milliseconds,
                "maximumDurationMilliseconds": maximum_duration(
                    duration_milliseconds,
                    duration_tolerance_percent,
                ),
            }
        )
    cases = [
        {"id": record["id"], "status": "passed"}
        for record in sorted(case_records, key=lambda item: cast(str, item["id"]))
    ]
    baseline: dict[str, object] = {
        "$schema": "scripts/webgpu/validation/baseline-schema.json",
        "schemaVersion": SCHEMA_VERSION,
        "approvedAtUTC": datetime.now(UTC).isoformat(),
        "reviewedBy": reviewed_by,
        "source": {
            "runId": run_id,
            "resultSHA256": calculate_sha256(resolved_result_path),
            "commit": commit,
            "dirty": False,
            "manifestSHA256": manifest_sha256,
            "overlaySHA256": overlay_sha256,
            "matrix": matrix_id,
            "selection": {
                "selectors": list(selectors),
                "caseIds": list(case_ids),
                "checkIds": list(check_ids),
                "fixtureIds": list(fixture_ids),
            },
        },
        "tolerances": {
            "durationRegressionPercent": duration_tolerance_percent,
        },
        "environment": baseline_environment(result),
        "fixtures": fixtures,
        "checks": checks,
        "cases": cases,
    }
    validate_baseline(baseline)
    write_json(resolved_output_path, baseline)
    return baseline


def validate_baseline(value: object) -> dict[str, object]:
    """Validates one reviewed baseline without widening its schema."""

    baseline = require_mapping(value, "Baseline")
    require_exact_keys(
        baseline,
        required=frozenset(
            {
                "schemaVersion",
                "approvedAtUTC",
                "reviewedBy",
                "source",
                "tolerances",
                "environment",
                "fixtures",
                "checks",
                "cases",
            }
        ),
        optional=frozenset({"$schema"}),
        label="Baseline",
    )
    if baseline["schemaVersion"] != SCHEMA_VERSION:
        raise HarnessError(f"Baseline schemaVersion must be {SCHEMA_VERSION}")
    require_utc_datetime(baseline["approvedAtUTC"], "Baseline approvedAtUTC")
    reviewer = require_string(baseline["reviewedBy"], "Baseline reviewedBy")
    if not reviewer.strip() or len(reviewer) > MAXIMUM_REVIEWER_LENGTH:
        raise HarnessError("Baseline reviewedBy must contain a reviewer label")
    if any(character in reviewer for character in ("\x00", "\r", "\n")):
        raise HarnessError("Baseline reviewedBy must not contain control characters")
    source = require_mapping(baseline["source"], "Baseline source")
    require_exact_keys(
        source,
        required=frozenset(
            {
                "runId",
                "resultSHA256",
                "commit",
                "dirty",
                "manifestSHA256",
                "overlaySHA256",
                "matrix",
                "selection",
            }
        ),
        optional=frozenset(),
        label="Baseline source",
    )
    if not RUN_IDENTIFIER_PATTERN.fullmatch(
        require_string(source["runId"], "Baseline source runId")
    ):
        raise HarnessError("Baseline source runId is invalid")
    require_sha256(source["resultSHA256"], "Baseline source resultSHA256")
    commit = require_string(source["commit"], "Baseline source commit")
    if not COMMIT_PATTERN.fullmatch(commit):
        raise HarnessError("Baseline source commit is invalid")
    if source["dirty"] is not False:
        raise HarnessError("Baseline source dirty must be false")
    require_sha256(source["manifestSHA256"], "Baseline source manifestSHA256")
    require_optional_sha256(
        source["overlaySHA256"],
        "Baseline source overlaySHA256",
    )
    require_identifier(source["matrix"], "Baseline source matrix")
    selection = require_mapping(source["selection"], "Baseline source selection")
    require_exact_keys(
        selection,
        required=frozenset({"selectors", "caseIds", "checkIds", "fixtureIds"}),
        optional=frozenset(),
        label="Baseline source selection",
    )
    for selector_index, selector in enumerate(
        require_array(selection["selectors"], "Baseline source selectors")
    ):
        require_string(selector, f"Baseline source selectors[{selector_index}]")
    case_ids = require_identifier_array(selection["caseIds"], "Baseline source caseIds")
    check_ids = require_identifier_array(selection["checkIds"], "Baseline source checkIds")
    fixture_ids = require_identifier_array(
        selection["fixtureIds"],
        "Baseline source fixtureIds",
    )
    tolerances = require_mapping(baseline["tolerances"], "Baseline tolerances")
    require_exact_keys(
        tolerances,
        required=frozenset({"durationRegressionPercent"}),
        optional=frozenset(),
        label="Baseline tolerances",
    )
    duration_tolerance_percent = require_integer(
        tolerances["durationRegressionPercent"],
        "Baseline durationRegressionPercent",
        0,
        MAXIMUM_DURATION_TOLERANCE_PERCENT,
    )
    environment = require_mapping(baseline["environment"], "Baseline environment")
    validate_sanitized_environment(environment)
    validate_fixture_records(baseline["fixtures"])
    validate_check_records(baseline["checks"])
    validate_case_records(baseline["cases"])
    for check_value in require_array(baseline["checks"], "Baseline checks"):
        check = require_mapping(check_value, "Baseline check")
        baseline_duration = cast(int, check["baselineDurationMilliseconds"])
        expected_maximum_duration = maximum_duration(
            baseline_duration,
            duration_tolerance_percent,
        )
        if check["maximumDurationMilliseconds"] != expected_maximum_duration:
            raise HarnessError(
                f"Baseline check {check['id']} maximum duration does not match its tolerance"
            )
    fixture_records = index_result_records(baseline["fixtures"], "Baseline fixtures")
    check_records = index_result_records(baseline["checks"], "Baseline checks")
    case_records = index_result_records(baseline["cases"], "Baseline cases")
    if set(fixture_ids) != set(fixture_records):
        raise HarnessError("Baseline fixtures do not match the source selection")
    if set(check_ids) != set(check_records):
        raise HarnessError("Baseline checks do not match the source selection")
    if set(case_ids) != set(case_records):
        raise HarnessError("Baseline cases do not match the source selection")
    return baseline


def validate_fixture_records(value: object) -> None:
    """Validates exact baseline fixture identities."""

    identifiers: set[str] = set()
    for record_index, record_value in enumerate(require_array(value, "Baseline fixtures")):
        record = require_mapping(record_value, f"Baseline fixtures[{record_index}]")
        require_exact_keys(
            record,
            required=frozenset({"id", "status", "byteLength", "sha256"}),
            optional=frozenset(),
            label=f"Baseline fixtures[{record_index}]",
        )
        record_id = require_identifier(record["id"], f"Baseline fixtures[{record_index}].id")
        if record_id in identifiers:
            raise HarnessError(f"Baseline fixtures contains duplicate ID: {record_id}")
        identifiers.add(record_id)
        if record["status"] != "passed":
            raise HarnessError(f"Baseline fixture {record_id} status must be passed")
        require_integer(record["byteLength"], f"Baseline fixture {record_id} byteLength", 1)
        require_sha256(record["sha256"], f"Baseline fixture {record_id} SHA-256")


def validate_check_records(value: object) -> None:
    """Validates baseline check timing thresholds."""

    identifiers: set[str] = set()
    for record_index, record_value in enumerate(require_array(value, "Baseline checks")):
        record = require_mapping(record_value, f"Baseline checks[{record_index}]")
        require_exact_keys(
            record,
            required=frozenset(
                {
                    "id",
                    "status",
                    "baselineDurationMilliseconds",
                    "maximumDurationMilliseconds",
                }
            ),
            optional=frozenset(),
            label=f"Baseline checks[{record_index}]",
        )
        record_id = require_identifier(record["id"], f"Baseline checks[{record_index}].id")
        if record_id in identifiers:
            raise HarnessError(f"Baseline checks contains duplicate ID: {record_id}")
        identifiers.add(record_id)
        if record["status"] != "passed":
            raise HarnessError(f"Baseline check {record_id} status must be passed")
        baseline_duration = require_integer(
            record["baselineDurationMilliseconds"],
            f"Baseline check {record_id} baseline duration",
            0,
        )
        maximum_duration = require_integer(
            record["maximumDurationMilliseconds"],
            f"Baseline check {record_id} maximum duration",
            0,
        )
        if maximum_duration < baseline_duration:
            raise HarnessError(
                f"Baseline check {record_id} maximum duration is below its baseline"
            )


def validate_case_records(value: object) -> None:
    """Validates exact baseline case statuses."""

    identifiers: set[str] = set()
    for record_index, record_value in enumerate(require_array(value, "Baseline cases")):
        record = require_mapping(record_value, f"Baseline cases[{record_index}]")
        require_exact_keys(
            record,
            required=frozenset({"id", "status"}),
            optional=frozenset(),
            label=f"Baseline cases[{record_index}]",
        )
        record_id = require_identifier(record["id"], f"Baseline cases[{record_index}].id")
        if record_id in identifiers:
            raise HarnessError(f"Baseline cases contains duplicate ID: {record_id}")
        identifiers.add(record_id)
        if record["status"] != "passed":
            raise HarnessError(f"Baseline case {record_id} status must be passed")


def load_baseline(path: Path) -> dict[str, object]:
    """Loads and validates a reviewed baseline file."""

    return validate_baseline(read_json(path.expanduser().resolve()))


def failure(
    code: str,
    message: str,
    failure_codes: Mapping[str, str],
) -> dict[str, str]:
    """Creates one vocabulary-checked baseline comparison failure."""

    if code not in failure_codes:
        raise HarnessError(f"Baseline comparison referenced unknown failure code: {code}")
    return {"code": code, "message": message}


def index_result_records(value: object, label: str) -> dict[str, dict[str, object]]:
    """Indexes current result records by stable ID."""

    records: dict[str, dict[str, object]] = {}
    for record_index, record_value in enumerate(require_array(value, label)):
        record = require_mapping(record_value, f"{label}[{record_index}]")
        record_id = require_identifier(record.get("id"), f"{label}[{record_index}].id")
        if record_id in records:
            raise HarnessError(f"{label} contains duplicate ID: {record_id}")
        records[record_id] = record
    return records


def compare_baseline(
    baseline: Mapping[str, object],
    result: Mapping[str, object],
    failure_codes: Mapping[str, str],
) -> list[dict[str, str]]:
    """Compares one current run against an immutable reviewed baseline."""

    failures: list[dict[str, str]] = []
    source = require_mapping(baseline["source"], "Baseline source")
    manifest = require_mapping(result.get("manifest"), "Result manifest")
    if manifest.get("sha256") != source["manifestSHA256"]:
        failures.append(
            failure(
                "expectation-mismatch",
                "Current manifest SHA-256 differs from the reviewed baseline",
                failure_codes,
            )
        )
    if manifest.get("overlaySHA256") != source["overlaySHA256"]:
        failures.append(
            failure(
                "expectation-mismatch",
                "Current overlay SHA-256 differs from the reviewed baseline",
                failure_codes,
            )
        )
    if result.get("matrix") != source["matrix"]:
        failures.append(
            failure(
                "expectation-mismatch",
                "Current matrix differs from the reviewed baseline",
                failure_codes,
            )
        )
    source_selection = require_mapping(source["selection"], "Baseline selection")
    result_selection = require_mapping(result.get("selection"), "Result selection")
    for selection_key in ("selectors", "caseIds", "checkIds", "fixtureIds"):
        if result_selection.get(selection_key) != source_selection[selection_key]:
            failures.append(
                failure(
                    "expectation-mismatch",
                    f"Current {selection_key} differ from the reviewed baseline",
                    failure_codes,
                )
            )
    if baseline_environment(result) != baseline["environment"]:
        failures.append(
            failure(
                "expectation-mismatch",
                "Current runtime environment differs from the reviewed baseline",
                failure_codes,
            )
        )
    result_fixtures = index_result_records(result.get("fixtures"), "Result fixtures")
    for baseline_fixture_value in require_array(baseline["fixtures"], "Baseline fixtures"):
        baseline_fixture = require_mapping(baseline_fixture_value, "Baseline fixture")
        fixture_id = cast(str, baseline_fixture["id"])
        current_fixture = result_fixtures.get(fixture_id)
        if current_fixture is None:
            failures.append(
                failure(
                    "fixture-missing",
                    f"Current result is missing baseline fixture {fixture_id}",
                    failure_codes,
                )
            )
            continue
        if current_fixture.get("sha256") != baseline_fixture["sha256"]:
            failures.append(
                failure(
                    "fixture-hash-mismatch",
                    f"Current fixture {fixture_id} differs from the reviewed baseline",
                    failure_codes,
                )
            )
        if current_fixture.get("byteLength") != baseline_fixture["byteLength"]:
            failures.append(
                failure(
                    "fixture-size-mismatch",
                    f"Current fixture {fixture_id} byte length differs from the reviewed baseline",
                    failure_codes,
                )
            )
        if current_fixture.get("status") != "passed":
            failures.append(
                failure(
                    "expectation-mismatch",
                    f"Current fixture {fixture_id} did not pass",
                    failure_codes,
                )
            )
    result_checks = index_result_records(result.get("checks"), "Result checks")
    for baseline_check_value in require_array(baseline["checks"], "Baseline checks"):
        baseline_check = require_mapping(baseline_check_value, "Baseline check")
        check_id = cast(str, baseline_check["id"])
        current_check = result_checks.get(check_id)
        if current_check is None:
            failures.append(
                failure(
                    "required-check-missing",
                    f"Current result is missing baseline check {check_id}",
                    failure_codes,
                )
            )
            continue
        if current_check.get("status") != "passed":
            failures.append(
                failure(
                    "expectation-mismatch",
                    f"Current check {check_id} did not pass",
                    failure_codes,
                )
            )
        current_duration = current_check.get("durationMilliseconds")
        maximum_duration = baseline_check["maximumDurationMilliseconds"]
        if (
            isinstance(current_duration, bool)
            or not isinstance(current_duration, int)
            or current_duration > maximum_duration
        ):
            failures.append(
                failure(
                    "expectation-mismatch",
                    f"Current check {check_id} exceeded its reviewed duration threshold",
                    failure_codes,
                )
            )
    result_cases = index_result_records(result.get("cases"), "Result cases")
    for baseline_case_value in require_array(baseline["cases"], "Baseline cases"):
        baseline_case = require_mapping(baseline_case_value, "Baseline case")
        case_id = cast(str, baseline_case["id"])
        current_case = result_cases.get(case_id)
        if current_case is None:
            failures.append(
                failure(
                    "required-case-missing",
                    f"Current result is missing baseline case {case_id}",
                    failure_codes,
                )
            )
        elif current_case.get("status") != "passed":
            failures.append(
                failure(
                    "expectation-mismatch",
                    f"Current case {case_id} did not pass",
                    failure_codes,
                )
            )
    return failures


def baseline_report_uri(path: Path, repository_root: Path) -> str:
    """Reports a repository baseline URI without exposing private paths."""

    resolved_path = path.expanduser().resolve()
    try:
        relative_path = resolved_path.relative_to(repository_root.resolve())
    except ValueError:
        return "private-baseline"
    return f"repo://{relative_path.as_posix()}"
