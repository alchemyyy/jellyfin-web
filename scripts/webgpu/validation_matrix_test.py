"""Focused standard-library tests for the unified WebGPU validation matrix."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ab_harness import HarnessError
from validation_matrix import (
    REPOSITORY_ROOT,
    VALIDATION_DIRECTORY,
    ValidationManifest,
    ValidationSelection,
    assertion_matches,
    calculate_effective_manifest_sha256,
    case_matches_selectors,
    classify_structured_failures,
    command_for_check,
    execute_run,
    load_fixture_registry_fragments,
    load_manifest,
    merge_environment_evidence,
    repository_path,
    report_replacements,
    run_check,
    sanitize_value,
    select_matrix,
    validate_check,
    verify_fixture,
)


class ManifestTests(unittest.TestCase):
    """Covers checked schemas, references, selectors, and deduplication."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = load_manifest()

    def test_checked_schema_documents_and_manifest_are_current(self) -> None:
        schema_names = (
            "baseline-schema.json",
            "failure-codes-schema.json",
            "failure-codes.json",
            "fixture-registry-fragment-schema.json",
            "overlay-schema.json",
            "result-schema.json",
            "schema.json",
        )
        for schema_name in schema_names:
            value = json.loads(
                (VALIDATION_DIRECTORY / schema_name).read_text(encoding="utf-8")
            )
            if schema_name == "failure-codes.json":
                self.assertEqual(value["schemaVersion"], 1)
            else:
                self.assertIn("$schema", value)

        self.assertEqual(len(self.manifest.fixtures), 15)
        self.assertEqual(len(self.manifest.fixture_registry_sha256), 4)
        self.assertNotEqual(
            self.manifest.manifest_sha256,
            self.manifest.manifest_source_sha256,
        )
        self.assertEqual(len(self.manifest.cases), 15)
        self.assertEqual(len(self.manifest.checks), 15)
        self.assertEqual(set(self.manifest.matrices), {"checkpoint", "release", "static"})
        for fixture in self.manifest.fixtures.values():
            result = verify_fixture(fixture, self.manifest.failure_codes)
            self.assertEqual(result["status"], "passed", result)

    def test_effective_manifest_digest_covers_registry_content(self) -> None:
        source_sha256 = "1" * 64
        original_digest = calculate_effective_manifest_sha256(
            source_sha256,
            {"repo://registry.json": "2" * 64},
        )
        changed_digest = calculate_effective_manifest_sha256(
            source_sha256,
            {"repo://registry.json": "3" * 64},
        )
        ordered_digest = calculate_effective_manifest_sha256(
            source_sha256,
            {
                "repo://first.json": "4" * 64,
                "repo://second.json": "5" * 64,
            },
        )
        reversed_digest = calculate_effective_manifest_sha256(
            source_sha256,
            {
                "repo://second.json": "5" * 64,
                "repo://first.json": "4" * 64,
            },
        )

        self.assertNotEqual(original_digest, changed_digest)
        self.assertNotEqual(ordered_digest, reversed_digest)

    def test_rejects_environment_backed_canonical_registry_fragment(self) -> None:
        with self.assertRaisesRegex(HarnessError, "must use repo"):
            load_fixture_registry_fragments(
                {
                    "fixtureRegistryFragments": ["env://PRIVATE_REGISTRY"],
                    "fixtures": [],
                }
            )

    def test_selects_codec_cases_and_deduplicates_shared_checks(self) -> None:
        dts_selection = select_matrix(
            self.manifest,
            "static",
            ("codec:dts",),
        )
        self.assertEqual(len(dts_selection.case_ids), 8)
        self.assertEqual(
            dts_selection.check_ids.count("dts-fixtures-current"),
            1,
        )
        self.assertIn("vitest-codec-contracts", dts_selection.check_ids)

        audio_selection = select_matrix(
            self.manifest,
            "static",
            ("codec:dts", "codec:truehd"),
        )
        self.assertEqual(len(audio_selection.case_ids), 12)

    def test_release_selection_uses_full_suite_supersession(self) -> None:
        selection = select_matrix(self.manifest, "release")

        self.assertIn("full-vitest", selection.check_ids)
        self.assertNotIn("vitest-codec-contracts", selection.check_ids)
        self.assertEqual(
            selection.superseded_checks["vitest-codec-contracts"],
            "full-vitest",
        )
        self.assertLess(
            selection.check_ids.index("production-build"),
            selection.check_ids.index("production-codec-artifacts"),
        )

    def test_selector_axes_are_or_within_and_across_axes(self) -> None:
        case = self.manifest.cases["dts-core-5-1-48k-matroska-route"]

        self.assertTrue(case_matches_selectors(case, ("codec:dts",)))
        self.assertTrue(
            case_matches_selectors(
                case,
                ("codec:dts", "codec:truehd", "route:libdcadec"),
            )
        )
        self.assertFalse(
            case_matches_selectors(case, ("codec:dts", "route:openjpeg"))
        )

    def test_rejects_duplicate_overlay_records(self) -> None:
        duplicate_fixture = self.manifest.fixtures["dts-core-5-1-48k"]
        with tempfile.TemporaryDirectory() as temporary_directory:
            overlay_path = Path(temporary_directory) / "overlay.json"
            overlay_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "fixtures": [duplicate_fixture],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(HarnessError, "duplicate ID"):
                load_manifest(overlay_path=overlay_path)

    def test_appends_environment_backed_private_case(self) -> None:
        source_fixture = self.manifest.fixtures["dts-core-5-1-48k"]
        private_fixture = dict(source_fixture)
        private_fixture["id"] = "private-dts-fixture"
        private_fixture["uri"] = "env://WEBGPU_VALIDATION_TEST_PRIVATE_MEDIA"
        source_case = self.manifest.cases["dts-core-5-1-48k-exact"]
        private_case = dict(source_case)
        private_case["id"] = "private-dts-case"
        private_case["fixtureIds"] = ["private-dts-fixture"]
        private_media_path = (
            REPOSITORY_ROOT
            / "scripts/webgpu/dts/fixtures/core_51_24_48_768_0.dtshd"
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            overlay_path = Path(temporary_directory) / "overlay.json"
            overlay_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "fixtures": [private_fixture],
                        "cases": [private_case],
                        "matrices": [
                            {
                                "id": "private-unit",
                                "title": "Private unit",
                                "caseIds": ["private-dts-case"],
                                "requiredCheckIds": [],
                                "requireManualObservations": False,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"WEBGPU_VALIDATION_TEST_PRIVATE_MEDIA": str(private_media_path)},
                clear=False,
            ):
                manifest = load_manifest(overlay_path=overlay_path)
                selection = select_matrix(manifest, "private-unit")
                result = verify_fixture(
                    manifest.fixtures["private-dts-fixture"],
                    manifest.failure_codes,
                )

        self.assertEqual(selection.case_ids, ("private-dts-case",))
        self.assertEqual(result["status"], "passed")

    def test_rejects_repository_path_traversal(self) -> None:
        with self.assertRaisesRegex(HarnessError, "traverse"):
            repository_path("scripts/../package.json", "test path")

    def test_rejects_environment_arguments_outside_adapter_whitelist(self) -> None:
        invalid_check = {
            "id": "invalid-worker",
            "title": "Invalid worker",
            "adapter": "worker-smoke",
            "timeoutSeconds": 30,
            "environmentArguments": [
                {
                    "option": "--arbitrary-script",
                    "environment": "WEBGPU_VALIDATION_TEST_VALUE",
                }
            ],
        }

        with self.assertRaisesRegex(HarnessError, "does not permit"):
            validate_check(invalid_check, "invalid check")


class FixtureAndSanitizerTests(unittest.TestCase):
    """Covers fail-closed content addressing and report redaction."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = load_manifest()

    def test_detects_environment_fixture_hash_mismatch(self) -> None:
        fixture = dict(self.manifest.fixtures["dts-core-5-1-48k"])
        fixture["uri"] = "env://WEBGPU_VALIDATION_TEST_FIXTURE"
        fixture["sha256"] = "0" * 64
        fixture_path = REPOSITORY_ROOT / "scripts/webgpu/dts/fixtures/core_51_24_48_768_0.dtshd"
        with patch.dict(
            os.environ,
            {"WEBGPU_VALIDATION_TEST_FIXTURE": str(fixture_path)},
            clear=False,
        ):
            result = verify_fixture(fixture, self.manifest.failure_codes)

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failures"][0]["code"], "fixture-hash-mismatch")

    def test_sanitizes_nested_credentials_urls_and_paths(self) -> None:
        value = {
            "password": "private-password",
            "endpointURL": "http://localhost:8096/Videos/item?api_key=private-token",
            "message": (
                "username=private-user token=private-token "
                "C:\\private\\movie.mkv"
            ),
        }

        sanitized = sanitize_value(
            value,
            {
                "private-password": "<PASSWORD>",
                "private-token": "<TOKEN>",
                "private-user": "<USERNAME>",
            },
        )
        serialized = json.dumps(sanitized)

        self.assertNotIn("private-password", serialized)
        self.assertNotIn("private-token", serialized)
        self.assertNotIn("private-user", serialized)
        self.assertNotIn("localhost", serialized)
        self.assertNotIn("private", serialized)
        self.assertEqual(sanitized["password"], "[redacted]")
        self.assertEqual(sanitized["endpointURL"], "[redacted-url]")

    def test_classifies_live_harness_failures(self) -> None:
        codes = classify_structured_failures(
            {
                "failures": [
                    "custom-transcode-selected",
                    "browser-error-event",
                    "VideoSample-ownership-warning",
                    "worker-not-retired",
                ]
            }
        )

        self.assertEqual(
            codes,
            {
                "console-error",
                "ownership-warning",
                "resource-leak",
                "unexpected-transcode",
            },
        )


class AdapterTests(unittest.TestCase):
    """Covers fixed commands, assertions, and end-to-end report generation."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = load_manifest()

    def test_builds_argument_vectors_without_shell_strings(self) -> None:
        check = self.manifest.checks["dts-fixtures-current"]

        command = command_for_check(check)

        self.assertEqual(Path(command.arguments[0]), Path(sys.executable))
        self.assertEqual(
            command.arguments[1:],
            (
                "scripts/webgpu/generate_dts_capability_fixtures.py",
                "--check",
            ),
        )

    def test_evaluates_explicit_json_pointer_assertions(self) -> None:
        value = {"failures": [], "status": "passed", "telemetry": {"leaks": 0}}

        self.assertTrue(
            assertion_matches(
                value,
                {"path": "/status", "operator": "equals", "value": "passed"},
            )
        )
        self.assertTrue(
            assertion_matches(value, {"path": "/failures", "operator": "empty"})
        )
        self.assertTrue(
            assertion_matches(value, {"path": "/telemetry/leaks", "operator": "zero"})
        )
        self.assertTrue(
            assertion_matches(value, {"path": "/unknown", "operator": "absent"})
        )

    def test_missing_private_input_is_blocked_not_skipped(self) -> None:
        check = {
            "id": "private-browser",
            "title": "Private browser",
            "adapter": "browser-smoke",
            "timeoutSeconds": 30,
            "requiredEnvironment": ["WEBGPU_VALIDATION_TEST_MISSING"],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("WEBGPU_VALIDATION_TEST_MISSING", None)
                result, evidence = run_check(
                    check,
                    evidence_directory=temporary_path,
                    failure_codes=self.manifest.failure_codes,
                    replacements=report_replacements([check]),
                )

        self.assertIsNone(evidence)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["failures"][0]["code"], "input-missing")

    def test_runtime_probe_populates_browser_and_server_without_urls(self) -> None:
        environment = {
            "browser": {"status": "not-recorded"},
            "server": {"status": "not-recorded"},
            "tools": {},
        }
        check = {"id": "runtime", "adapter": "toolchain-probe"}

        merge_environment_evidence(
            environment,
            check,
            {
                "runtime": {
                    "chromium": {
                        "available": True,
                        "product": "Chrome/151",
                        "url": "http://localhost:9224/json/version",
                    },
                    "frontend": {
                        "available": True,
                        "url": "http://localhost:8096/web/",
                    },
                },
                "tools": {},
            },
            {},
        )

        self.assertEqual(environment["browser"]["product"], "Chrome/151")
        self.assertEqual(environment["browser"]["url"], "[redacted-url]")
        self.assertTrue(environment["server"]["available"])
        self.assertEqual(environment["server"]["url"], "[redacted-url]")

    def test_runs_minimal_matrix_and_writes_all_reports(self) -> None:
        fixture_id = "dts-core-5-1-48k"
        check_id = "dts-fixtures-current"
        case_id = "dts-core-5-1-48k-exact"
        minimal_case = dict(self.manifest.cases[case_id])
        minimal_case["checkIds"] = [check_id]
        minimal_manifest = ValidationManifest(
            cases={case_id: minimal_case},
            checks={check_id: self.manifest.checks[check_id]},
            failure_codes=self.manifest.failure_codes,
            fixtures={fixture_id: self.manifest.fixtures[fixture_id]},
            fixture_registry_sha256=self.manifest.fixture_registry_sha256,
            manifest_path=self.manifest.manifest_path,
            manifest_source_sha256=self.manifest.manifest_source_sha256,
            manifest_sha256=self.manifest.manifest_sha256,
            matrices={
                "unit": {
                    "id": "unit",
                    "title": "Unit matrix",
                    "caseIds": [case_id],
                    "requiredCheckIds": [check_id],
                    "requireManualObservations": False,
                }
            },
            overlay_sha256=None,
        )
        selection = ValidationSelection(
            case_ids=(case_id,),
            check_ids=(check_id,),
            fixture_ids=(fixture_id,),
            matrix_id="unit",
            selectors=(),
            superseded_checks={},
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_directory = Path(temporary_directory) / "run"
            result = execute_run(
                minimal_manifest,
                selection,
                output_directory=output_directory,
                fail_fast=False,
            )

            self.assertEqual(result["status"], "passed")
            self.assertTrue((output_directory / "result.json").is_file())
            self.assertTrue((output_directory / "summary.md").is_file())
            self.assertTrue((output_directory / "summary.html").is_file())
            self.assertTrue((output_directory / "manual-checklist.md").is_file())
            persisted_result = json.loads(
                (output_directory / "result.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted_result["summary"]["passedCases"], 1)
            self.assertIsNone(persisted_result["baseline"])
            self.assertEqual(
                persisted_result["cases"][0]["expectations"]["decoderBackend"],
                "libdcadec",
            )


if __name__ == "__main__":
    unittest.main()
