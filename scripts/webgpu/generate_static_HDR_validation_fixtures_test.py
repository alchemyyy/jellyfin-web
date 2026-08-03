"""Focused tests for deterministic static HDR HEVC fixture construction."""

from __future__ import annotations

import argparse
import unittest

from generate_static_HDR_validation_fixtures import (
    FixtureGenerationError,
    FIXTURE_REVISION,
    START_CODE,
    add_emulation_prevention_bytes,
    create_fixture_definitions,
    create_live_source_records,
    find_annex_B_NAL_units,
    inject_prefix_SEI_NAL_units,
    remove_emulation_prevention_bytes,
    require_generator_options,
    scan_static_HDR_metadata,
)


def create_base_HEVC_stream() -> bytes:
    """Creates one structural parameter-set plus VCL Annex B stream."""

    video_parameter_set = bytes((32 << 1, 1, 0x80))
    VCL_NAL_unit = bytes((19 << 1, 1, 0x80))
    return START_CODE + video_parameter_set + START_CODE + VCL_NAL_unit


class StaticHDRFixtureGeneratorTests(unittest.TestCase):
    """Covers exact state construction without requiring codec executables."""

    def test_constructs_every_static_HDR_scan_state(self) -> None:
        base_stream = create_base_HEVC_stream()
        for definition in create_fixture_definitions():
            with self.subTest(status=definition.expected_status):
                injected_stream = inject_prefix_SEI_NAL_units(
                    base_stream, definition.injected_NAL_units
                )
                self.assertEqual(
                    scan_static_HDR_metadata(injected_stream),
                    definition.expected_status,
                )

    def test_inserts_prefix_SEI_before_the_first_VCL_unit(self) -> None:
        base_stream = create_base_HEVC_stream()
        valid_definition = create_fixture_definitions()[-1]
        injected_stream = inject_prefix_SEI_NAL_units(
            base_stream, valid_definition.injected_NAL_units
        )
        NAL_types = [
            NAL_unit.nal_type for NAL_unit in find_annex_B_NAL_units(injected_stream)
        ]
        self.assertEqual(NAL_types, [32, 39, 19])

    def test_round_trips_RBSP_emulation_prevention(self) -> None:
        RBSP = b"\x00\x00\x00\x00\x00\x01\x00\x00\x02\x00\x00\x03\x04"
        escaped = add_emulation_prevention_bytes(RBSP)
        self.assertNotEqual(escaped, RBSP)
        self.assertEqual(remove_emulation_prevention_bytes(escaped), RBSP)

    def test_rejects_injection_without_a_VCL_unit(self) -> None:
        parameter_set_only = START_CODE + bytes((32 << 1, 1, 0x80))
        with self.assertRaisesRegex(FixtureGenerationError, "no VCL"):
            inject_prefix_SEI_NAL_units(
                parameter_set_only,
                create_fixture_definitions()[-1].injected_NAL_units,
            )

    def test_rejects_invalid_generation_bounds(self) -> None:
        base_arguments = {
            "duration_seconds": 12,
            "frame_rate": 24,
            "height": 1080,
            "width": 1920,
        }
        invalid_arguments = (
            {**base_arguments, "width": 1919},
            {**base_arguments, "height": 15},
            {**base_arguments, "frame_rate": 25},
            {**base_arguments, "duration_seconds": 7},
        )
        for values in invalid_arguments:
            with self.subTest(values=values):
                with self.assertRaises(FixtureGenerationError):
                    require_generator_options(argparse.Namespace(**values))

    def test_creates_path_free_live_source_records(self) -> None:
        fixture_records = []
        for definition in create_fixture_definitions():
            fixture_records.append(
                {
                    "expectedStaticHDRMetadataStatus": definition.expected_status,
                    "expectedToneMappingPeakNits": definition.expected_peak_nits,
                    "file": (
                        f"pq-static-hdr-{FIXTURE_REVISION}-{definition.name}-"
                        "1080p24-flac.mkv"
                    ),
                    "media": {"video": {"level": 120}},
                }
            )
        sources = create_live_source_records(
            fixture_records,
            width=1920,
            height=1080,
            frame_rate=24,
            duration_seconds=12,
        )
        self.assertEqual(len(sources), 4)
        self.assertEqual(
            {source["staticHDRMetadata"]["status"] for source in sources},
            {"absent", "conflicting", "malformed", "valid"},
        )
        serialized_sources = str(sources)
        self.assertNotIn("C:\\", serialized_sources)
        self.assertIn("WEBGPU_VALIDATION_STATIC_HDR_VALID_MEDIA", serialized_sources)
        self.assertEqual(
            {source["licenseExpression"] for source in sources},
            {"GPL-2.0-or-later"},
        )

    def test_rejects_a_fixture_filename_outside_the_live_contract(self) -> None:
        fixture_record = {
            "expectedStaticHDRMetadataStatus": "valid",
            "expectedToneMappingPeakNits": 4000,
            "file": "unexpected.mkv",
            "media": {"video": {"level": 120}},
        }
        with self.assertRaisesRegex(FixtureGenerationError, "filename"):
            create_live_source_records(
                [fixture_record],
                width=1920,
                height=1080,
                frame_rate=24,
                duration_seconds=12,
            )


if __name__ == "__main__":
    unittest.main()
