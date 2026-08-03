"""Tests the native HEVC High Tier live-wrapper identity contracts."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import run_native_HEVC_High_Tier_live_validation as live_validation
from run_static_HDR_live_validation import LiveValidationError


class NativeHEVCHighTierLiveValidationTests(unittest.TestCase):
    """Covers manifest validation and exact path-based item discovery."""

    def create_fixture(self, directory: Path) -> tuple[Path, dict[str, object]]:
        """Creates one bounded fake fixture and its valid manifest record."""

        fixture_path = directory / "fixture.mkv"
        fixture_bytes = b"high-tier-fixture"
        fixture_path.write_bytes(fixture_bytes)
        fixture = {
            "byteLength": len(fixture_bytes),
            "expectedStaticHDRMetadataStatus": "valid",
            "expectedToneMappingPeakNits": 4_000,
            "file": fixture_path.name,
            "profileTierLevel": {
                "highTier": True,
                "levelIDC": 153,
                "profileIDC": 2,
            },
            "sha256": hashlib.sha256(fixture_bytes).hexdigest(),
        }
        manifest_path = directory / "manifest.json"
        manifest_path.write_text(
            json.dumps({"fixture": fixture, "schemaVersion": 1}),
            encoding="utf-8",
        )
        return manifest_path, fixture

    def test_loads_exact_manifest_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path, fixture = self.create_fixture(Path(temporary_directory))

            self.assertEqual(
                live_validation.load_fixture_manifest(manifest_path),
                fixture,
            )

    def test_rejects_main_tier_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path, _fixture = self.create_fixture(Path(temporary_directory))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["fixture"]["profileTierLevel"]["highTier"] = False
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaises(LiveValidationError):
                live_validation.load_fixture_manifest(manifest_path)

    def test_resolves_only_one_exact_local_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            _manifest_path, fixture = self.create_fixture(directory)
            fixture_path = directory / str(fixture["file"])

            resolved = live_validation.resolve_fixture_item(
                fixture,
                [{"Id": "private-item", "Path": str(fixture_path)}],
                directory,
            )

            self.assertEqual(resolved["itemID"], "private-item")
            self.assertEqual(Path(resolved["mediaPath"]), fixture_path.resolve())

    def test_rejects_missing_or_duplicate_item_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            _manifest_path, fixture = self.create_fixture(directory)
            fixture_path = directory / str(fixture["file"])
            with self.assertRaises(live_validation.FixtureDiscoveryPending):
                live_validation.resolve_fixture_item(fixture, [], directory)
            with self.assertRaises(LiveValidationError):
                live_validation.resolve_fixture_item(
                    fixture,
                    [
                        {"Id": "first", "Path": str(fixture_path)},
                        {"Id": "second", "Path": str(fixture_path)},
                    ],
                    directory,
                )


if __name__ == "__main__":
    unittest.main()
