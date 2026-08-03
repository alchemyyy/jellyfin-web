#!/usr/bin/env python3
"""Generate deterministic PQ HEVC fixtures for static HDR scan states."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping, Sequence


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_OUTPUT_DIRECTORY = SCRIPT_DIRECTORY / "playback-smoke-media"
MANIFEST_FILE_NAME = "static-HDR-validation-manifest.json"
LIVE_SPEC_FILE_NAME = "static-HDR-live-spec.json"
PREFIX_SEI_NAL_UNIT_TYPE = 39
SUFFIX_SEI_NAL_UNIT_TYPE = 40
MASTERING_DISPLAY_PAYLOAD_TYPE = 137
CONTENT_LIGHT_PAYLOAD_TYPE = 144
MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH = 24
CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH = 4
MASTERING_LUMINANCE_SCALE = 10_000
DEFAULT_TONE_MAPPING_PEAK_NITS = 1_000
VALID_TONE_MAPPING_PEAK_NITS = 4_000
MINIMUM_LUMINANCE_NITS = 0.005
MAXIMUM_HDR_LUMINANCE_NITS = 10_000
FIXTURE_REVISION = "v1"
START_CODE = b"\x00\x00\x00\x01"

StaticHDRStatus = Literal["absent", "conflicting", "malformed", "valid"]


class FixtureGenerationError(RuntimeError):
    """Reports a deterministic fixture generation or verification failure."""


class StaticHDRConflictError(ValueError):
    """Reports two internally valid but incompatible static metadata values."""


@dataclass(frozen=True)
class AnnexBNALUnit:
    """Describes one Annex B NAL unit without copying its payload."""

    end_offset: int
    nal_type: int
    payload_offset: int
    start_offset: int


@dataclass(frozen=True)
class FixtureDefinition:
    """Defines one exact injected metadata state and renderer expectation."""

    expected_peak_nits: int
    expected_status: StaticHDRStatus
    injected_NAL_units: tuple[bytes, ...]
    name: str


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the fixture-generator CLI."""

    parser = argparse.ArgumentParser(
        description=(
            "Generate PQ HEVC/FLAC Matroska fixtures for absent, malformed, "
            "conflicting, and valid static HDR metadata."
        )
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument(
        "--output-directory",
        default=str(DEFAULT_OUTPUT_DIRECTORY),
    )
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--frame-rate", type=int, default=24)
    parser.add_argument("--duration-seconds", type=int, default=12)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def append_extended_SEI_value(output: bytearray, value: int) -> None:
    """Appends one HEVC SEI payload type or size field."""

    if value < 0:
        raise ValueError("An HEVC SEI extended value cannot be negative")
    remaining_value = value
    while remaining_value >= 0xFF:
        output.append(0xFF)
        remaining_value -= 0xFF
    output.append(remaining_value)


def add_emulation_prevention_bytes(data: bytes) -> bytes:
    """Escapes an RBSP for storage inside an HEVC NAL unit."""

    output = bytearray()
    zero_count = 0
    for byte_value in data:
        if zero_count >= 2 and byte_value <= 3:
            output.append(3)
            zero_count = 0
        output.append(byte_value)
        zero_count = zero_count + 1 if byte_value == 0 else 0
    return bytes(output)


def remove_emulation_prevention_bytes(data: bytes) -> bytes:
    """Unescapes an HEVC NAL payload and rejects invalid escape bytes."""

    output = bytearray()
    zero_count = 0
    byte_index = 0
    while byte_index < len(data):
        byte_value = data[byte_index]
        if zero_count >= 2 and byte_value == 3:
            if byte_index + 1 >= len(data) or data[byte_index + 1] > 3:
                raise ValueError("The HEVC SEI has an invalid emulation-prevention byte")
            zero_count = 0
            byte_index += 1
            continue
        output.append(byte_value)
        zero_count = zero_count + 1 if byte_value == 0 else 0
        byte_index += 1
    return bytes(output)


def create_mastering_display_payload(
    maximum_luminance_nits: float,
    minimum_luminance_nits: float = MINIMUM_LUMINANCE_NITS,
) -> bytes:
    """Creates one standards-shaped BT.2020 mastering-display payload."""

    maximum_luminance_code = round(maximum_luminance_nits * MASTERING_LUMINANCE_SCALE)
    minimum_luminance_code = round(minimum_luminance_nits * MASTERING_LUMINANCE_SCALE)
    return struct.pack(
        ">HHHHHHHHII",
        13_250,
        34_500,
        7_500,
        3_000,
        34_000,
        16_000,
        15_635,
        16_450,
        maximum_luminance_code,
        minimum_luminance_code,
    )


def create_content_light_payload(
    maximum_content_light_level_nits: int,
    maximum_frame_average_light_level_nits: int,
) -> bytes:
    """Creates one HEVC content-light-level payload."""

    return struct.pack(
        ">HH",
        maximum_content_light_level_nits,
        maximum_frame_average_light_level_nits,
    )


def create_prefix_SEI_NAL_unit(payloads: Sequence[tuple[int, bytes]]) -> bytes:
    """Creates one prefix-SEI NAL unit containing exact payload records."""

    RBSP = bytearray()
    for payload_type, payload in payloads:
        append_extended_SEI_value(RBSP, payload_type)
        append_extended_SEI_value(RBSP, len(payload))
        RBSP.extend(payload)
    RBSP.append(0x80)
    NAL_header = bytes((PREFIX_SEI_NAL_UNIT_TYPE << 1, 1))
    return NAL_header + add_emulation_prevention_bytes(bytes(RBSP))


def create_valid_static_HDR_SEI_NAL_unit(maximum_luminance_nits: int) -> bytes:
    """Creates exact mastering-display and content-light metadata."""

    return create_prefix_SEI_NAL_unit(
        (
            (
                MASTERING_DISPLAY_PAYLOAD_TYPE,
                create_mastering_display_payload(maximum_luminance_nits),
            ),
            (
                CONTENT_LIGHT_PAYLOAD_TYPE,
                create_content_light_payload(500, 200),
            ),
        )
    )


def create_fixture_definitions() -> tuple[FixtureDefinition, ...]:
    """Returns the four exact static-HDR fixture states."""

    valid_4000_NAL_unit = create_valid_static_HDR_SEI_NAL_unit(
        VALID_TONE_MAPPING_PEAK_NITS
    )
    malformed_NAL_unit = create_prefix_SEI_NAL_unit(
        (
            (
                MASTERING_DISPLAY_PAYLOAD_TYPE,
                create_mastering_display_payload(1_000, 4_000),
            ),
        )
    )
    conflicting_NAL_unit = create_prefix_SEI_NAL_unit(
        (
            (
                MASTERING_DISPLAY_PAYLOAD_TYPE,
                create_mastering_display_payload(1_000),
            ),
            (
                MASTERING_DISPLAY_PAYLOAD_TYPE,
                create_mastering_display_payload(VALID_TONE_MAPPING_PEAK_NITS),
            ),
        )
    )
    return (
        FixtureDefinition(
            expected_peak_nits=DEFAULT_TONE_MAPPING_PEAK_NITS,
            expected_status="absent",
            injected_NAL_units=(),
            name="absent",
        ),
        FixtureDefinition(
            expected_peak_nits=DEFAULT_TONE_MAPPING_PEAK_NITS,
            expected_status="malformed",
            injected_NAL_units=(malformed_NAL_unit,),
            name="malformed",
        ),
        FixtureDefinition(
            expected_peak_nits=DEFAULT_TONE_MAPPING_PEAK_NITS,
            expected_status="conflicting",
            injected_NAL_units=(conflicting_NAL_unit,),
            name="conflicting",
        ),
        FixtureDefinition(
            expected_peak_nits=VALID_TONE_MAPPING_PEAK_NITS,
            expected_status="valid",
            injected_NAL_units=(valid_4000_NAL_unit,),
            name="valid-4000",
        ),
    )


def get_source_environment_suffix(name: str) -> str:
    """Returns the stable environment suffix for one generated fixture."""

    return "VALID" if name == "valid-4000" else name.upper()


def create_live_source_records(
    fixture_records: Sequence[Mapping[str, object]],
    *,
    width: int,
    height: int,
    frame_rate: int,
    duration_seconds: int,
) -> list[dict[str, object]]:
    """Creates path-free live sources from the exact generated fixture records."""

    sources: list[dict[str, object]] = []
    generator_arguments = [
        "--width",
        str(width),
        "--height",
        str(height),
        "--frame-rate",
        str(frame_rate),
        "--duration-seconds",
        str(duration_seconds),
    ]
    for fixture in fixture_records:
        file_name = fixture["file"]
        expected_status = fixture["expectedStaticHDRMetadataStatus"]
        expected_peak_nits = fixture["expectedToneMappingPeakNits"]
        if not isinstance(file_name, str) or not isinstance(expected_status, str):
            raise FixtureGenerationError("A generated fixture record is incomplete")
        file_prefix = f"pq-static-hdr-{FIXTURE_REVISION}-"
        file_suffix = f"-{height}p{frame_rate}-flac.mkv"
        if not file_name.startswith(file_prefix) or not file_name.endswith(file_suffix):
            raise FixtureGenerationError(
                "A generated fixture filename does not match its live-source contract"
            )
        fixture_name = file_name.removeprefix(file_prefix).removesuffix(file_suffix)
        if not fixture_name:
            raise FixtureGenerationError("A generated fixture filename has no state name")
        environment_suffix = get_source_environment_suffix(fixture_name)
        stream_metadata = fixture["media"]
        if not isinstance(stream_metadata, dict):
            raise FixtureGenerationError("A generated fixture has no stream metadata")
        video_metadata = stream_metadata.get("video")
        if not isinstance(video_metadata, dict):
            raise FixtureGenerationError("A generated fixture has no video metadata")
        sources.append(
            {
                "audioPath": "ready",
                "exerciseIds": ["lifecycle"],
                "id": f"generated-pq-static-hdr-{FIXTURE_REVISION}-{fixture_name}",
                "itemEnvironment": (
                    f"WEBGPU_VALIDATION_STATIC_HDR_{environment_suffix}_ITEM_ID"
                ),
                "licenseEnvironment": "WEBGPU_VALIDATION_STATIC_HDR_LICENSE",
                "licenseExpression": "GPL-2.0-or-later",
                "media": {
                    "audio": {
                        "bitsPerSample": 16,
                        "channelCount": 2,
                        "channelLayout": "stereo",
                        "codec": "flac",
                        "profile": "lossless",
                        "sampleRate": 48_000,
                    },
                    "container": "matroska",
                    "packetization": "hevc-length-prefixed",
                    "video": {
                        "bitDepth": 10,
                        "chroma": "4:2:0",
                        "codec": "hevc",
                        "frameRate": frame_rate,
                        "height": height,
                        "matrix": "bt2020-ncl",
                        "primaries": "bt2020",
                        "profile": f"main-10-level-{video_metadata.get('level')}",
                        "progressive": True,
                        "range": "limited",
                        "transfer": "pq",
                        "width": width,
                    },
                },
                "mediaEnvironment": (
                    f"WEBGPU_VALIDATION_STATIC_HDR_{environment_suffix}_MEDIA"
                ),
                "provenance": {
                    "generatorArguments": generator_arguments,
                    "kind": "generated",
                    "revision": f"static-hdr-fixture-{FIXTURE_REVISION}",
                    "source": Path(__file__).name,
                },
                "routeId": "hdr10-native-external",
                "staticHDRMetadata": {
                    "status": expected_status,
                    "toneMappingPeakNits": expected_peak_nits,
                },
                "title": f"Generated PQ static HDR {fixture_name}",
            }
        )
    return sources


def find_annex_B_NAL_units(data: bytes) -> tuple[AnnexBNALUnit, ...]:
    """Returns every complete Annex B NAL boundary in byte order."""

    start_codes: list[tuple[int, int]] = []
    byte_index = 0
    while byte_index <= len(data) - 3:
        if data[byte_index : byte_index + 4] == START_CODE:
            start_codes.append((byte_index, 4))
            byte_index += 4
            continue
        if data[byte_index : byte_index + 3] == b"\x00\x00\x01":
            start_codes.append((byte_index, 3))
            byte_index += 3
            continue
        byte_index += 1
    NAL_units: list[AnnexBNALUnit] = []
    for start_index, (start_offset, start_code_length) in enumerate(start_codes):
        payload_offset = start_offset + start_code_length
        end_offset = (
            start_codes[start_index + 1][0]
            if start_index + 1 < len(start_codes)
            else len(data)
        )
        if end_offset - payload_offset < 2:
            continue
        NAL_units.append(
            AnnexBNALUnit(
                end_offset=end_offset,
                nal_type=(data[payload_offset] >> 1) & 0x3F,
                payload_offset=payload_offset,
                start_offset=start_offset,
            )
        )
    if not NAL_units:
        raise FixtureGenerationError("The generated HEVC stream has no Annex B NAL units")
    return tuple(NAL_units)


def inject_prefix_SEI_NAL_units(
    source: bytes,
    injected_NAL_units: Sequence[bytes],
) -> bytes:
    """Inserts prefix SEI after startup headers and before the first VCL NAL."""

    if not injected_NAL_units:
        return source
    first_VCL_unit = next(
        (NAL_unit for NAL_unit in find_annex_B_NAL_units(source) if NAL_unit.nal_type <= 31),
        None,
    )
    if first_VCL_unit is None:
        raise FixtureGenerationError("The generated HEVC stream has no VCL NAL unit")
    injection = b"".join(
        START_CODE + injected_NAL_unit for injected_NAL_unit in injected_NAL_units
    )
    return source[: first_VCL_unit.start_offset] + injection + source[first_VCL_unit.start_offset :]


def read_extended_SEI_value(data: bytes, start_offset: int) -> tuple[int, int]:
    """Reads one HEVC SEI extended value and returns value plus next offset."""

    offset = start_offset
    value = 0
    while offset < len(data) and data[offset] == 0xFF:
        value += 0xFF
        offset += 1
    if offset >= len(data):
        raise ValueError("The HEVC SEI ends inside an extended value")
    return value + data[offset], offset + 1


def merge_luminance_value(
    metadata: dict[str, float | None],
    name: str,
    value: float | None,
) -> None:
    """Merges one optional luminance and reports exact conflicts."""

    if value is None:
        return
    previous_value = metadata[name]
    if previous_value is not None and previous_value != value:
        raise StaticHDRConflictError("Static HDR metadata values conflict")
    metadata[name] = value


def parse_static_HDR_SEI_payloads(
    NAL_unit_data: bytes,
    metadata: dict[str, float | None],
) -> None:
    """Parses the static payload subset needed to verify generated fixtures."""

    if len(NAL_unit_data) < 3:
        raise ValueError("The HEVC SEI NAL unit is truncated")
    RBSP = remove_emulation_prevention_bytes(NAL_unit_data[2:])
    offset = 0
    while offset < len(RBSP):
        if RBSP[offset] == 0x80 and all(byte_value == 0 for byte_value in RBSP[offset + 1 :]):
            return
        payload_type, offset = read_extended_SEI_value(RBSP, offset)
        payload_size, offset = read_extended_SEI_value(RBSP, offset)
        if payload_size > len(RBSP) - offset:
            raise ValueError("The HEVC SEI payload exceeds its NAL unit")
        payload = RBSP[offset : offset + payload_size]
        if payload_type == MASTERING_DISPLAY_PAYLOAD_TYPE:
            if len(payload) != MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH:
                raise ValueError("The HEVC mastering-display payload size is invalid")
            merge_luminance_value(
                metadata,
                "masteringMaximum",
                struct.unpack_from(">I", payload, 16)[0] / MASTERING_LUMINANCE_SCALE,
            )
            merge_luminance_value(
                metadata,
                "masteringMinimum",
                struct.unpack_from(">I", payload, 20)[0] / MASTERING_LUMINANCE_SCALE,
            )
        elif payload_type == CONTENT_LIGHT_PAYLOAD_TYPE:
            if len(payload) != CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH:
                raise ValueError("The HEVC content-light payload size is invalid")
            maximum_content_light, maximum_frame_average_light = struct.unpack(
                ">HH", payload
            )
            merge_luminance_value(
                metadata,
                "maximumContentLight",
                float(maximum_content_light) if maximum_content_light > 0 else None,
            )
            merge_luminance_value(
                metadata,
                "maximumFrameAverageLight",
                float(maximum_frame_average_light)
                if maximum_frame_average_light > 0
                else None,
            )
        offset += payload_size


def is_valid_luminance(value: float | None, *, allow_zero: bool) -> bool:
    """Matches the bounded renderer metadata luminance contract."""

    return value is None or (
        math.isfinite(value)
        and value >= (0 if allow_zero else 1)
        and value <= MAXIMUM_HDR_LUMINANCE_NITS
    )


def scan_static_HDR_metadata(data: bytes) -> StaticHDRStatus:
    """Classifies static metadata across a complete generated Annex B stream."""

    metadata: dict[str, float | None] = {
        "masteringMaximum": None,
        "masteringMinimum": None,
        "maximumContentLight": None,
        "maximumFrameAverageLight": None,
    }
    try:
        for NAL_unit in find_annex_B_NAL_units(data):
            if NAL_unit.nal_type not in {
                PREFIX_SEI_NAL_UNIT_TYPE,
                SUFFIX_SEI_NAL_UNIT_TYPE,
            }:
                continue
            parse_static_HDR_SEI_payloads(
                data[NAL_unit.payload_offset : NAL_unit.end_offset], metadata
            )
    except StaticHDRConflictError:
        return "conflicting"
    except ValueError:
        return "malformed"
    if all(value is None for value in metadata.values()):
        return "absent"
    maximum_luminance = metadata["masteringMaximum"]
    minimum_luminance = metadata["masteringMinimum"]
    if (
        not is_valid_luminance(maximum_luminance, allow_zero=False)
        or not is_valid_luminance(minimum_luminance, allow_zero=True)
        or not is_valid_luminance(metadata["maximumContentLight"], allow_zero=False)
        or not is_valid_luminance(
            metadata["maximumFrameAverageLight"], allow_zero=False
        )
        or (
            maximum_luminance is not None
            and minimum_luminance is not None
            and minimum_luminance >= maximum_luminance
        )
    ):
        return "malformed"
    return "valid"


def run_command(arguments: Sequence[str], label: str) -> subprocess.CompletedProcess[str]:
    """Runs one fixed argument vector and preserves diagnostics only on failure."""

    result = subprocess.run(
        list(arguments),
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout).strip()
        raise FixtureGenerationError(f"{label} failed: {diagnostic}")
    return result


def require_executable(command: str, label: str) -> str:
    """Resolves one required executable without invoking a shell."""

    resolved = shutil.which(command)
    if resolved is None:
        candidate = Path(command).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        raise FixtureGenerationError(f"{label} was not found: {command}")
    return resolved


def calculate_SHA256(path: Path) -> str:
    """Calculates one streaming SHA-256 file identity."""

    digest = hashlib.sha256()
    with path.open("rb") as input_stream:
        while True:
            chunk = input_stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def generate_base_HEVC(
    ffmpeg_path: str,
    output_path: Path,
    *,
    width: int,
    height: int,
    frame_rate: int,
    duration_seconds: int,
) -> None:
    """Generates one metadata-free PQ Main10 elementary stream."""

    frame_count = frame_rate * duration_seconds
    key_frame_interval = frame_rate * 2
    video_input = (
        f"testsrc2=size={width}x{height}:rate={frame_rate}:"
        f"duration={duration_seconds},format=yuv420p10le"
    )
    x265_parameters = ":".join(
        (
            "bframes=0",
            "frame-threads=1",
            f"keyint={key_frame_interval}",
            f"min-keyint={key_frame_interval}",
            "scenecut=0",
            "repeat-headers=1",
            "aud=1",
            "wpp=0",
            "pools=none",
            "info=0",
            "range=limited",
            "colorprim=9",
            "transfer=16",
            "colormatrix=9",
            "hdr10=0",
            "log-level=error",
        )
    )
    run_command(
        (
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "lavfi",
            "-i",
            video_input,
            "-frames:v",
            str(frame_count),
            "-an",
            "-c:v",
            "libx265",
            "-pix_fmt",
            "yuv420p10le",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-x265-params",
            x265_parameters,
            "-f",
            "hevc",
            str(output_path),
        ),
        "Base HEVC encode",
    )
    if scan_static_HDR_metadata(output_path.read_bytes()) != "absent":
        raise FixtureGenerationError(
            "The base PQ HEVC encode unexpectedly contains static HDR metadata"
        )


def mux_fixture(
    ffmpeg_path: str,
    HEVC_path: Path,
    output_path: Path,
    *,
    frame_rate: int,
    duration_seconds: int,
) -> None:
    """Muxes one injected video stream with deterministic stereo FLAC."""

    audio_input = (
        f"sine=frequency=440:sample_rate=48000:duration={duration_seconds}"
    )
    run_command(
        (
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-fflags",
            "+genpts",
            "-r",
            str(frame_rate),
            "-i",
            str(HEVC_path),
            "-f",
            "lavfi",
            "-i",
            audio_input,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "flac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            str(duration_seconds),
            str(output_path),
        ),
        f"Matroska mux for {output_path.name}",
    )


def require_exact_stream_metadata(
    ffprobe_path: str,
    fixture_path: Path,
    *,
    width: int,
    height: int,
    frame_rate: int,
) -> Mapping[str, object]:
    """Verifies the exact video and audio tuple used by the live matrix."""

    result = run_command(
        (
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            (
                "stream=index,codec_type,codec_name,profile,level,width,height,"
                "pix_fmt,avg_frame_rate,color_range,color_space,color_transfer,"
                "color_primaries,channels,sample_rate"
            ),
            "-of",
            "json",
            str(fixture_path),
        ),
        f"FFprobe verification for {fixture_path.name}",
    )
    probe = json.loads(result.stdout)
    streams = probe.get("streams")
    if not isinstance(streams, list):
        raise FixtureGenerationError(f"FFprobe returned no streams for {fixture_path.name}")
    video_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        ),
        None,
    )
    audio_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"
        ),
        None,
    )
    expected_video = {
        "codec_name": "hevc",
        "profile": "Main 10",
        "width": width,
        "height": height,
        "pix_fmt": "yuv420p10le",
        "avg_frame_rate": f"{frame_rate}/1",
        "color_range": "tv",
        "color_space": "bt2020nc",
        "color_transfer": "smpte2084",
        "color_primaries": "bt2020",
    }
    expected_audio = {
        "codec_name": "flac",
        "channels": 2,
        "sample_rate": "48000",
    }
    if not isinstance(video_stream, dict) or any(
        video_stream.get(name) != expected_value
        for name, expected_value in expected_video.items()
    ):
        raise FixtureGenerationError(
            f"Unexpected video metadata in {fixture_path.name}: {video_stream}"
        )
    if not isinstance(audio_stream, dict) or any(
        audio_stream.get(name) != expected_value
        for name, expected_value in expected_audio.items()
    ):
        raise FixtureGenerationError(
            f"Unexpected audio metadata in {fixture_path.name}: {audio_stream}"
        )
    return {
        "audio": expected_audio,
        "video": {
            **expected_video,
            "level": video_stream.get("level"),
        },
    }


