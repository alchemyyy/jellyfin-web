"""Focused tests for generated static HDR Jellyfin fixture discovery."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from run_static_HDR_live_validation import (
    FixtureDiscoveryPending,
    LiveValidationError,
    require_production_probe_result,
    require_private_values_absent,
    resolve_fixture_items,
)


class StaticHDRLiveValidationTests(unittest.TestCase):
    """Covers exact-path resolution and private-value rejection."""

    def test_resolves_same_named_items_only_by_exact_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            media_directory = Path(temporary_directory)
            fixture_path = media_directory / "pq-static-hdr-v1-absent-1080p24-flac.mkv"
            fixture_path.write_bytes(b"fixture")
            fixtures = [
                {
                    "byteLength": fixture_path.stat().st_size,
                    "expectedStaticHDRMetadataStatus": "absent",
                    "file": fixture_path.name,
                    "sha256": hashlib.sha256(b"fixture").hexdigest(),
                }
            ]
            items = [
                {
                    "Id": "wrong-item",
                    "Name": "pq-static",
                    "Path": str(media_directory / "another.mkv"),
                },
                {
                    "Id": "exact-item",
                    "Name": "pq-static",
                    "Path": str(fixture_path),
                },
            ]
            resolved = resolve_fixture_items(fixtures, items, media_directory)
            self.assertEqual(resolved["absent"]["itemID"], "exact-item")

    def test_reports_an_unindexed_exact_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            media_directory = Path(temporary_directory)
            fixture_path = media_directory / "fixture.mkv"
            fixture_path.write_bytes(b"fixture")
            fixtures = [
                {
                    "byteLength": 7,
                    "expectedStaticHDRMetadataStatus": "absent",
                    "file": fixture_path.name,
                    "sha256": hashlib.sha256(b"fixture").hexdigest(),
                }
            ]
            with self.assertRaises(FixtureDiscoveryPending):
                resolve_fixture_items(fixtures, [], media_directory)

    def test_rejects_private_values_in_result_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory)
            result_path = output_directory / "result.json"
            result_path.write_text('{"status":"passed"}', encoding="utf-8")
            require_private_values_absent(output_directory, ["private-item"])
            result_path.write_text('{"item":"private-item"}', encoding="utf-8")
            with self.assertRaisesRegex(LiveValidationError, "survived"):
                require_private_values_absent(output_directory, ["private-item"])

    def test_accepts_an_exact_valid_production_probe(self) -> None:
        probe = {
            "result": {
                "accessUnitCount": 16,
                "firstMetadataAccessUnitIndex": 0,
                "metadata": {
                    "masteringDisplayMaximumLuminanceNits": 4000,
                    "masteringDisplayMinimumLuminanceNits": 0.005,
                    "maximumContentLightLevelNits": 500,
                    "maximumFrameAverageLightLevelNits": 200,
                },
                "status": "valid",
            },
            "scannedByteLength": 1_232_030,
        }
        require_production_probe_result(
            json.dumps(probe),
            expected_status="valid",
            expected_peak_nits=4000,
        )

    def test_rejects_a_production_probe_status_mismatch(self) -> None:
        probe = {
            "result": {
                "accessUnitCount": 16,
                "firstMetadataAccessUnitIndex": None,
                "metadata": None,
                "status": "malformed",
            },
            "scannedByteLength": 1_232_030,
        }
        with self.assertRaisesRegex(LiveValidationError, "status mismatch"):
            require_production_probe_result(
                json.dumps(probe),
                expected_status="conflicting",
                expected_peak_nits=1000,
            )

    def test_rejects_an_out_of_bounds_production_probe(self) -> None:
        probe = {
            "result": {
                "accessUnitCount": 17,
                "firstMetadataAccessUnitIndex": None,
                "metadata": None,
                "status": "absent",
            },
            "scannedByteLength": 1,
        }
        with self.assertRaisesRegex(LiveValidationError, "access-unit bound"):
            require_production_probe_result(
                json.dumps(probe),
                expected_status="absent",
                expected_peak_nits=1000,
            )


if __name__ == "__main__":
    unittest.main()
