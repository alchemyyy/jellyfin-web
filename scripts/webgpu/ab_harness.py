"""Shared deterministic utilities for WebGPU versus mpv validation."""

from __future__ import annotations

import array
import json
import math
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence, cast


SCHEMA_VERSION = 1
MICROSECONDS_PER_SECOND = 1_000_000
MAXIMUM_CAPTURE_COUNT = 32
MINIMUM_VIEWPORT_DIMENSION = 240
MAXIMUM_VIEWPORT_DIMENSION = 7_680
CASE_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CHANNEL_LAYOUT_PATTERN = re.compile(r"^[A-Za-z0-9_.()+-]+$")
SSIM_PATTERN = re.compile(r"All:([0-9.+-]+)")
PSNR_PATTERN = re.compile(
    r"average:([0-9.+-]+|inf)\s+min:([0-9.+-]+|inf)\s+max:([0-9.+-]+|inf)",
    re.IGNORECASE,
)


class HarnessError(RuntimeError):
    """Reports one actionable harness failure without a shell traceback."""


@dataclass(frozen=True)
class ExecutableResolution:
    """Records how one required executable was resolved."""

    name: str
    path: Path
    source: str
    version: str


@dataclass(frozen=True)
class CompletedCommand:
    """Captures one subprocess invocation for an ignored local report."""

    arguments: tuple[str, ...]
    return_code: int
    standard_error: str
    standard_output: str


def require_mapping(value: object, label: str) -> dict[str, object]:
    """Returns a string-keyed mapping or raises a precise schema error."""

    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise HarnessError(f"{label} must be an object")
    return cast(dict[str, object], value)


def require_string(value: object, label: str) -> str:
    """Returns a non-empty string after trimming no meaningful content."""

    if not isinstance(value, str) or not value.strip():
        raise HarnessError(f"{label} must be a non-empty string")
    return value


def require_integer(
    value: object,
    label: str,
    minimum: int,
    maximum: int = sys.maxsize,
) -> int:
    """Returns an integer within an explicit inclusive range."""

    if isinstance(value, bool) or not isinstance(value, int):
        raise HarnessError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise HarnessError(f"{label} must be from {minimum} through {maximum}")
    return value


