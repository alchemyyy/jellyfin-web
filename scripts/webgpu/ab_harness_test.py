"""Focused standard-library tests for the WebGPU/mpv A/B harness."""

from __future__ import annotations

import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from ab_harness import (
    HarnessError,
    analyze_float32_pcm,
    command_for_report,
    format_media_seconds,
    normalize_manifest,
    parse_psnr_output,
    parse_ssim_output,
)
from run_mpv_ab import index_captures, parse_stages
from run_mpv_ab import (
    capture_alignment_record,
    create_report_replacements,
    summarize_mpv_pacing,
)


def create_manifest() -> dict[str, object]:
    """Returns the smallest complete comparison manifest."""

    return {
        "audio": {
            "channelCount": 2,
            "channelLayout": "stereo",
            "durationMicroseconds": 10_000_000,
            "mpvAudioTrack": 1,
            "sampleRate": 48_000,
            "startTimeMicroseconds": 60_000_000,
        },
        "caseId": "hdr-reference",
        "jellyfin": {
            "audioStreamIndex": 1,
            "expected": {
                "audioCodec": "flac",
                "audioPath": "ready",
                "videoDecoder": "native",
                "videoOutput": "video-frame",
            },
            "itemId": "item-id",
        },
        "mpvProfiles": [
            {
                "gamutMapping": "perceptual",
                "hdrComputePeak": False,
                "id": "static-spline",
                "toneMapping": "spline",
            }
        ],
        "pacing": {
            "durationMilliseconds": 10_000,
            "startTimeMicroseconds": 60_000_000,
        },
        "schemaVersion": 1,
        "visual": {
            "captureToleranceMicroseconds": 100_000,
            "height": 1_080,
            "outputPeakNits": 100,
            "timestampsMicroseconds": [60_000_000],
            "width": 1_920,
        },
    }


class ManifestTests(unittest.TestCase):
    """Covers strict case normalization and cross-segment invariants."""

    def test_normalizes_complete_manifest(self) -> None:
        manifest = normalize_manifest(create_manifest())

        self.assertEqual(manifest["caseId"], "hdr-reference")
        self.assertEqual(manifest["audio"], {
            "channelCount": 2,
            "channelLayout": "stereo",
            "durationMicroseconds": 10_000_000,
            "mpvAudioTrack": 1,
            "sampleRate": 48_000,
            "startTimeMicroseconds": 60_000_000,
        })

    def test_rejects_segment_mismatch_and_option_injection(self) -> None:
        mismatched_manifest = create_manifest()
        mismatched_audio = mismatched_manifest["audio"]
        self.assertIsInstance(mismatched_audio, dict)
        mismatched_audio["durationMicroseconds"] = 9_000_000
        with self.assertRaisesRegex(HarnessError, "identical durations"):
            normalize_manifest(mismatched_manifest)

        unsafe_manifest = create_manifest()
        unsafe_audio = unsafe_manifest["audio"]
        self.assertIsInstance(unsafe_audio, dict)
        unsafe_audio["channelLayout"] = "stereo --script=unexpected.lua"
        with self.assertRaisesRegex(HarnessError, "unsupported characters"):
            normalize_manifest(unsafe_manifest)

    def test_example_manifest_is_current(self) -> None:
        example_path = Path(__file__).with_name("mpv-ab-manifest.example.json")
        value = json.loads(example_path.read_text(encoding="utf-8"))

        manifest = normalize_manifest(value)

        self.assertEqual(manifest["caseId"], "local-hdr10-flac-reference")


