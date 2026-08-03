"""Build deterministic validation-registry fragments from checked fixtures."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from ab_harness import HarnessError, calculate_sha256, write_json


SCHEMA_VERSION = 1
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FRAGMENT_DIRECTORY = (
    REPOSITORY_ROOT / "scripts" / "webgpu" / "validation" / "generated"
)


@dataclass(frozen=True)
class FixtureRegistrySpecification:
    """Defines one content-addressed fixture without duplicating its byte length."""

    fixture_id: str
    repository_path: str
    expected_sha256: str
    license_expression: str
    license_evidence_uri: str
    provenance: Mapping[str, object]
    media: Mapping[str, object]


def create_fixture_record(
    specification: FixtureRegistrySpecification,
    repository_root: Path = REPOSITORY_ROOT,
) -> dict[str, object]:
    """Creates one registry record from the exact checked fixture bytes."""

    fixture_path = (repository_root / specification.repository_path).resolve()
    try:
        normalized_repository_path = fixture_path.relative_to(
            repository_root.resolve()
        ).as_posix()
    except ValueError as error:
        raise HarnessError(
            f"Fixture is outside the repository: {specification.repository_path}"
        ) from error
    if not fixture_path.is_file():
        raise HarnessError(f"Fixture is missing: {specification.repository_path}")
    actual_sha256 = calculate_sha256(fixture_path)
    if actual_sha256 != specification.expected_sha256:
        raise HarnessError(
            f"Fixture hash mismatch for {specification.fixture_id}: {actual_sha256}"
        )
    return {
        "byteLength": fixture_path.stat().st_size,
        "id": specification.fixture_id,
        "license": {
            "evidence": specification.license_evidence_uri,
            "expression": specification.license_expression,
        },
        "media": copy.deepcopy(dict(specification.media)),
        "provenance": copy.deepcopy(dict(specification.provenance)),
        "sha256": actual_sha256,
        "uri": f"repo://{normalized_repository_path}",
    }


def create_fixture_registry_fragment(
    *,
    registry_id: str,
    generator_uri: str,
    specifications: Sequence[FixtureRegistrySpecification],
    repository_root: Path = REPOSITORY_ROOT,
) -> dict[str, object]:
    """Creates one versioned fragment in stable specification order."""

    fixtures: list[dict[str, object]] = []
    for specification in specifications:
        fixtures.append(create_fixture_record(specification, repository_root))
    return {
        "$schema": "scripts/webgpu/validation/fixture-registry-fragment-schema.json",
        "schemaVersion": SCHEMA_VERSION,
        "id": registry_id,
        "generator": generator_uri,
        "fixtures": fixtures,
    }


def write_or_check_fragment(
    path: Path,
    fragment: Mapping[str, object],
    *,
    check: bool,
) -> None:
    """Writes one fragment atomically or fails when checked content is stale."""

    expected_text = f"{json.dumps(fragment, indent=2, sort_keys=True)}\n"
    if check:
        if not path.is_file() or path.read_text(encoding="utf-8") != expected_text:
            raise HarnessError(f"Validation fixture registry fragment is stale: {path}")
        return
    write_json(path, fragment)