def require_number(
    value: object,
    label: str,
    minimum: float,
    maximum: float,
) -> float:
    """Returns one finite number within an explicit inclusive range."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HarnessError(f"{label} must be a number")
    numeric_value = float(value)
    if not math.isfinite(numeric_value) or numeric_value < minimum or numeric_value > maximum:
        raise HarnessError(f"{label} must be from {minimum} through {maximum}")
    return numeric_value


def read_json(path: Path) -> object:
    """Reads UTF-8 JSON and reports the source path on failure."""

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HarnessError(f"Unable to read JSON from {path}: {error}") from error


def write_json(path: Path, value: object) -> None:
    """Writes deterministic UTF-8 JSON after creating its parent directory."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f"{path.name}.tmp")
    temporary_path.write_text(
        f"{json.dumps(value, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def format_media_seconds(microseconds: int) -> str:
    """Formats integer microseconds without routing through binary float."""

    if microseconds < 0:
        raise HarnessError("Media time cannot be negative")
    whole_seconds = microseconds // MICROSECONDS_PER_SECOND
    remaining_microseconds = microseconds % MICROSECONDS_PER_SECOND
    return f"{whole_seconds}.{remaining_microseconds:06d}"


def resolve_executable(
    name: str,
    explicit_path: str | None,
    environment_name: str,
) -> ExecutableResolution:
    """Resolves a tool from an argument, environment variable, or PATH."""

    candidates: list[tuple[str, str]] = []
    if explicit_path:
        candidates.append(("argument", explicit_path))
    environment_path = os.environ.get(environment_name)
    if environment_path:
        candidates.append((f"environment:{environment_name}", environment_path))
    path_resolution = shutil.which(name)
    if path_resolution:
        candidates.append(("PATH", path_resolution))

    for source, candidate in candidates:
        resolved_path = Path(candidate).expanduser().resolve()
        if not resolved_path.is_file():
            continue
        version = read_executable_version(resolved_path)
        return ExecutableResolution(
            name=name,
            path=resolved_path,
            source=source,
            version=version,
        )
    raise HarnessError(
        f"Unable to resolve {name}; pass its path or set {environment_name}"
    )


def read_executable_version(path: Path) -> str:
    """Reads the first stable version line without invoking a shell."""

    version_arguments = [str(path), "--version"]
    try:
        completed_process = subprocess.run(
            version_arguments,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    combined_output = completed_process.stdout or completed_process.stderr
    first_line = combined_output.splitlines()[0].strip() if combined_output else ""
    return first_line or "unknown"


def run_checked(
    arguments: Sequence[str],
    *,
    working_directory: Path,
    environment: Mapping[str, str] | None = None,
    timeout_seconds: float,
) -> CompletedCommand:
    """Runs one argument vector and raises when the process does not succeed."""

    result = run_command(
        arguments,
        working_directory=working_directory,
        environment=environment,
        timeout_seconds=timeout_seconds,
    )
    if result.return_code != 0:
        diagnostic_lines = (result.standard_error or result.standard_output).splitlines()
        diagnostic_tail = "\n".join(diagnostic_lines[-40:])
        raise HarnessError(
            f"Command failed with exit code {result.return_code}: {arguments[0]}\n"
            f"{diagnostic_tail}"
        )
    return result


def run_command(
    arguments: Sequence[str],
    *,
    working_directory: Path,
    environment: Mapping[str, str] | None = None,
    timeout_seconds: float,
) -> CompletedCommand:
    """Runs one argument vector and returns its exit code and diagnostic output."""

    command_environment = os.environ.copy()
    if environment:
        command_environment.update(environment)
    try:
        completed_process = subprocess.run(
            [str(argument) for argument in arguments],
            capture_output=True,
            check=False,
            cwd=working_directory,
            encoding="utf-8",
            env=command_environment,
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise HarnessError(
            f"Command exceeded {timeout_seconds:g} seconds: {arguments[0]}"
        ) from error
    except OSError as error:
        raise HarnessError(f"Unable to execute {arguments[0]}: {error}") from error

    return CompletedCommand(
        arguments=tuple(str(argument) for argument in arguments),
        return_code=completed_process.returncode,
        standard_error=completed_process.stderr,
        standard_output=completed_process.stdout,
    )


def normalize_manifest(value: object) -> dict[str, object]:
    """Validates the complete A/B manifest and returns a stable normalized form."""

    manifest = require_mapping(value, "Manifest")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise HarnessError(f"Manifest schemaVersion must be {SCHEMA_VERSION}")
    case_identifier = require_string(manifest.get("caseId"), "Manifest caseId")
    if not CASE_IDENTIFIER_PATTERN.fullmatch(case_identifier):
        raise HarnessError(
            "Manifest caseId must contain only lowercase letters, numbers, and hyphens"
        )

    jellyfin_value = require_mapping(manifest.get("jellyfin"), "Manifest jellyfin")
    expected_value = require_mapping(
        jellyfin_value.get("expected"),
        "Manifest jellyfin.expected",
    )
    audio_path = require_string(expected_value.get("audioPath"), "Expected audio path")
    if audio_path not in {"disabled", "native-media", "ready"}:
        raise HarnessError("Expected audio path is unsupported")
    video_decoder = require_string(
        expected_value.get("videoDecoder"),
        "Expected video decoder",
    )
    if video_decoder not in {"bundled-hevc", "native"}:
        raise HarnessError("Expected video decoder is unsupported")
    video_output = require_string(
        expected_value.get("videoOutput"),
        "Expected video output",
    )
    if video_output not in {"raw-planes", "video-frame"}:
        raise HarnessError("Expected video output is unsupported")

    visual_value = require_mapping(manifest.get("visual"), "Manifest visual")
    timestamps_value = visual_value.get("timestampsMicroseconds")
    if not isinstance(timestamps_value, list):
        raise HarnessError("Visual timestampsMicroseconds must be an array")
    if not 1 <= len(timestamps_value) <= MAXIMUM_CAPTURE_COUNT:
        raise HarnessError(
            f"Visual timestamps must contain from 1 through {MAXIMUM_CAPTURE_COUNT} entries"
        )
    timestamps = [
        require_integer(timestamp, f"Visual timestamp {timestamp_index}", 0)
        for timestamp_index, timestamp in enumerate(timestamps_value)
    ]
    if len(set(timestamps)) != len(timestamps):
        raise HarnessError("Visual timestamps must be unique")

    pacing_value = require_mapping(manifest.get("pacing"), "Manifest pacing")
    audio_value = require_mapping(manifest.get("audio"), "Manifest audio")
    audio_start_microseconds = require_integer(
        audio_value.get("startTimeMicroseconds"),
        "Audio start time",
        0,
    )
    audio_duration_microseconds = require_integer(
        audio_value.get("durationMicroseconds"),
        "Audio duration",
        MICROSECONDS_PER_SECOND,
        60 * MICROSECONDS_PER_SECOND,
    )
    pacing_start_microseconds = require_integer(
        pacing_value.get("startTimeMicroseconds"),
        "Pacing start time",
        0,
    )
    pacing_duration_milliseconds = require_integer(
        pacing_value.get("durationMilliseconds"),
        "Pacing duration",
        1_000,
        12_000,
    )
    if audio_start_microseconds != pacing_start_microseconds:
        raise HarnessError("Audio and pacing segments must start at the same timestamp")
    if audio_duration_microseconds != pacing_duration_milliseconds * 1_000:
        raise HarnessError("Audio and pacing segments must have identical durations")

    profiles_value = manifest.get("mpvProfiles")
    if not isinstance(profiles_value, list) or not 1 <= len(profiles_value) <= 4:
        raise HarnessError("mpvProfiles must contain from 1 through 4 entries")
    normalized_profiles: list[dict[str, object]] = []
    profile_identifiers: set[str] = set()
    for profile_index, profile_value in enumerate(profiles_value):
        profile = require_mapping(profile_value, f"mpv profile {profile_index}")
        profile_identifier = require_string(profile.get("id"), f"mpv profile {profile_index} id")
        if not CASE_IDENTIFIER_PATTERN.fullmatch(profile_identifier):
            raise HarnessError(f"mpv profile {profile_index} id is invalid")
        if profile_identifier in profile_identifiers:
            raise HarnessError("mpv profile IDs must be unique")
        profile_identifiers.add(profile_identifier)
        tone_mapping = require_string(
            profile.get("toneMapping"),
            f"mpv profile {profile_identifier} toneMapping",
        )
        gamut_mapping = require_string(
            profile.get("gamutMapping"),
            f"mpv profile {profile_identifier} gamutMapping",
        )
        hdr_compute_peak = profile.get("hdrComputePeak")
        if not isinstance(hdr_compute_peak, bool):
            raise HarnessError(
                f"mpv profile {profile_identifier} hdrComputePeak must be boolean"
            )
        normalized_profiles.append(
            {
                "gamutMapping": gamut_mapping,
                "hdrComputePeak": hdr_compute_peak,
                "id": profile_identifier,
                "toneMapping": tone_mapping,
            }
        )

    width = require_integer(
        visual_value.get("width"),
        "Visual width",
        MINIMUM_VIEWPORT_DIMENSION,
        MAXIMUM_VIEWPORT_DIMENSION,
    )
    height = require_integer(
        visual_value.get("height"),
        "Visual height",
        MINIMUM_VIEWPORT_DIMENSION,
        MAXIMUM_VIEWPORT_DIMENSION,
    )
    return {
        "audio": {
            "channelCount": require_integer(
                audio_value.get("channelCount"),
                "Audio channel count",
                1,
                8,
            ),
            "channelLayout": require_channel_layout(
                audio_value.get("channelLayout")
            ),
            "durationMicroseconds": audio_duration_microseconds,
            "mpvAudioTrack": require_integer(
                audio_value.get("mpvAudioTrack"),
                "mpv audio track",
                1,
            ),
            "sampleRate": require_integer(
                audio_value.get("sampleRate"),
                "Audio sample rate",
                8_000,
                384_000,
            ),
            "startTimeMicroseconds": audio_start_microseconds,
        },
        "caseId": case_identifier,
        "jellyfin": {
            "audioStreamIndex": require_integer(
                jellyfin_value.get("audioStreamIndex"),
                "Jellyfin audio stream index",
                0,
            ),
            "expected": {
                "audioCodec": require_string(
                    expected_value.get("audioCodec"),
                    "Expected audio codec",
                ).lower(),
                "audioPath": audio_path,
                "videoDecoder": video_decoder,
                "videoOutput": video_output,
            },
            "itemId": require_string(jellyfin_value.get("itemId"), "Jellyfin item ID"),
        },
        "mpvProfiles": normalized_profiles,
        "pacing": {
            "durationMilliseconds": pacing_duration_milliseconds,
            "startTimeMicroseconds": pacing_start_microseconds,
        },
        "schemaVersion": SCHEMA_VERSION,
        "visual": {
            "captureToleranceMicroseconds": require_integer(
                visual_value.get("captureToleranceMicroseconds"),
                "Visual capture tolerance",
                1_000,
                2_000_000,
            ),
            "height": height,
            "outputPeakNits": require_number(
                visual_value.get("outputPeakNits"),
                "Visual output peak",
                1,
                10_000,
            ),
            "timestampsMicroseconds": timestamps,
            "width": width,
        },
    }


def require_channel_layout(value: object) -> str:
    """Returns one mpv channel-layout token without accepting option injection."""

    channel_layout = require_string(value, "Audio channel layout")
    if not CHANNEL_LAYOUT_PATTERN.fullmatch(channel_layout):
        raise HarnessError("Audio channel layout contains unsupported characters")
    return channel_layout


def analyze_float32_pcm(
    path: Path,
    channel_count: int,
    sample_rate: int,
) -> dict[str, object]:
    """Computes exact amplitude statistics for little-endian float32 PCM."""

    if channel_count <= 0 or sample_rate <= 0:
        raise HarnessError("PCM channel count and sample rate must be positive")
    sample_values = array.array("f")
    try:
        with path.open("rb") as source_file:
            while True:
                block = source_file.read(1024 * 1024)
                if not block:
                    break
                if len(block) % sample_values.itemsize != 0:
                    raise HarnessError(f"PCM byte length is not float32-aligned: {path}")
                block_values = array.array("f")
                block_values.frombytes(block)
                if sys.byteorder != "little":
                    block_values.byteswap()
                sample_values.extend(block_values)
    except OSError as error:
        raise HarnessError(f"Unable to analyze PCM file {path}: {error}") from error
    if len(sample_values) == 0:
        raise HarnessError(f"PCM file contains no samples: {path}")
    if len(sample_values) % channel_count != 0:
        raise HarnessError(f"PCM sample count is not channel-aligned: {path}")

    sample_peak = 0.0
    sample_square_sum = 0.0
    clipped_sample_count = 0
    non_finite_sample_count = 0
    for sample_value in sample_values:
        if not math.isfinite(sample_value):
            non_finite_sample_count += 1
            continue
        absolute_sample = abs(sample_value)
        sample_peak = max(sample_peak, absolute_sample)
        sample_square_sum += sample_value * sample_value
        if absolute_sample > 1:
            clipped_sample_count += 1
    finite_sample_count = len(sample_values) - non_finite_sample_count
    if finite_sample_count <= 0:
        raise HarnessError(f"PCM file contains no finite samples: {path}")
    root_mean_square = math.sqrt(sample_square_sum / finite_sample_count)
    frame_count = len(sample_values) // channel_count
    return {
        "analyzedFrameCount": frame_count,
        "analyzedSampleCount": finite_sample_count,
        "channelCount": channel_count,
        "clippedSampleCount": clipped_sample_count,
        "crestFactorDecibels": (
            20 * math.log10(sample_peak / root_mean_square)
            if sample_peak > 0 and root_mean_square > 0
            else None
        ),
        "durationMicroseconds": round(frame_count * MICROSECONDS_PER_SECOND / sample_rate),
        "nonFiniteSampleCount": non_finite_sample_count,
        "peakDecibelsFullScale": 20 * math.log10(sample_peak) if sample_peak > 0 else None,
        "rootMeanSquare": root_mean_square,
        "rootMeanSquareDecibelsFullScale": (
            20 * math.log10(root_mean_square) if root_mean_square > 0 else None
        ),
        "samplePeak": sample_peak,
        "sampleRate": sample_rate,
        "sampleSquareSum": sample_square_sum,
    }


def command_for_report(
    arguments: Sequence[str],
    replacements: Mapping[str, str],
) -> list[str]:
    """Redacts source paths and credentials while retaining argument structure."""

    ordered_replacements = sorted(
        replacements.items(),
        key=lambda replacement: len(replacement[0]),
        reverse=True,
    )
    redacted_arguments: list[str] = []
    for argument in arguments:
        redacted_argument = str(argument)
        for secret, replacement in ordered_replacements:
            if secret:
                redacted_argument = redacted_argument.replace(secret, replacement)
        redacted_arguments.append(redacted_argument)
    return redacted_arguments


def parse_ssim_output(output: str) -> dict[str, float]:
    """Extracts the aggregate SSIM value from FFmpeg diagnostic output."""

    matches = SSIM_PATTERN.findall(output)
    if not matches:
        raise HarnessError("FFmpeg SSIM output did not contain an aggregate value")
    return {"all": float(matches[-1])}


def parse_psnr_output(output: str) -> dict[str, float | None]:
    """Extracts aggregate PSNR values while preserving infinite results as null."""

    matches = PSNR_PATTERN.findall(output)
    if not matches:
        raise HarnessError("FFmpeg PSNR output did not contain aggregate values")
    average, minimum, maximum = matches[-1]

    def parse_value(value: str) -> float | None:
        return None if value.lower() == "inf" else float(value)

    return {
        "averageDecibels": parse_value(average),
        "maximumDecibels": parse_value(maximum),
        "minimumDecibels": parse_value(minimum),
    }
