#!/usr/bin/env python3
"""Generate and externally verify the deterministic 7.1 downmix reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Final, TypedDict


MPV_SOURCE_COMMIT: Final = "1d1535ff9124fdeb3c81a2f089551e2cc8404613"
FFMPEG_SOURCE_COMMIT: Final = "862338fe3154e09ff0c410fd410d519588d47cf2"
MPV_BINARY_SHA256: Final = (
    "002d5d348c7467c765f1b32682c6eb50c30a3eb4468b9d06caaca344e3de1839"
)
FFMPEG_BINARY_SHA256: Final = (
    "cce4074b7af8e71b4c63f17bec8d36ca3da9b7f84f5bcbb010476164a6cafa85"
)
MPV_VERSION_MARKER: Final = "mpv v0.40.0-dev-g1d1535ff9"
FFMPEG_VERSION_MARKER: Final = "2026-03-01-git-862338fe31"
SAMPLE_RATES: Final = (48_000, 96_000)
CHANNEL_COUNT: Final = 8
FRAME_COUNT: Final = 8_192
WAVE_CHANNEL_MASK_SEVEN_POINT_ONE: Final = 0x63F
IMPULSE_AMPLITUDE: Final = 0.5
CORRELATED_FULL_SCALE_FRAME: Final = 3_584
CORRELATED_NEGATIVE_FULL_SCALE_FRAME: Final = 3_585
LFE_ONLY_FRAME: Final = 3_840
LFE_CHANNEL_INDEX: Final = 3
MIXED_CHANNEL_GAIN: Final = math.sqrt(0.5)
DEFAULT_DIRECT_CHANNEL_GAIN: Final = 1.0
DEFAULT_MIXED_CHANNEL_GAIN: Final = MIXED_CHANNEL_GAIN
NORMALIZED_DIRECT_CHANNEL_GAIN: Final = 1 / (1 + 3 * MIXED_CHANNEL_GAIN)
NORMALIZED_MIXED_CHANNEL_GAIN: Final = (
    NORMALIZED_DIRECT_CHANNEL_GAIN * MIXED_CHANNEL_GAIN
)
MAXIMUM_EXTERNAL_SAMPLE_ERROR: Final = 1e-6
DEFAULT_EXTERNAL_PCM_SHA256: Final = (
    "9b44d35903a5cbf01af55e20ebe8231cdb935026306d1e8a52a58059233f4981"
)
NORMALIZED_EXTERNAL_PCM_SHA256: Final = (
    "db63a6e65629b96e2fc183bbf29bee4ff36ac7a2d5344c6ec58a860631ed0805"
)
CHANNEL_ORDER: Final = (
    "front-left",
    "front-right",
    "front-center",
    "low-frequency-effects",
    "back-left",
    "back-right",
    "side-left",
    "side-right",
)


class StereoMetrics(TypedDict):
    clippedSampleCount: int
    crestFactor: float
    crestFactorDB: float
    nonFiniteSampleCount: int
    peak: float
    rms: float
    rmsDBFS: float


class ExternalOutputRecord(TypedDict):
    maximumAbsoluteError: float
    pcmSHA256: str


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            repository_root
            / "scripts/webgpu/downmix-reference/seven-point-one.json"
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when the checked-in deterministic reference is stale",
    )
    parser.add_argument(
        "--verify-external",
        action="store_true",
        help="Run the pinned mpv and FFmpeg binaries against the generated corpus",
    )
    parser.add_argument("--mpv", type=Path)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--mpv-source", type=Path)
    parser.add_argument("--ffmpeg-source", type=Path)
    return parser.parse_args()


def as_float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def next_lcg_value(state: int) -> int:
    return (1_664_525 * state + 1_013_904_223) & 0xFFFF_FFFF


def create_corpus() -> list[list[float]]:
    channel_data: list[list[float]] = []
    for _channel_index in range(CHANNEL_COUNT):
        channel_data.append([0.0] * FRAME_COUNT)

    for channel_index in range(CHANNEL_COUNT):
        impulse_frame = 32 + channel_index * 64
        channel_data[channel_index][impulse_frame] = IMPULSE_AMPLITUDE

    correlated_state = 0x71C0_FFEE
    for frame_index in range(1_024, 3_072):
        correlated_state = next_lcg_value(correlated_state)
        signed_value = ((correlated_state >> 16) & 0xFFFF) - 0x8000
        sample = as_float32(signed_value / 131_072)
        for channel_index in range(CHANNEL_COUNT):
            channel_data[channel_index][frame_index] = (
                as_float32(sample * 3)
                if channel_index == LFE_CHANNEL_INDEX
                else sample
            )

    for channel_index in range(CHANNEL_COUNT):
        channel_data[channel_index][CORRELATED_FULL_SCALE_FRAME] = (
            100.0 if channel_index == LFE_CHANNEL_INDEX else 1.0
        )
        channel_data[channel_index][CORRELATED_NEGATIVE_FULL_SCALE_FRAME] = (
            -100.0 if channel_index == LFE_CHANNEL_INDEX else -1.0
        )
    channel_data[LFE_CHANNEL_INDEX][LFE_ONLY_FRAME] = 100.0

    channel_states = [0xD75A_0001 + channel_index for channel_index in range(CHANNEL_COUNT)]
    for frame_index in range(4_096, FRAME_COUNT):
        for channel_index in range(CHANNEL_COUNT):
            channel_states[channel_index] = next_lcg_value(channel_states[channel_index])
            signed_value = ((channel_states[channel_index] >> 16) & 0xFFFF) - 0x8000
            scale = 3 if channel_index == LFE_CHANNEL_INDEX else 1
            channel_data[channel_index][frame_index] = as_float32(
                signed_value * scale / 131_072
            )
    return channel_data


def get_matrix(direct_gain: float, mixed_gain: float) -> tuple[tuple[float, ...], ...]:
    return (
        (direct_gain, 0.0, mixed_gain, 0.0, mixed_gain, 0.0, mixed_gain, 0.0),
        (0.0, direct_gain, mixed_gain, 0.0, 0.0, mixed_gain, 0.0, mixed_gain),
    )


def apply_matrix(
    channel_data: list[list[float]],
    matrix: tuple[tuple[float, ...], ...],
) -> tuple[list[float], list[float]]:
    output_channels: list[list[float]] = [[], []]
    for output_channel_index in range(2):
        coefficients = matrix[output_channel_index]
        output_channel = output_channels[output_channel_index]
        for frame_index in range(FRAME_COUNT):
            sample = 0.0
            for input_channel_index in range(CHANNEL_COUNT):
                sample += (
                    channel_data[input_channel_index][frame_index]
                    * coefficients[input_channel_index]
                )
            output_channel.append(as_float32(sample))
    return output_channels[0], output_channels[1]


def interleave_float32(channel_data: tuple[list[float], ...] | list[list[float]]) -> bytes:
    frame_count = len(channel_data[0])
    output = bytearray(frame_count * len(channel_data) * 4)
    byte_offset = 0
    for frame_index in range(frame_count):
        for channel in channel_data:
            struct.pack_into("<f", output, byte_offset, channel[frame_index])
            byte_offset += 4
    return bytes(output)


def compute_metrics(channel_data: tuple[list[float], list[float]]) -> StereoMetrics:
    finite_samples: list[float] = []
    non_finite_sample_count = 0
    clipped_sample_count = 0
    peak = 0.0
    squared_sum = 0.0
    for channel in channel_data:
        for sample in channel:
            if not math.isfinite(sample):
                non_finite_sample_count += 1
                continue
            finite_samples.append(sample)
            absolute_sample = abs(sample)
            peak = max(peak, absolute_sample)
            squared_sum += sample * sample
            if absolute_sample > 1:
                clipped_sample_count += 1
    rms = math.sqrt(squared_sum / len(finite_samples))
    crest_factor = peak / rms
    return {
        "clippedSampleCount": clipped_sample_count,
        "crestFactor": crest_factor,
        "crestFactorDB": 20 * math.log10(crest_factor),
        "nonFiniteSampleCount": non_finite_sample_count,
        "peak": peak,
        "rms": rms,
        "rmsDBFS": 20 * math.log10(rms),
    }


def matrix_record(direct_gain: float, mixed_gain: float) -> dict[str, object]:
    matrix = get_matrix(direct_gain, mixed_gain)
    absolute_row_sum = sum(abs(coefficient) for coefficient in matrix[0])
    uncorrelated_rms_gain = math.sqrt(
        sum(coefficient * coefficient for coefficient in matrix[0])
    )
    return {
        "absoluteRowSum": absolute_row_sum,
        "centerBackSideGain": mixed_gain,
        "centerBackSideGainDB": 20 * math.log10(mixed_gain),
        "directGain": direct_gain,
        "directGainDB": 20 * math.log10(direct_gain),
        "lfeGain": 0.0,
        "matrix": [list(matrix[0]), list(matrix[1])],
        "maximumCorrelatedPeak": absolute_row_sum,
        "maximumCorrelatedPeakDBFS": 20 * math.log10(absolute_row_sum),
        "uncorrelatedRMSGain": uncorrelated_rms_gain,
        "uncorrelatedRMSGainDB": 20 * math.log10(uncorrelated_rms_gain),
    }


def generate_reference() -> dict[str, object]:
    corpus = create_corpus()
    default_matrix = get_matrix(
        DEFAULT_DIRECT_CHANNEL_GAIN,
        DEFAULT_MIXED_CHANNEL_GAIN,
    )
    normalized_matrix = get_matrix(
        NORMALIZED_DIRECT_CHANNEL_GAIN,
        NORMALIZED_MIXED_CHANNEL_GAIN,
    )
    default_output = apply_matrix(corpus, default_matrix)
    normalized_output = apply_matrix(corpus, normalized_matrix)
    input_sha256 = hashlib.sha256(interleave_float32(corpus)).hexdigest()
    measurements: dict[str, object] = {}
    for sample_rate in SAMPLE_RATES:
        measurements[str(sample_rate)] = {
            "mpvDefault": compute_metrics(default_output),
            "mpvNormalized": compute_metrics(normalized_output),
        }
    return {
        "channelOrder": list(CHANNEL_ORDER),
        "corpus": {
            "description": (
                "Eight isolated impulses, deterministic correlated and decorrelated "
                "signals, positive/negative full-scale correlation, and an LFE-only sentinel"
            ),
            "frameCount": FRAME_COUNT,
            "inputFloat32SHA256": input_sha256,
            "sampleRates": list(SAMPLE_RATES),
        },
        "loudnessScope": (
            "RMS dBFS and crest factor are recorded. This synthetic, short corpus is not "
            "a valid substitute for program-material BS.1770 integrated loudness."
        ),
        "measurements": measurements,
        "policies": {
            "mpvDefault": {
                **matrix_record(
                    DEFAULT_DIRECT_CHANNEL_GAIN,
                    DEFAULT_MIXED_CHANNEL_GAIN,
                ),
                "externalPCMReferenceSHA256": DEFAULT_EXTERNAL_PCM_SHA256,
            },
            "mpvNormalized": {
                **matrix_record(
                    NORMALIZED_DIRECT_CHANNEL_GAIN,
                    NORMALIZED_MIXED_CHANNEL_GAIN,
                ),
                "externalPCMReferenceSHA256": NORMALIZED_EXTERNAL_PCM_SHA256,
            },
        },
        "referenceSources": {
            "ffmpeg": {
                "binarySHA256": FFMPEG_BINARY_SHA256,
                "commit": FFMPEG_SOURCE_COMMIT,
                "policy": (
                    "libswresample defaults: center/surround sqrt(1/2), LFE 0, "
                    "floating output unnormalized"
                ),
                "versionMarker": FFMPEG_VERSION_MARKER,
            },
            "mpv": {
                "binarySHA256": MPV_BINARY_SHA256,
                "commit": MPV_SOURCE_COMMIT,
                "defaultPolicy": "audio-normalize-downmix=no, rematrix_maxval=1000",
                "normalizedPolicy": "audio-normalize-downmix=yes, rematrix_maxval=1",
                "versionMarker": MPV_VERSION_MARKER,
            },
        },
        "schemaVersion": 1,
        "waveChannelMask": WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    }


def write_wave_extensible(
    path: Path,
    sample_rate: int,
    channel_data: list[list[float]],
) -> None:
    payload = interleave_float32(channel_data)
    block_align = len(channel_data) * 4
    format_data = struct.pack(
        "<HHIIHHHHI",
        0xFFFE,
        len(channel_data),
        sample_rate,
        sample_rate * block_align,
        block_align,
        32,
        22,
        32,
        WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    )
    format_data += struct.pack(
        "<IHH8s",
        3,
        0,
        0x0010,
        bytes.fromhex("800000aa00389b71"),
    )
    chunks = (
        b"fmt "
        + struct.pack("<I", len(format_data))
        + format_data
        + b"data"
        + struct.pack("<I", len(payload))
        + payload
    )
    path.write_bytes(
        b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks
    )


def read_wave_float32(path: Path) -> tuple[list[float], list[float], bytes]:
    wave_data = path.read_bytes()
    if wave_data[:4] != b"RIFF" or wave_data[8:12] != b"WAVE":
        raise RuntimeError(f"External downmix output is not RIFF/WAVE: {path}")
    byte_offset = 12
    format_data: bytes | None = None
    payload: bytes | None = None
    while byte_offset + 8 <= len(wave_data):
        chunk_type = wave_data[byte_offset : byte_offset + 4]
        chunk_size = struct.unpack_from("<I", wave_data, byte_offset + 4)[0]
        chunk_start = byte_offset + 8
        chunk_data = wave_data[chunk_start : chunk_start + chunk_size]
        if chunk_type == b"fmt ":
            format_data = chunk_data
        elif chunk_type == b"data":
            payload = chunk_data
        byte_offset = chunk_start + chunk_size + (chunk_size & 1)
    if format_data is None or payload is None:
        raise RuntimeError(f"External downmix output is missing WAVE chunks: {path}")
    _format_tag, channel_count, _sample_rate, _, _, bits_per_sample = struct.unpack_from(
        "<HHIIHH",
        format_data,
    )
    if channel_count != 2 or bits_per_sample != 32 or len(payload) % 8 != 0:
        raise RuntimeError(f"External downmix output is not stereo float32: {path}")
    interleaved = struct.unpack(f"<{len(payload) // 4}f", payload)
    left = list(interleaved[0::2])
    right = list(interleaved[1::2])
    return left, right, payload


def require_sha256(path: Path, expected_sha256: str) -> None:
    actual_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"Pinned executable hash mismatch for {path}: {actual_sha256}"
        )


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
        text=True,
    )


def run_external_media_command(command: list[str]) -> None:
    subprocess.run(
        command,
        check=True,
        stdin=subprocess.DEVNULL,
    )


def run_mpv_command(command: list[str]) -> None:
    maximum_attempt_count = 3
    for attempt_index in range(maximum_attempt_count):
        try:
            subprocess.run(
                command,
                check=True,
                stdin=subprocess.DEVNULL,
                timeout=5,
            )
            return
        except subprocess.TimeoutExpired:
            if attempt_index + 1 >= maximum_attempt_count:
                raise
            time.sleep(1)


def require_source_behavior(
    repository: Path,
    commit: str,
    file_name: str,
    required_fragments: tuple[str, ...],
) -> None:
    source = run_command(
        ["git", "-C", str(repository), "show", f"{commit}:{file_name}"]
    ).stdout
    for required_fragment in required_fragments:
        if required_fragment not in source:
            raise RuntimeError(
                f"Pinned source behavior changed in {commit}:{file_name}"
            )


def compare_output(
    actual: tuple[list[float], list[float]],
    expected: tuple[list[float], list[float]],
    payload: bytes,
    expected_sha256: str,
) -> ExternalOutputRecord:
    if len(actual[0]) != len(expected[0]) or len(actual[1]) != len(expected[1]):
        raise RuntimeError("External downmix output has an unexpected frame count")
    maximum_absolute_error = 0.0
    for channel_index in range(2):
        for frame_index in range(len(expected[channel_index])):
            maximum_absolute_error = max(
                maximum_absolute_error,
                abs(
                    actual[channel_index][frame_index]
                    - expected[channel_index][frame_index]
                ),
            )
    if maximum_absolute_error > MAXIMUM_EXTERNAL_SAMPLE_ERROR:
        raise RuntimeError(
            f"External downmix differs from the pinned matrix by {maximum_absolute_error}"
        )
    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"External downmix PCM hash mismatch: {actual_sha256}"
        )
    return {
        "maximumAbsoluteError": maximum_absolute_error,
        "pcmSHA256": actual_sha256,
    }


def verify_external(arguments: argparse.Namespace) -> dict[str, object]:
    required_paths = {
        "ffmpeg": arguments.ffmpeg,
        "ffmpeg source": arguments.ffmpeg_source,
        "mpv": arguments.mpv,
        "mpv source": arguments.mpv_source,
    }
    for name, path in required_paths.items():
        if path is None or not path.exists():
            raise RuntimeError(f"--verify-external requires a valid {name} path")

    mpv_path: Path = arguments.mpv.resolve()
    ffmpeg_path: Path = arguments.ffmpeg.resolve()
    mpv_source: Path = arguments.mpv_source.resolve()
    ffmpeg_source: Path = arguments.ffmpeg_source.resolve()
    require_sha256(mpv_path, MPV_BINARY_SHA256)
    require_sha256(ffmpeg_path, FFMPEG_BINARY_SHA256)
    mpv_version = run_command([str(mpv_path), "--version"]).stdout
    ffmpeg_version_process = run_command([str(ffmpeg_path), "-version"])
    ffmpeg_version = ffmpeg_version_process.stdout + ffmpeg_version_process.stderr
    if MPV_VERSION_MARKER not in mpv_version:
        raise RuntimeError("Pinned mpv version marker is absent")
    if FFMPEG_VERSION_MARKER not in ffmpeg_version:
        raise RuntimeError("Pinned FFmpeg version marker is absent")
    require_source_behavior(
        mpv_source,
        MPV_SOURCE_COMMIT,
        "filters/f_swresample.h",
        (".normalize   = 0",),
    )
    require_source_behavior(
        mpv_source,
        MPV_SOURCE_COMMIT,
        "filters/f_swresample.c",
        ('"rematrix_maxval", normalize ? 1 : 1000',),
    )
    require_source_behavior(
        ffmpeg_source,
        FFMPEG_SOURCE_COMMIT,
        "libswresample/options.c",
        (
            "{.dbl=C_30DB",
            "{.dbl=0                     }",
        ),
    )
    require_source_behavior(
        ffmpeg_source,
        FFMPEG_SOURCE_COMMIT,
        "libswresample/rematrix.c",
        (
            "matrix[ FRONT_LEFT][ BACK_LEFT] += surround_mix_level",
            "matrix[ FRONT_LEFT][ SIDE_LEFT] += surround_mix_level",
            "matrix[FRONT_LEFT ][LOW_FREQUENCY] += lfe_mix_level * M_SQRT1_2",
        ),
    )

    corpus = create_corpus()
    expected_outputs = {
        "mpvDefault": apply_matrix(
            corpus,
            get_matrix(DEFAULT_DIRECT_CHANNEL_GAIN, DEFAULT_MIXED_CHANNEL_GAIN),
        ),
        "mpvNormalized": apply_matrix(
            corpus,
            get_matrix(NORMALIZED_DIRECT_CHANNEL_GAIN, NORMALIZED_MIXED_CHANNEL_GAIN),
        ),
    }
    sample_rate_reports: dict[str, object] = {}
    report: dict[str, object] = {
        "ffmpegBinarySHA256": FFMPEG_BINARY_SHA256,
        "mpvBinarySHA256": MPV_BINARY_SHA256,
        "sampleRates": sample_rate_reports,
    }
    with tempfile.TemporaryDirectory(prefix="jellyfin-7.1-downmix-") as temporary_directory:
        temporary_path = Path(temporary_directory)
        for sample_rate in SAMPLE_RATES:
            input_path = temporary_path / f"input-{sample_rate}.wav"
            write_wave_extensible(input_path, sample_rate, corpus)
            output_paths = {
                "ffmpegDefault": temporary_path / f"ffmpeg-default-{sample_rate}.wav",
                "ffmpegNormalized": temporary_path / f"ffmpeg-normalized-{sample_rate}.wav",
                "mpvDefault": temporary_path / f"mpv-default-{sample_rate}.wav",
                "mpvNormalized": temporary_path / f"mpv-normalized-{sample_rate}.wav",
            }
            run_mpv_command([
                str(mpv_path),
                "--no-config",
                "--idle=no",
                "--load-scripts=no",
                "--terminal=no",
                "--no-video",
                "--audio-channels=stereo",
                "--audio-format=float",
                "--audio-normalize-downmix=no",
                "--ao=pcm",
                f"--ao-pcm-file={output_paths['mpvDefault']}",
                str(input_path),
            ])
            time.sleep(0.5)
            run_mpv_command([
                str(mpv_path),
                "--no-config",
                "--idle=no",
                "--load-scripts=no",
                "--terminal=no",
                "--no-video",
                "--audio-channels=stereo",
                "--audio-format=float",
                "--audio-normalize-downmix=yes",
                "--ao=pcm",
                f"--ao-pcm-file={output_paths['mpvNormalized']}",
                str(input_path),
            ])
            time.sleep(0.5)
            run_external_media_command([
                str(ffmpeg_path),
                "-v",
                "error",
                "-y",
                "-i",
                str(input_path),
                "-map",
                "0:a:0",
                "-ac",
                "2",
                "-c:a",
                "pcm_f32le",
                str(output_paths["ffmpegDefault"]),
            ])
            run_external_media_command([
                str(ffmpeg_path),
                "-v",
                "error",
                "-y",
                "-i",
                str(input_path),
                "-map",
                "0:a:0",
                "-af",
                "aresample=rematrix_maxval=1",
                "-ac",
                "2",
                "-c:a",
                "pcm_f32le",
                str(output_paths["ffmpegNormalized"]),
            ])

            actual_outputs: dict[str, tuple[list[float], list[float]]] = {}
            output_payloads: dict[str, bytes] = {}
            for output_name, output_path in output_paths.items():
                left, right, payload = read_wave_float32(output_path)
                actual_outputs[output_name] = (left, right)
                output_payloads[output_name] = payload
            if output_payloads["mpvDefault"] != output_payloads["ffmpegDefault"]:
                raise RuntimeError("mpv and FFmpeg default PCM outputs differ")
            if output_payloads["mpvNormalized"] != output_payloads["ffmpegNormalized"]:
                raise RuntimeError("mpv and FFmpeg normalized PCM outputs differ")
            sample_rate_reports[str(sample_rate)] = {
                "ffmpegDefault": compare_output(
                    actual_outputs["ffmpegDefault"],
                    expected_outputs["mpvDefault"],
                    output_payloads["ffmpegDefault"],
                    DEFAULT_EXTERNAL_PCM_SHA256,
                ),
                "ffmpegNormalized": compare_output(
                    actual_outputs["ffmpegNormalized"],
                    expected_outputs["mpvNormalized"],
                    output_payloads["ffmpegNormalized"],
                    NORMALIZED_EXTERNAL_PCM_SHA256,
                ),
                "mpvDefault": compare_output(
                    actual_outputs["mpvDefault"],
                    expected_outputs["mpvDefault"],
                    output_payloads["mpvDefault"],
                    DEFAULT_EXTERNAL_PCM_SHA256,
                ),
                "mpvNormalized": compare_output(
                    actual_outputs["mpvNormalized"],
                    expected_outputs["mpvNormalized"],
                    output_payloads["mpvNormalized"],
                    NORMALIZED_EXTERNAL_PCM_SHA256,
                ),
            }
    return report


def main() -> None:
    arguments = parse_arguments()
    output_path = arguments.output.resolve()
    generated = json.dumps(generate_reference(), indent=2, sort_keys=True) + "\n"
    if arguments.check:
        if not output_path.is_file() or output_path.read_text(encoding="utf-8") != generated:
            raise RuntimeError(f"7.1 downmix reference is stale: {output_path}")
        print(f"Verified {output_path}")
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(generated, encoding="utf-8", newline="\n")
        print(f"Generated {output_path}")
    if arguments.verify_external:
        print(json.dumps(verify_external(arguments), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
