"""Focused tests for reviewed WebGPU validation baselines."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ab_harness import HarnessError
from validation_baseline import (
    approve_baseline,
    compare_baseline,
    load_baseline,
    maximum_duration,
    validate_baseline,
)
from validation_matrix import load_manifest


def create_result(*, dirty: bool = False) -> dict[str, object]:
    """Returns the smallest passing result accepted for baseline approval."""

    return {
        "schemaVersion": 1,
        "runId": "20260803T120000Z-0123456789ab",
        "status": "passed",
        "matrix": "unit",
        "manifest": {
            "sha256": "1" * 64,
            "overlaySHA256": None,
        },
        "selection": {
            "selectors": ["codec:dts"],
            "caseIds": ["unit-case"],
            "checkIds": ["unit-check"],
            "fixtureIds": ["unit-fixture"],
        },
        "environment": {
            "repository": {
                "commit": "2" * 40,
                "dirty": dirty,
            },
            "host": {
                "architecture": "AMD64",
                "operatingSystem": "Windows",
                "release": "11",
            },
            "tools": {"node": "v24"},
            "browser": {"product": "Chrome/151"},
            "gpu": {"vendor": "test-vendor"},
            "server": {"version": "12"},
            "featureFlags": {"customDecode": True},
        },
        "fixtures": [
            {
                "id": "unit-fixture",
                "status": "passed",
                "byteLength": 16,
                "sha256": "3" * 64,
            }
        ],
        "checks": [
            {
                "id": "unit-check",
                "status": "passed",
                "durationMilliseconds": 101,
            }
        ],
        "cases": [
            {
                "id": "unit-case",
                "status": "passed",
            }
        ],
    }


class BaselineTests(unittest.TestCase):
    """Covers explicit approval and fail-closed comparison."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.failure_codes = load_manifest().failure_codes

    def test_applies_duration_tolerance_with_integer_ceiling(self) -> None:
        self.assertEqual(maximum_duration(101, 25), 127)
        self.assertEqual(maximum_duration(0, 25), 0)

    def test_approves_clean_result_and_compares_without_commit_coupling(self) -> None:
        source_result = create_result()
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            result_path = temporary_path / "result.json"
            baseline_path = temporary_path / "baseline.json"
            result_path.write_text(json.dumps(source_result), encoding="utf-8")

            approved = approve_baseline(
                result_path=result_path,
                output_path=baseline_path,
                reviewed_by="unit-review",
                duration_tolerance_percent=25,
                replace_existing=False,
            )
            baseline = load_baseline(baseline_path)
            current_result = json.loads(json.dumps(source_result))
            current_result["environment"]["repository"]["commit"] = "4" * 40
            failures = compare_baseline(
                baseline,
                current_result,
                self.failure_codes,
            )

        self.assertEqual(approved["checks"][0]["maximumDurationMilliseconds"], 127)
        self.assertEqual(failures, [])

    def test_rejects_dirty_source_and_implicit_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            result_path = temporary_path / "result.json"
            baseline_path = temporary_path / "baseline.json"
            result_path.write_text(json.dumps(create_result(dirty=True)), encoding="utf-8")
            with self.assertRaisesRegex(HarnessError, "clean worktree"):
                approve_baseline(
                    result_path=result_path,
                    output_path=baseline_path,
                    reviewed_by="unit-review",
                    duration_tolerance_percent=25,
                    replace_existing=False,
                )

            result_path.write_text(json.dumps(create_result()), encoding="utf-8")
            baseline_path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(HarnessError, "--replace-existing"):
                approve_baseline(
                    result_path=result_path,
                    output_path=baseline_path,
                    reviewed_by="unit-review",
                    duration_tolerance_percent=25,
                    replace_existing=False,
                )
            with self.assertRaisesRegex(HarnessError, "missing required keys"):
                approve_baseline(
                    result_path=result_path,
                    output_path=baseline_path,
                    reviewed_by="unit-review",
                    duration_tolerance_percent=25,
                    replace_existing=True,
                )

    def test_rejects_tampered_threshold_environment_and_record_set(self) -> None:
        source_result = create_result()
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            result_path = temporary_path / "result.json"
            baseline_path = temporary_path / "baseline.json"
            result_path.write_text(json.dumps(source_result), encoding="utf-8")
            approved = approve_baseline(
                result_path=result_path,
                output_path=baseline_path,
                reviewed_by="unit-review",
                duration_tolerance_percent=25,
                replace_existing=False,
            )

        tampered_threshold = json.loads(json.dumps(approved))
        tampered_threshold["checks"][0]["maximumDurationMilliseconds"] += 1
        with self.assertRaisesRegex(HarnessError, "does not match its tolerance"):
            validate_baseline(tampered_threshold)

        private_environment = json.loads(json.dumps(approved))
        private_environment["environment"]["server"]["url"] = "http://localhost:8096"
        with self.assertRaisesRegex(HarnessError, "unsanitized URL"):
            validate_baseline(private_environment)

        missing_case = json.loads(json.dumps(approved))
        missing_case["cases"] = []
        with self.assertRaisesRegex(HarnessError, "do not match the source selection"):
            validate_baseline(missing_case)

    def test_detects_duration_environment_and_fixture_regressions(self) -> None:
        source_result = create_result()
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            result_path = temporary_path / "result.json"
            baseline_path = temporary_path / "baseline.json"
            result_path.write_text(json.dumps(source_result), encoding="utf-8")
            approve_baseline(
                result_path=result_path,
                output_path=baseline_path,
                reviewed_by="unit-review",
                duration_tolerance_percent=0,
                replace_existing=False,
            )
            baseline = load_baseline(baseline_path)
            current_result = json.loads(json.dumps(source_result))
            current_result["checks"][0]["durationMilliseconds"] = 102
            current_result["environment"]["gpu"]["vendor"] = "changed-vendor"
            current_result["fixtures"][0]["sha256"] = "5" * 64
            current_result["manifest"]["overlaySHA256"] = "6" * 64

            failures = compare_baseline(
                baseline,
                current_result,
                self.failure_codes,
            )

        failure_codes = [failure["code"] for failure in failures]
        self.assertIn("expectation-mismatch", failure_codes)
        self.assertIn("fixture-hash-mismatch", failure_codes)
        self.assertGreaterEqual(failure_codes.count("expectation-mismatch"), 2)


if __name__ == "__main__":
    unittest.main()
