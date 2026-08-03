"""Tests generated WebGPU validation fixture-registry fragments."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

from ab_harness import HarnessError
from generate_validation_fixture_registry import (
    MANIFEST_PATH,
    fragment_factories,
    write_or_check_manifest_references,
)
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


class FixtureRegistryTests(unittest.TestCase):
    """Covers content addressing, deterministic output, and checked references."""

    def test_derives_byte_length_and_hash_from_checked_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository_root = Path(temporary_directory)
            fixture_path = repository_root / "fixtures" / "sample.bin"
            fixture_path.parent.mkdir(parents=True)
            fixture_data = b"checked-fixture"
            fixture_path.write_bytes(fixture_data)
            specification = FixtureRegistrySpecification(
                fixture_id="sample-fixture",
                repository_path="fixtures/sample.bin",
                expected_sha256=hashlib.sha256(fixture_data).hexdigest(),
                license_expression="MIT",
                license_evidence_uri="repo://LICENSE",
                provenance={
                    "generatorArguments": ["python", "generator.py"],
                    "kind": "generated",
                    "revision": "fixture-v1",
                    "source": "unit fixture",
                },
                media={
                    "container": "raw",
                    "packetization": "unit",
                },
            )

            fragment = create_fixture_registry_fragment(
                registry_id="unit",
                generator_uri="repo://generator.py",
                specifications=(specification,),
                repository_root=repository_root,
            )

        fixtures = cast(list[dict[str, object]], fragment["fixtures"])
        fixture = fixtures[0]
        self.assertEqual(fixture["byteLength"], len(fixture_data))
        self.assertEqual(fixture["sha256"], hashlib.sha256(fixture_data).hexdigest())

    def test_write_or_check_rejects_stale_fragment(self) -> None:
        fragment = {
            "schemaVersion": 1,
            "id": "unit",
            "generator": "repo://generator.py",
            "fixtures": [],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "fragment.json"
            write_or_check_fragment(output_path, fragment, check=False)
            write_or_check_fragment(output_path, fragment, check=True)
            output_path.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(HarnessError, "stale"):
                write_or_check_fragment(output_path, fragment, check=True)

    def test_rejects_fixture_bytes_outside_the_reviewed_pin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository_root = Path(temporary_directory)
            fixture_path = repository_root / "sample.bin"
            fixture_path.write_bytes(b"unreviewed")
            specification = FixtureRegistrySpecification(
                fixture_id="sample-fixture",
                repository_path="sample.bin",
                expected_sha256="0" * 64,
                license_expression="MIT",
                license_evidence_uri="repo://LICENSE",
                provenance={},
                media={},
            )

            with self.assertRaisesRegex(HarnessError, "hash mismatch"):
                create_fixture_registry_fragment(
                    registry_id="unit",
                    generator_uri="repo://generator.py",
                    specifications=(specification,),
                    repository_root=repository_root,
                )

    def test_checked_fragments_and_manifest_references_are_current(self) -> None:
        factories = fragment_factories()
        for file_name, factory in factories:
            expected_fragment = factory()
            actual_fragment = json.loads(
                (DEFAULT_FRAGMENT_DIRECTORY / file_name).read_text(encoding="utf-8")
            )
            self.assertEqual(actual_fragment, expected_fragment)

        file_names = tuple(file_name for file_name, _factory in factories)
        write_or_check_manifest_references(file_names, check=True)
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(manifest["fixtures"], [])

    def test_registry_generation_refuses_to_discard_inline_fixture(self) -> None:
        manifest = {"fixtures": [{"id": "hand-maintained"}]}
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path = Path(temporary_directory) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with patch(
                "generate_validation_fixture_registry.MANIFEST_PATH",
                manifest_path,
            ):
                with self.assertRaisesRegex(HarnessError, "Refusing to discard"):
                    write_or_check_manifest_references(
                        ("unit.json",),
                        check=False,
                    )

            persisted_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted_manifest, manifest)


if __name__ == "__main__":
    unittest.main()
