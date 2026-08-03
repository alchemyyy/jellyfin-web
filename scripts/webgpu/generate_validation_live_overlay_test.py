"""Focused tests for generated private live validation overlays."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ab_harness import HarnessError
from generate_validation_live_overlay import (
    DEFAULT_CATALOG_PATH,
    catalog_summary,
    create_overlay,
    load_live_catalog,
    load_live_spec,
    persist_validated_overlay,
    validate_static_HDR_metadata,
    validate_worker_configuration,
)
from validation_matrix import REPOSITORY_ROOT, command_for_check, load_manifest


class LiveOverlayGeneratorTests(unittest.TestCase):
    """Covers catalog expansion, private-value isolation, and route constraints."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.routes, cls.exercises = load_live_catalog(DEFAULT_CATALOG_PATH)

    def create_source(self, *, include_MPV: bool = False) -> dict[str, object]:
        """Returns one exact private source specification for structure tests."""

        source: dict[str, object] = {
            "id": "private-sdr-test",
            "title": "Private SDR test",
            "routeId": "sdr-native",
            "mediaEnvironment": "WEBGPU_VALIDATION_TEST_MEDIA",
            "licenseEnvironment": "WEBGPU_VALIDATION_TEST_LICENSE",
            "licenseExpression": "LicenseRef-Private-Validation-Only",
            "itemEnvironment": "WEBGPU_VALIDATION_TEST_ITEM_ID",
            "audioPath": "disabled",
            "exerciseIds": ["lifecycle", "device-loss"],
            "provenance": {
                "kind": "generated",
                "source": "Test-only private source",
                "revision": "test-v1",
                "generatorArguments": ["unit", "test"],
            },
            "media": {
                "container": "hevc",
                "packetization": "annex-b",
                "video": {
                    "codec": "hevc",
                    "profile": "main-10-level-5.1",
                    "width": 3840,
                    "height": 2160,
                    "frameRate": 30,
                    "bitDepth": 10,
                    "chroma": "4:2:0",
                    "range": "limited",
                    "primaries": "unknown",
                    "transfer": "unknown",
                    "matrix": "unknown",
                    "progressive": True,
                },
            },
        }
        if include_MPV:
            source["MPV"] = {
                "planEnvironment": "WEBGPU_VALIDATION_TEST_MPV_PLAN"
            }
        return source

    def create_HDR_source(self) -> dict[str, object]:
        """Returns an HDR10 source with an exact static metadata expectation."""

        source = self.create_source()
        source["id"] = "private-hdr-test"
        source["title"] = "Private HDR test"
        source["routeId"] = "hdr10-native-external"
        source["media"] = {
            "container": "hevc",
            "packetization": "annex-b",
            "video": {
                "codec": "hevc",
                "profile": "main-10-level-5.1",
                "width": 3840,
                "height": 2160,
                "frameRate": 30,
                "bitDepth": 10,
                "chroma": "4:2:0",
                "range": "limited",
                "primaries": "bt2020",
                "transfer": "pq",
                "matrix": "bt2020-ncl",
                "progressive": True,
            },
        }
        source["staticHDRMetadata"] = {
            "status": "valid",
            "toneMappingPeakNits": 4000,
        }
        return source

    def write_MPV_plan(
        self, plan_path: Path, item_identifier: str = "private-item-sentinel"
    ) -> None:
        """Writes a valid private plan matching the generated source route."""

        plan = json.loads(
            (
                REPOSITORY_ROOT / "scripts/webgpu/mpv-ab-manifest.example.json"
            ).read_text(encoding="utf-8")
        )
        plan["jellyfin"]["itemId"] = item_identifier
        plan["jellyfin"]["expected"]["audioPath"] = "disabled"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

    def private_environment(self, plan_path: Path) -> dict[str, str]:
        """Returns private sentinels backed by checked repository test data."""

        return {
            "WEBGPU_SMOKE_SERVER_LOG_DIRECTORY": str(
                REPOSITORY_ROOT / "artifacts" / "private-jellyfin-logs"
            ),
            "WEBGPU_VALIDATION_TEST_ITEM_ID": "private-item-sentinel",
            "WEBGPU_VALIDATION_TEST_LICENSE": str(
                REPOSITORY_ROOT
                / "scripts/webgpu/legacy-video-decoder/LICENSE.ffmpeg.txt"
            ),
            "WEBGPU_VALIDATION_TEST_MEDIA": str(
                REPOSITORY_ROOT
                / "scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc"
            ),
            "WEBGPU_VALIDATION_TEST_MPV_PLAN": str(plan_path),
        }

    def test_catalog_has_stable_HDR_routes_and_lifecycle_exercises(self) -> None:
        summary = catalog_summary(self.routes, self.exercises)

        self.assertEqual(len(self.routes), 18)
        self.assertEqual(len(self.exercises), 8)
        self.assertIn("hdr10-native-external", self.routes)
        self.assertIn("dovi7-fel-bundled-raw", self.routes)
        self.assertIn("retention-thirty", self.exercises)
        self.assertEqual(summary["schemaVersion"], 1)

    def test_generates_valid_overlay_without_private_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path)
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "sources": [self.create_source(include_MPV=True)],
                    }
                ),
                encoding="utf-8",
            )
            output_path = temporary_path / "overlay.json"
            environment = self.private_environment(plan_path)
            with patch.dict(os.environ, environment, clear=False):
                sources = load_live_spec(
                    spec_path,
                    routes=self.routes,
                    exercises=self.exercises,
                )
                overlay = create_overlay(
                    sources,
                    routes=self.routes,
                    exercises=self.exercises,
                )
                persist_validated_overlay(overlay, output_path, overwrite=False)
                manifest = load_manifest(overlay_path=output_path)
                browser_check = manifest.checks[
                    "private-sdr-test-lifecycle-check"
                ]
                command = command_for_check(browser_check)

            serialized_overlay = output_path.read_text(encoding="utf-8")
            for private_value in environment.values():
                self.assertNotIn(private_value, serialized_overlay)
            self.assertNotIn("private-item-sentinel", serialized_overlay)
            self.assertEqual(len(overlay["fixtures"]), 1)
            self.assertEqual(len(overlay["checks"]), 3)
            self.assertEqual(len(overlay["cases"]), 3)
            self.assertEqual(len(overlay["matrices"]), 2)
            self.assertIn("private-live", manifest.matrices)
            self.assertIn("--item-id", command.arguments)
            self.assertIn("private-item-sentinel", command.arguments)
            self.assertIn("--server-log-directory", command.arguments)
            self.assertIn("--expected-play-method", command.arguments)
            self.assertIn("DirectPlay", command.arguments)
            fixture = overlay["fixtures"][0]
            self.assertEqual(
                fixture["uri"], "env://WEBGPU_VALIDATION_TEST_MEDIA"
            )
            self.assertEqual(len(fixture["sha256"]), 64)

    def test_generates_exact_static_HDR_browser_expectations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path)
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps(
                    {"schemaVersion": 1, "sources": [self.create_HDR_source()]}
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                self.private_environment(plan_path),
                clear=False,
            ):
                sources = load_live_spec(
                    spec_path,
                    routes=self.routes,
                    exercises=self.exercises,
                )
                overlay = create_overlay(
                    sources,
                    routes=self.routes,
                    exercises=self.exercises,
                )
            browser_check = next(
                check
                for check in overlay["checks"]
                if check["id"] == "private-hdr-test-lifecycle-check"
            )
            arguments = browser_check["arguments"]
            status_index = arguments.index("--expected-static-hdr-metadata-status")
            peak_index = arguments.index("--expected-static-hdr-peak-nits")
            self.assertEqual(arguments[status_index + 1], "valid")
            self.assertEqual(arguments[peak_index + 1], "4000")

    def test_rejects_static_HDR_expectation_on_SDR_route(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path)
            source = self.create_source()
            source["staticHDRMetadata"] = {
                "status": "valid",
                "toneMappingPeakNits": 4000,
            }
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps({"schemaVersion": 1, "sources": [source]}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                self.private_environment(plan_path),
                clear=False,
            ):
                with self.assertRaisesRegex(HarnessError, "ordinary PQ HDR"):
                    load_live_spec(
                        spec_path,
                        routes=self.routes,
                        exercises=self.exercises,
                    )

    def test_rejects_invalid_static_HDR_expectation_values(self) -> None:
        invalid_configurations = (
            {"status": "dynamic", "toneMappingPeakNits": 4000},
            {"status": "valid", "toneMappingPeakNits": True},
            {"status": "valid", "toneMappingPeakNits": float("inf")},
            {"status": "valid", "toneMappingPeakNits": 10001},
        )
        for configuration in invalid_configurations:
            with self.subTest(configuration=configuration):
                with self.assertRaises(HarnessError):
                    validate_static_HDR_metadata(
                        configuration,
                        route=self.routes["hdr10-native-external"],
                        label="staticHDRMetadata",
                    )

    def test_rejects_audio_switch_in_startup_exercise(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path)
            source = self.create_source()
            source["exerciseIds"] = ["startup-ten"]
            source["audioPath"] = "ready"
            source["media"]["audio"] = {
                "codec": "flac",
                "profile": "lossless",
                "sampleRate": 48000,
                "channelLayout": "stereo",
                "channelCount": 2,
                "bitsPerSample": 24,
            }
            source["audioSelection"] = {
                "streamIndex": 1,
                "expectedCodec": "flac",
                "exerciseIds": ["startup-ten"],
            }
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps({"schemaVersion": 1, "sources": [source]}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                self.private_environment(plan_path),
                clear=False,
            ):
                with self.assertRaisesRegex(HarnessError, "cannot switch audio"):
                    load_live_spec(
                        spec_path,
                        routes=self.routes,
                        exercises=self.exercises,
                    )

    def test_worker_smoke_is_limited_to_Profile_7_FEL(self) -> None:
        with self.assertRaisesRegex(HarnessError, "Profile 7 FEL"):
            validate_worker_configuration(
                {
                    "debugURLEnvironment": "WEBGPU_VALIDATION_TEST_DEBUG_URL",
                    "frontendURLEnvironment": "WEBGPU_VALIDATION_TEST_FRONTEND_URL",
                    "mediaURLEnvironment": "WEBGPU_VALIDATION_TEST_MEDIA_URL",
                },
                route=self.routes["hdr10-native-external"],
                media={"video": {"width": 3840, "height": 2160}},
                label="worker",
            )

    def test_rejects_MPV_plan_for_a_different_private_item(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path, "different-private-item")
            source = self.create_source(include_MPV=True)
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps({"schemaVersion": 1, "sources": [source]}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                self.private_environment(plan_path),
                clear=False,
            ):
                with self.assertRaisesRegex(HarnessError, "item does not match"):
                    load_live_spec(
                        spec_path,
                        routes=self.routes,
                        exercises=self.exercises,
                    )

    def test_rejects_color_metadata_that_contradicts_HDR_route(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            plan_path = temporary_path / "capture-plan.json"
            self.write_MPV_plan(plan_path)
            source = self.create_source()
            source["routeId"] = "hdr10-native-external"
            source["media"]["video"]["transfer"] = "hlg"
            spec_path = temporary_path / "spec.json"
            spec_path.write_text(
                json.dumps({"schemaVersion": 1, "sources": [source]}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                self.private_environment(plan_path),
                clear=False,
            ):
                with self.assertRaisesRegex(HarnessError, "contradicts"):
                    load_live_spec(
                        spec_path,
                        routes=self.routes,
                        exercises=self.exercises,
                    )

    def test_requires_explicit_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = Path(temporary_directory) / "overlay.json"
            output_path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(HarnessError, "--overwrite"):
                persist_validated_overlay(
                    {"schemaVersion": 1},
                    output_path,
                    overwrite=False,
                )


if __name__ == "__main__":
    unittest.main()