def extract_HEVC(
    ffmpeg_path: str,
    fixture_path: Path,
    output_path: Path,
) -> bytes:
    """Extracts the exact muxed video back to Annex B for status verification."""

    run_command(
        (
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(fixture_path),
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-f",
            "hevc",
            str(output_path),
        ),
        f"HEVC extraction for {fixture_path.name}",
    )
    return output_path.read_bytes()


def require_generator_options(arguments: argparse.Namespace) -> None:
    """Rejects dimensions and durations outside the live-harness contract."""

    if arguments.width < 16 or arguments.width > 8192 or arguments.width % 2 != 0:
        raise FixtureGenerationError("Fixture width must be an even integer from 16 to 8192")
    if arguments.height < 16 or arguments.height > 8192 or arguments.height % 2 != 0:
        raise FixtureGenerationError("Fixture height must be an even integer from 16 to 8192")
    if arguments.frame_rate not in {24, 30, 60}:
        raise FixtureGenerationError("Fixture frame rate must be 24, 30, or 60")
    if arguments.duration_seconds < 8 or arguments.duration_seconds > 120:
        raise FixtureGenerationError("Fixture duration must be from 8 through 120 seconds")


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Generates, remux-verifies, and atomically publishes all four fixtures."""

    require_generator_options(arguments)
    ffmpeg_path = require_executable(arguments.ffmpeg, "FFmpeg")
    ffprobe_path = require_executable(arguments.ffprobe, "FFprobe")
    output_directory = Path(arguments.output_directory).expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    fixture_definitions = create_fixture_definitions()
    final_paths = {
        definition.name: output_directory
        / (
            f"pq-static-hdr-{FIXTURE_REVISION}-{definition.name}-{arguments.height}p"
            f"{arguments.frame_rate}-flac.mkv"
        )
        for definition in fixture_definitions
    }
    manifest_path = output_directory / MANIFEST_FILE_NAME
    live_spec_path = output_directory / LIVE_SPEC_FILE_NAME
    existing_paths = [
        path
        for path in (*final_paths.values(), manifest_path, live_spec_path)
        if path.exists()
    ]
    if existing_paths and not arguments.overwrite:
        raise FixtureGenerationError(
            f"Output already exists; pass --overwrite: {existing_paths[0]}"
        )

    ffmpeg_version = run_command((ffmpeg_path, "-version"), "FFmpeg version query")
    ffmpeg_version_line = ffmpeg_version.stdout.splitlines()[0]
    fixture_records: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="webgpu-static-hdr-") as temporary_directory:
        temporary_path = Path(temporary_directory)
        base_HEVC_path = temporary_path / "base.hevc"
        generate_base_HEVC(
            ffmpeg_path,
            base_HEVC_path,
            width=arguments.width,
            height=arguments.height,
            frame_rate=arguments.frame_rate,
            duration_seconds=arguments.duration_seconds,
        )
        base_HEVC = base_HEVC_path.read_bytes()
        staged_paths: dict[str, Path] = {}
        for definition in fixture_definitions:
            injected_HEVC = inject_prefix_SEI_NAL_units(
                base_HEVC, definition.injected_NAL_units
            )
            initial_status = scan_static_HDR_metadata(injected_HEVC)
            if initial_status != definition.expected_status:
                raise FixtureGenerationError(
                    f"Injected {definition.name} stream classified as {initial_status}"
                )
            injected_path = temporary_path / f"{definition.name}.hevc"
            injected_path.write_bytes(injected_HEVC)
            staged_path = temporary_path / final_paths[definition.name].name
            mux_fixture(
                ffmpeg_path,
                injected_path,
                staged_path,
                frame_rate=arguments.frame_rate,
                duration_seconds=arguments.duration_seconds,
            )
            stream_metadata = require_exact_stream_metadata(
                ffprobe_path,
                staged_path,
                width=arguments.width,
                height=arguments.height,
                frame_rate=arguments.frame_rate,
            )
            extracted_path = temporary_path / f"{definition.name}.extracted.hevc"
            extracted_status = scan_static_HDR_metadata(
                extract_HEVC(ffmpeg_path, staged_path, extracted_path)
            )
            if extracted_status != definition.expected_status:
                raise FixtureGenerationError(
                    f"Muxed {definition.name} stream classified as {extracted_status}"
                )
            staged_paths[definition.name] = staged_path
            fixture_records.append(
                {
                    "byteLength": staged_path.stat().st_size,
                    "expectedStaticHDRMetadataStatus": definition.expected_status,
                    "expectedToneMappingPeakNits": definition.expected_peak_nits,
                    "file": final_paths[definition.name].name,
                    "media": stream_metadata,
                    "sha256": calculate_SHA256(staged_path),
                }
            )

        for definition in fixture_definitions:
            os.replace(staged_paths[definition.name], final_paths[definition.name])

    manifest = {
        "durationSeconds": arguments.duration_seconds,
        "ffmpegVersion": ffmpeg_version_line,
        "fixtures": fixture_records,
        "frameRate": arguments.frame_rate,
        "generator": Path(__file__).name,
        "height": arguments.height,
        "schemaVersion": 1,
        "width": arguments.width,
    }
    live_spec = {
        "$schema": "../validation/live-overlay-spec-schema.json",
        "schemaVersion": 1,
        "sources": create_live_source_records(
            fixture_records,
            width=arguments.width,
            height=arguments.height,
            frame_rate=arguments.frame_rate,
            duration_seconds=arguments.duration_seconds,
        ),
    }
    temporary_manifest_path = manifest_path.with_suffix(".tmp")
    temporary_manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_manifest_path, manifest_path)
    temporary_live_spec_path = live_spec_path.with_suffix(".tmp")
    temporary_live_spec_path.write_text(
        json.dumps(live_spec, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_live_spec_path, live_spec_path)
    return {
        "fixtureCount": len(fixture_records),
        "liveSpec": str(live_spec_path),
        "manifest": str(manifest_path),
        "status": "generated",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the CLI and emits one bounded machine-readable summary."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (FixtureGenerationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Static HDR fixture generation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