class PCMTests(unittest.TestCase):
    """Covers exact amplitude statistics used for browser/mpv comparison."""

    def test_analyzes_interleaved_float32_pcm(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "audio.pcm"
            path.write_bytes(struct.pack("<4f", 1.0, -1.0, 0.5, -0.5))

            statistics = analyze_float32_pcm(path, channel_count=2, sample_rate=2)

        self.assertEqual(statistics["analyzedFrameCount"], 2)
        self.assertEqual(statistics["analyzedSampleCount"], 4)
        self.assertEqual(statistics["clippedSampleCount"], 0)
        self.assertEqual(statistics["durationMicroseconds"], 1_000_000)
        self.assertAlmostEqual(statistics["samplePeak"], 1.0)
        self.assertAlmostEqual(
            statistics["rootMeanSquare"],
            math.sqrt(0.625),
        )


class ReportParsingTests(unittest.TestCase):
    """Covers FFmpeg parsing, redaction, and capture indexing."""

    def test_parses_metric_summaries(self) -> None:
        self.assertEqual(
            parse_ssim_output("SSIM Y:0.9 All:0.912345 (10.2)"),
            {"all": 0.912345},
        )
        self.assertEqual(
            parse_psnr_output("PSNR average:inf min:42.5 max:inf"),
            {
                "averageDecibels": None,
                "maximumDecibels": None,
                "minimumDecibels": 42.5,
            },
        )

    def test_formats_time_and_redacts_commands(self) -> None:
        self.assertEqual(format_media_seconds(1_234_567), "1.234567")
        self.assertEqual(
            command_for_report(
                ["player", "--password=secret", "C:/private/movie.mkv"],
                {"secret": "<PASSWORD>", "C:/private/movie.mkv": "<MEDIA_SOURCE>"},
            ),
            ["player", "--password=<PASSWORD>", "<MEDIA_SOURCE>"],
        )

        replacements = create_report_replacements(
            Path("C:/private/movie.mkv"),
            "sample-user",
            "sample-password",
        )
        self.assertEqual(replacements["sample-user"], "<USERNAME>")
        self.assertEqual(replacements["sample-password"], "<PASSWORD>")
        self.assertEqual(
            command_for_report(
                ["--username=sample-user", "--password=sample-password"],
                replacements,
            ),
            [
                "--username=<USERNAME>",
                "--password=<PASSWORD>",
            ],
        )

        self.assertEqual(
            command_for_report(
                ["--password=long-secret"],
                {"secret": "<SHORT>", "long-secret": "<LONG>"},
            ),
            ["--password=<LONG>"],
        )

    def test_indexes_captures_and_rejects_duplicates(self) -> None:
        indexed = index_captures({
            "captures": [
                {"filename": "one.png", "requestedMediaTimeMicroseconds": 1}
            ]
        }, "report")
        self.assertEqual(indexed[1]["filename"], "one.png")
        with self.assertRaisesRegex(HarnessError, "duplicate"):
            index_captures({
                "captures": [
                    {"filename": "one.png", "requestedMediaTimeMicroseconds": 1},
                    {"filename": "two.png", "requestedMediaTimeMicroseconds": 1},
                ]
            }, "report")

    def test_parses_stage_order_without_duplicates(self) -> None:
        self.assertEqual(parse_stages("mpv,browser,mpv"), ("mpv", "browser"))
        with self.assertRaisesRegex(HarnessError, "Unsupported stage"):
            parse_stages("browser,typo")

    def test_accepts_real_time_mpv_pacing_and_rejects_desynchronization(self) -> None:
        valid_report = {
            "pacing": {
                "after": {
                    "decoderFrameDropCount": 0,
                    "delayedFrameCount": 0,
                    "frameDropCount": 0,
                    "hwdecCurrent": "d3d11va",
                    "mediaTimeMicroseconds": 70_020_000,
                    "mistimedFrameCount": 0,
                    "pausedForCache": False,
                },
                "before": {
                    "decoderFrameDropCount": 0,
                    "delayedFrameCount": 0,
                    "frameDropCount": 0,
                    "mediaTimeMicroseconds": 60_000_000,
                    "mistimedFrameCount": 0,
                },
                "observedWallDurationMicroseconds": 10_000_000,
            }
        }
        summary = summarize_mpv_pacing(valid_report)
        self.assertEqual(summary["status"], "valid")
        self.assertEqual(summary["hardwareDecoder"], "d3d11va")

        invalid_report = json.loads(json.dumps(valid_report))
        invalid_report["pacing"]["after"]["mediaTimeMicroseconds"] = 91_000_000
        invalid_report["pacing"]["after"]["mistimedFrameCount"] = 700
        summary = summarize_mpv_pacing(invalid_report)
        self.assertEqual(summary["status"], "invalid")
        self.assertIn(
            "media-clock-diverged-from-wall-clock",
            summary["failureReasons"],
        )
        self.assertIn("frames-mistimed", summary["failureReasons"])

    def test_requires_cross_player_frame_alignment(self) -> None:
        alignment = capture_alignment_record(
            {"actualMediaTimeMicroseconds": 60_018_000},
            {"actualMediaTimeMicroseconds": 60_018_500},
            60_018_000,
        )
        self.assertEqual(alignment["status"], "frame-aligned")
        self.assertEqual(alignment["browserMinusMpvMicroseconds"], -500)

        with self.assertRaisesRegex(HarnessError, "not frame-aligned"):
            capture_alignment_record(
                {"actualMediaTimeMicroseconds": 59_977_000},
                {"actualMediaTimeMicroseconds": 60_018_000},
                60_000_000,
            )


if __name__ == "__main__":
    unittest.main()
