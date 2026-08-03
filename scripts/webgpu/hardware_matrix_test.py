"""Focused standard-library tests for the browser/GPU hardware matrix."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

from hardware_matrix import (
    BROWSER_PROBE_PATH,
    PLAN_PATH,
    REPOSITORY_ROOT,
    VALIDATION_DIRECTORY,
    HardwareMatrixError,
    classify_vendor,
    create_empty_records,
    create_status_record,
    create_summary,
    create_unavailable_cell,
    detect_browser_installations,
    extract_authorizations,
    extract_exercises,
    extract_playback_snapshot,
    get_physical_vendors,
    load_plan,
    prepare_live_spec,
    run_json_command,
    validate_result,
)


class HardwarePlanTests(unittest.TestCase):
    """Covers the stable release axes and checked schema documents."""

    def test_plan_and_schemas_are_current(self) -> None:
        plan = load_plan()
        self.assertEqual(plan["browserFamilies"], ["chrome", "edge"])
        self.assertEqual(plan["gpuVendors"], ["nvidia", "amd", "intel"])
        self.assertEqual(
            plan["exerciseIds"],
            [
                "lifecycle",
                "device-loss",
                "paused-device-loss",
                "startup-ten",
                "retention-thirty",
            ],
        )
        for schema_name in (
            "hardware-matrix-plan-schema.json",
            "hardware-matrix-result-schema.json",
        ):
            schema = json.loads(
                (VALIDATION_DIRECTORY / schema_name).read_text(encoding="utf-8")
            )
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")

    def test_probe_and_smoke_capture_required_hardware_evidence(self) -> None:
        probe_source = BROWSER_PROBE_PATH.read_text(encoding="utf-8")
        smoke_source = (
            REPOSITORY_ROOT / "scripts/webgpu/run-browser-playback-smoke.mjs"
        ).read_text(encoding="utf-8")
        for token in (
            "SystemInfo.getInfo",
            "Browser.getVersion",
            "features: Array.from(adapter.features)",
            "copyLimits",
            "hevcMain10HighTier4K",
            "eac3_7_1",
        ):
            self.assertIn(token, probe_source)
        self.assertIn("settledRawHDRValidation", smoke_source)
        self.assertIn("settledRawDolbyVisionValidation", smoke_source)

    def test_toolchain_check_tracks_the_selected_browser_endpoint(self) -> None:
        manifest = json.loads(
            (VALIDATION_DIRECTORY / "manifest.json").read_text(encoding="utf-8")
        )
        check = next(
            record
            for record in manifest["checks"]
            if record["id"] == "local-runtime-toolchain"
        )
        self.assertEqual(
            check["environmentArguments"],
            [
                {
                    "environment": "WEBGPU_SMOKE_DEBUG_URL",
                    "option": "--debug-url",
                },
                {
                    "environment": "WEBGPU_SMOKE_FRONTEND_URL",
                    "option": "--frontend-url",
                },
            ],
        )


class HardwareDiscoveryTests(unittest.TestCase):
    """Covers explicit browser and physical-vendor discovery."""

    def test_classifies_PCI_vendor_before_text(self) -> None:
        self.assertEqual(classify_vendor({"vendorId": 0x10DE}), "nvidia")
        self.assertEqual(classify_vendor({"vendorId": 0x1002}), "amd")
        self.assertEqual(classify_vendor({"vendorId": 0x8086}), "intel")
        self.assertEqual(
            classify_vendor({"pnpDeviceID": r"PCI\VEN_10DE&DEV_2702"}),
            "nvidia",
        )
        self.assertIsNone(classify_vendor({"deviceString": "Basic Render Driver"}))

    def test_never_infers_unobserved_physical_vendors(self) -> None:
        vendors = get_physical_vendors(
            [
                {"Name": "NVIDIA GeForce", "PNPDeviceID": "PCI\\VEN_10DE"},
                {"Name": "Microsoft Basic Render Driver"},
            ]
        )
        self.assertEqual(vendors, {"nvidia"})

    def test_detects_only_existing_browser_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            chrome_path = root / "chrome.exe"
            chrome_path.touch()
            candidates = {
                "chrome": (r"%TESTROOT%\chrome.exe",),
                "edge": (r"%TESTROOT%\edge.exe",),
            }
            with patch("hardware_matrix.BROWSER_CANDIDATES", candidates):
                installations = detect_browser_installations(
                    {"TESTROOT": str(root)}
                )
        self.assertIsNotNone(installations["chrome"])
        self.assertIsNone(installations["edge"])


class LiveEvidenceTests(unittest.TestCase):
    """Covers source reuse and fail-closed browser-smoke extraction."""

    def test_prepares_all_exercises_without_mutating_the_source(self) -> None:
        source = {
            "$schema": "source-schema.json",
            "schemaVersion": 1,
            "sources": [
                {
                    "id": "fixture",
                    "exerciseIds": ["lifecycle"],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source_path = root / "source.json"
            output_path = root / "selected.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            prepare_live_spec(
                source_path,
                output_path,
                ["lifecycle", "device-loss", "retention-thirty"],
            )
            selected = json.loads(output_path.read_text(encoding="utf-8"))
            original = json.loads(source_path.read_text(encoding="utf-8"))
        self.assertEqual(original["sources"][0]["exerciseIds"], ["lifecycle"])
        self.assertEqual(
            selected["sources"][0]["exerciseIds"],
            ["lifecycle", "device-loss", "retention-thirty"],
        )

    def test_extracts_every_authorization_without_treating_absence_as_pass(self) -> None:
        authorized = {
            "status": "authorized",
            "pendingRouteKeys": [],
            "rejectedRouteKeys": [],
        }
        snapshot = {
            "externalHDRValidation": authorized,
            "settledRawHDRValidation": authorized,
            "externalDolbyVisionValidation": {"status": "authorized"},
            "settledRawDolbyVisionValidation": {"status": "authorized"},
            "profile7DolbyVisionValidation": {"status": "authorized"},
        }
        result = extract_authorizations(snapshot, "artifact://lifecycle.json")
        self.assertEqual(result["raw-hdr"]["status"], "passed")
        self.assertEqual(result["raw-dolby-vision"]["status"], "passed")
        self.assertEqual(
            result["dolby-vision-profile7-fel"]["status"], "not-run"
        )

    def test_extracts_missing_exercise_as_not_run(self) -> None:
        result = extract_exercises(
            {
                "cases": [
                    {"id": "fixture-lifecycle", "status": "passed"},
                    {"id": "fixture-device-loss", "status": "failed"},
                ]
            },
            ["lifecycle", "device-loss", "retention-thirty"],
        )
        self.assertEqual(result["lifecycle"]["status"], "passed")
        self.assertEqual(result["device-loss"]["status"], "failed")
        self.assertEqual(result["retention-thirty"]["status"], "not-run")

    def test_extracts_failed_playback_snapshot_from_bounded_diagnostics(self) -> None:
        snapshot = {
            "customPlaybackEligibility": {
                "eligible": False,
                "reason": "play-method-unsupported",
            }
        }
        evidence = {
            "diagnostics": {
                "lastObservation": {
                    "snapshot": snapshot,
                }
            }
        }
        self.assertEqual(extract_playback_snapshot(evidence), snapshot)

    def test_failed_JSON_command_uses_sanitized_process_diagnostics(self) -> None:
        completed_process = subprocess.CompletedProcess(
            args=["probe"],
            returncode=7,
            stdout="username=private",
            stderr=r"C:\private\probe failed at http://localhost:8096",
        )
        with patch("hardware_matrix.subprocess.run", return_value=completed_process):
            with self.assertRaises(HardwareMatrixError) as raised:
                run_json_command(
                    ["probe"],
                    timeout_seconds=1,
                    label="Probe",
                )
        message = str(raised.exception)
        self.assertIn("exit code 7", message)
        self.assertIn("[redacted-path]", message)
        self.assertIn("[redacted-secret]", message)
        self.assertNotIn("private", message)
        self.assertNotIn("localhost", message)


class ResultContractTests(unittest.TestCase):
    """Covers cell completeness, pass invariants, and privacy rejection."""

    @classmethod
    def create_result(cls) -> dict[str, object]:
        plan = load_plan()
        cells = []
        for browser_family in plan["browserFamilies"]:
            for GPU_vendor in plan["gpuVendors"]:
                cells.append(
                    create_unavailable_cell(
                        browser_family=browser_family,
                        browser_availability="installed",
                        browser_product="Browser/1.0",
                        browser_protocol="1.3",
                        browser_version="1.0",
                        disposition="hardware-unavailable",
                        GPU_vendor=GPU_vendor,
                        plan=plan,
                    )
                )
        return {
            "$schema": "scripts/webgpu/validation/hardware-matrix-result-schema.json",
            "schemaVersion": 1,
            "generatedAtUTC": "2026-08-03T12:00:00+00:00",
            "repository": {"commit": "1" * 40, "dirty": True},
            "host": {
                "architecture": "AMD64",
                "operatingSystem": "Windows",
                "release": "11",
            },
            "plan": {
                key: plan[key]
                for key in (
                    "browserFamilies",
                    "gpuVendors",
                    "exerciseIds",
                    "authorizationRoutes",
                )
            },
            "coverage": {
                "total": 6,
                "passed": 0,
                "failed": 0,
                "unsupported": 0,
                "notRun": 6,
            },
            "cells": cells,
        }

    def test_accepts_explicit_six_cell_not_run_result(self) -> None:
        result = self.create_result()
        validate_result(result)
        summary = create_summary(result)
        self.assertIn("chrome", summary)
        self.assertIn("not run: 6", summary)

    def test_accepts_pass_only_with_all_exercises_and_authorizations(self) -> None:
        result = self.create_result()
        first_cell = result["cells"][0]
        first_cell.update(
            {
                "status": "passed",
                "dispositionCode": "validated",
                "adapter": {
                    "vendor": "nvidia",
                    "architecture": "test",
                    "description": "test",
                    "device": "NVIDIA test GPU",
                    "isFallbackAdapter": False,
                    "driverVendor": "NVIDIA",
                    "driverVersion": "1.0",
                },
                "webGPU": {
                    "canvasFormat": "bgra8unorm",
                    "adapterFeatures": [],
                    "adapterLimits": {},
                    "deviceFeatures": [],
                    "deviceLimits": {},
                    "featureStatus": {},
                },
                "authorizations": {
                    identifier: create_status_record(
                        "passed", "artifact://lifecycle.json"
                    )
                    for identifier in result["plan"]["authorizationRoutes"]
                },
                "exercises": {
                    identifier: create_status_record(
                        "passed", "artifact://result.json"
                    )
                    for identifier in result["plan"]["exerciseIds"]
                },
            }
        )
        result["coverage"] = {
            "total": 6,
            "passed": 1,
            "failed": 0,
            "unsupported": 0,
            "notRun": 5,
        }
        validate_result(result)
        first_cell["authorizations"]["raw-hdr"] = create_status_record("not-run")
        with self.assertRaisesRegex(HardwareMatrixError, "incomplete authorizations"):
            validate_result(result)

    def test_rejects_machine_paths_and_secret_shaped_content(self) -> None:
        result = self.create_result()
        result["cells"][0]["browser"]["product"] = r"C:\private\browser.exe"
        with self.assertRaisesRegex(HardwareMatrixError, "machine path"):
            validate_result(result)
        result = self.create_result()
        result["cells"][0]["browser"]["product"] = "username=private"
        with self.assertRaisesRegex(HardwareMatrixError, "secret-shaped"):
            validate_result(result)

    def test_rejects_duplicate_or_missing_cells(self) -> None:
        result = self.create_result()
        result["cells"] = result["cells"][:-1]
        result["coverage"]["total"] = 5
        result["coverage"]["notRun"] = 5
        with self.assertRaisesRegex(HardwareMatrixError, "cover each"):
            validate_result(result)


if __name__ == "__main__":
    unittest.main()
