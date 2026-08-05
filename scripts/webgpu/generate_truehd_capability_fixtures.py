#!/usr/bin/env python3
"""Generate deterministic synthetic TrueHD/MLP exact-capability fixtures."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ab_harness import HarnessError
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


FIXTURE_DURATION_SECONDS = 0.05
FIXTURE_PACKET_COUNT = 32
FNV1A_OFFSET_BASIS = 2_166_136_261
FNV1A_PRIME = 16_777_619


@dataclass(frozen=True)
class FixtureDefinition:
    name: str
    fixture_id: str
    codec: str
    channel_count: int
    channel_layout: str
    registry_channel_layout: str
    channel_mask: int
    sample_rate: int
    expected_sha256: str


FIXTURE_DEFINITIONS = (
    FixtureDefinition(
        name="truehd_stereo_24_48000",
        fixture_id="truehd-stereo-48k",
        codec="truehd",
        channel_count=2,
        channel_layout="stereo",
        registry_channel_layout="stereo",
        channel_mask=0x0003,
        sample_rate=48_000,
        expected_sha256=(
            "4ae1dd30bae837f377e094fbc180c9c642a6b874331220d0bb42a6afecd1fb32"
        ),
    ),
    FixtureDefinition(
        name="truehd_51_side_24_96000",
        fixture_id="truehd-5-1-side-96k",
        codec="truehd",
        channel_count=6,
        channel_layout="5.1(side)",
        registry_channel_layout="5.1-side",
        channel_mask=0x060F,
        sample_rate=96_000,
        expected_sha256=(
            "0bbfcaa1910a92ef9a1434ec8ba3bc99f8f5e7309bde2305282d4d3c19d5953e"
        ),
    ),
    FixtureDefinition(
        name="truehd_51_side_24_192000",
        fixture_id="truehd-5-1-side-192k",
        codec="truehd",
        channel_count=6,
        channel_layout="5.1(side)",
        registry_channel_layout="5.1-side",
        channel_mask=0x060F,
        sample_rate=192_000,
        expected_sha256=(
            "b6d447fd0d80c8fe1b624742cb64cd2161569eca3c1f0e32c292cc6404e369ce"
        ),
    ),
    FixtureDefinition(
        name="mlp_stereo_24_48000",
        fixture_id="mlp-stereo-48k",
        codec="mlp",
        channel_count=2,
        channel_layout="stereo",
        registry_channel_layout="stereo",
        channel_mask=0x0003,
        sample_rate=48_000,
        expected_sha256=(
            "0a8ecef742d164ad74d99576b22e4688ef76e899ca36ce601666b2c8c71d1d72"
        ),
    ),
)
MATROSKA_FIXTURE_SHA256 = (
    "ddeafef97bd560b548ae93af4cc02f7aa43c7a69b231471d93922e7e36fbbf9e"
)


def require_executable(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"Required executable is unavailable: {name}")
    return executable


def create_channel_expression(channel_count: int) -> str:
    expressions: list[str] = []
    for channel_index in range(channel_count):
        frequency = 220 + 110 * channel_index
        amplitude = 0.0625 + 0.0078125 * channel_index
        expressions.append(f"{amplitude}*sin(2*PI*{frequency}*t)")
    return "|".join(expressions)


def generate_source(
    ffmpeg: str,
    definition: FixtureDefinition,
    destination: Path,
) -> None:
    filter_expression = (
        f"aevalsrc={create_channel_expression(definition.channel_count)}:"
        f"s={definition.sample_rate}:d={FIXTURE_DURATION_SECONDS}:"
        f"c={definition.channel_layout}"
    )
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            filter_expression,
            "-map",
            "0:a:0",
            "-c:a",
            definition.codec,
            "-strict",
            "-2",
            "-sample_fmt",
            "s32p",
            "-max_interval",
            "16",
            "-f",
            definition.codec,
            "-y",
            str(destination),
        ],
        check=True,
    )


def probe_json(ffprobe: str, codec: str, source: Path, section: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-f",
            codec,
            f"-show_{section}",
            "-print_format",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    values = data.get(section)
    if not isinstance(values, list):
        raise RuntimeError(f"ffprobe did not return {section} for {source}")
    return values


def decode_reference_pcm(ffmpeg: str, codec: str, source: Path) -> bytes:
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            codec,
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_s32le",
            "-f",
            "s32le",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def fnv1a(data: bytes) -> int:
    fingerprint = FNV1A_OFFSET_BASIS
    for byte in data:
        fingerprint ^= byte
        fingerprint = (fingerprint * FNV1A_PRIME) & 0xFFFFFFFF
    return fingerprint


def microseconds_from_time(value: Any) -> int:
    if not isinstance(value, str):
        raise RuntimeError("ffprobe timestamp is unavailable")
    return round(float(value) * 1_000_000)


def create_fixture_record(
    ffmpeg: str,
    ffprobe: str,
    definition: FixtureDefinition,
    source: Path,
) -> dict[str, Any]:
    source_data = source.read_bytes()
    source_sha256 = hashlib.sha256(source_data).hexdigest()
    if source_sha256 != definition.expected_sha256:
        raise RuntimeError(
            f"TrueHD/MLP fixture hash mismatch for {source.name}: {source_sha256}"
        )
    packets = probe_json(ffprobe, definition.codec, source, "packets")
    frames = probe_json(ffprobe, definition.codec, source, "frames")
    if len(packets) < FIXTURE_PACKET_COUNT or len(frames) < FIXTURE_PACKET_COUNT:
        raise RuntimeError(f"Fixture {definition.name} has too few packets or frames")
    packets = packets[:FIXTURE_PACKET_COUNT]
    frames = frames[:FIXTURE_PACKET_COUNT]
    reference_pcm = decode_reference_pcm(ffmpeg, definition.codec, source)

    encoded_packets: list[str] = []
    expected_outputs: list[dict[str, int]] = []
    pcm_offset = 0
    for packet, frame in zip(packets, frames, strict=True):
        packet_position = int(packet["pos"])
        packet_size = int(packet["size"])
        frame_position = int(frame["pkt_pos"])
        if packet_position != frame_position:
            raise RuntimeError("TrueHD reference frame does not match its encoded packet")
        packet_data = source_data[packet_position:packet_position + packet_size]
        if len(packet_data) != packet_size:
            raise RuntimeError("TrueHD packet range exceeds its source fixture")
        encoded_packets.append(base64.b64encode(packet_data).decode("ascii"))

        frame_count = int(frame["nb_samples"])
        pcm_byte_length = frame_count * definition.channel_count * 4
        frame_pcm = reference_pcm[pcm_offset:pcm_offset + pcm_byte_length]
        if len(frame_pcm) != pcm_byte_length:
            raise RuntimeError("Decoded TrueHD reference PCM is truncated")
        pcm_offset += pcm_byte_length
        expected_outputs.append(
            {
                "frameCount": frame_count,
                "mediaTimeMicroseconds": microseconds_from_time(frame["pts_time"]),
                "pcmFingerprint": fnv1a(frame_pcm),
            }
        )

    return {
        "accessUnitsBase64": encoded_packets,
        "bitsPerSample": 24,
        "channelCount": definition.channel_count,
        "channelMask": definition.channel_mask,
        "codec": definition.codec,
        "expectedOutputs": expected_outputs,
        "majorSyncRecoveryStartIndex": 1,
        "sampleRate": definition.sample_rate,
        "source": source.name,
        "sourceSHA256": source_sha256,
    }


def create_registry_fragment(repository_root: Path) -> dict[str, object]:
    """Creates all exact TrueHD, MLP, and Matroska registry records."""

    fixture_directory = repository_root / "scripts" / "webgpu" / "truehd" / "fixtures"
    repository_fixture_directory = fixture_directory.relative_to(repository_root)
    specifications: list[FixtureRegistrySpecification] = []
    for definition in FIXTURE_DEFINITIONS:
        specifications.append(
            FixtureRegistrySpecification(
                fixture_id=definition.fixture_id,
                repository_path=(
                    repository_fixture_directory
                    / f"{definition.name}.{definition.codec}"
                ).as_posix(),
                expected_sha256=definition.expected_sha256,
                license_expression="GPL-2.0-or-later",
                license_evidence_uri="repo://LICENSE",
                provenance={
                    "generatorArguments": [
                        "python",
                        "scripts/webgpu/generate_truehd_capability_fixtures.py",
                        "--regenerate-sources",
                    ],
                    "kind": "generated",
                    "revision": "fixture-v1",
                    "source": "Mathematically generated sine tones encoded by FFmpeg",
                },
                media={
                    "audio": {
                        "bitsPerSample": 24,
                        "channelCount": definition.channel_count,
                        "channelLayout": definition.registry_channel_layout,
                        "codec": definition.codec,
                        "profile": definition.codec,
                        "sampleRate": definition.sample_rate,
                    },
                    "container": definition.codec,
                    "packetization": f"{definition.codec}-access-units",
                },
            )
        )
    specifications.append(
        FixtureRegistrySpecification(
            fixture_id="truehd-5-1-side-96k-matroska",
            repository_path=(
                repository_fixture_directory / "truehd_51_side_24_96000.mka"
            ).as_posix(),
            expected_sha256=MATROSKA_FIXTURE_SHA256,
            license_expression="GPL-2.0-or-later",
            license_evidence_uri="repo://LICENSE",
            provenance={
                "generatorArguments": [
                    "ffmpeg",
                    "-fflags",
                    "+bitexact",
                    "-f",
                    "truehd",
                    "-i",
                    "truehd_51_side_24_96000.truehd",
                    "-c:a",
                    "copy",
                    "-f",
                    "matroska",
                    "truehd_51_side_24_96000.mka",
                ],
                "kind": "generated",
                "revision": "fixture-v1-remux-v1",
                "source": (
                    "Mathematically generated sine tones remuxed without metadata"
                ),
            },
            media={
                "audio": {
                    "bitsPerSample": 24,
                    "channelCount": 6,
                    "channelLayout": "5.1-side",
                    "codec": "truehd",
                    "profile": "truehd",
                    "sampleRate": 96_000,
                },
                "container": "matroska",
                "packetization": "a-truehd",
            },
        )
    )
    return create_fixture_registry_fragment(
        registry_id="truehd",
        generator_uri="repo://scripts/webgpu/generate_truehd_capability_fixtures.py",
        specifications=specifications,
        repository_root=repository_root,
    )


def format_typescript(fixtures: list[dict[str, Any]]) -> str:
    definitions: list[str] = []
    for fixture in fixtures:
        access_units = ",\n".join(
            f"            '{access_unit}'"
            for access_unit in fixture["accessUnitsBase64"]
        )
        expected_outputs = ",\n".join(
            "            Object.freeze({\n"
            f"                frameCount: {output['frameCount']},\n"
            "                mediaTimeMicroseconds: "
            f"{output['mediaTimeMicroseconds']},\n"
            f"                pcmFingerprint: {output['pcmFingerprint']}\n"
            "            })"
            for output in fixture["expectedOutputs"]
        )
        definitions.append(
            "    Object.freeze({\n"
            "        accessUnitsBase64: Object.freeze([\n"
            f"{access_units}\n"
            "        ]),\n"
            f"        bitsPerSample: {fixture['bitsPerSample']},\n"
            f"        channelCount: {fixture['channelCount']},\n"
            f"        channelMask: {fixture['channelMask']},\n"
            f"        codec: '{fixture['codec']}',\n"
            "        expectedOutputs: Object.freeze([\n"
            f"{expected_outputs}\n"
            "        ]),\n"
            "        majorSyncRecoveryStartIndex: "
            f"{fixture['majorSyncRecoveryStartIndex']},\n"
            f"        sampleRate: {fixture['sampleRate']},\n"
            f"        source: '{fixture['source']}',\n"
            f"        sourceSHA256: '{fixture['sourceSHA256']}'\n"
            "    })"
        )
    encoded_definitions = ",\n".join(definitions)
    return f"""// Generated by scripts/webgpu/generate_truehd_capability_fixtures.py
// Sources are deterministic synthetic tones; see scripts/webgpu/truehd/fixtures/PROVENANCE.txt

import type {{ Microseconds }} from '../MediaTime';
import type {{ TrueHDDecoderCodec }} from './TrueHDSoftwareAudioDecoder';

export type TrueHDExactCapabilityExpectedOutput = Readonly<{{
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    pcmFingerprint: number
}}>;

export type TrueHDExactCapabilityFixture = Readonly<{{
    accessUnits: readonly Uint8Array[]
    bitsPerSample: 24
    channelCount: 2 | 6
    channelMask: number
    codec: TrueHDDecoderCodec
    expectedOutputs: readonly TrueHDExactCapabilityExpectedOutput[]
    majorSyncRecoveryStartIndex: 1
    sampleRate: 48_000 | 96_000 | 192_000
    source: string
    sourceSHA256: string
}}>;

type EncodedTrueHDExactCapabilityFixture = Omit<
    TrueHDExactCapabilityFixture,
    'accessUnits' | 'expectedOutputs'
> & Readonly<{{
    accessUnitsBase64: readonly string[]
    expectedOutputs: readonly Readonly<{{
        frameCount: number
        mediaTimeMicroseconds: number
        pcmFingerprint: number
    }}>[]
}}>;

const ENCODED_TRUEHD_EXACT_CAPABILITY_FIXTURES = Object.freeze([
{encoded_definitions}
]) satisfies readonly EncodedTrueHDExactCapabilityFixture[];

function decodeBase64(value: string): Uint8Array {{
    const decoded = globalThis.atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {{
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }}
    return bytes;
}}

/** Creates isolated exact-output fixtures for the pinned TrueHD/MLP decoder. */
export function createTrueHDExactCapabilityFixtures(): readonly TrueHDExactCapabilityFixture[] {{
    const fixtures: TrueHDExactCapabilityFixture[] = [];
    for (const fixture of ENCODED_TRUEHD_EXACT_CAPABILITY_FIXTURES) {{
        fixtures.push(Object.freeze({{
            accessUnits: Object.freeze(fixture.accessUnitsBase64.map(decodeBase64)),
            bitsPerSample: fixture.bitsPerSample,
            channelCount: fixture.channelCount,
            channelMask: fixture.channelMask,
            codec: fixture.codec,
            expectedOutputs: Object.freeze(fixture.expectedOutputs.map(output => Object.freeze({{
                frameCount: output.frameCount,
                mediaTimeMicroseconds: output.mediaTimeMicroseconds as Microseconds,
                pcmFingerprint: output.pcmFingerprint
            }}))),
            majorSyncRecoveryStartIndex: fixture.majorSyncRecoveryStartIndex,
            sampleRate: fixture.sampleRate,
            source: fixture.source,
            sourceSHA256: fixture.sourceSHA256
        }}));
    }}
    return Object.freeze(fixtures);
}}
"""


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--regenerate-sources",
        action="store_true",
        help="Regenerate the checked-in deterministic encoded source fixtures",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the TypeScript and registry outputs are stale",
    )
    parser.add_argument(
        "--check-registry",
        action="store_true",
        help="Check only source hashes and the registry without FFmpeg",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            repository_root
            / "src/plugins/webGPUPlayer/custom/TrueHDExactCapabilityFixtures.ts"
        ),
    )
    parser.add_argument(
        "--registry-output",
        type=Path,
        default=DEFAULT_FRAGMENT_DIRECTORY / "truehd.json",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    repository_root = Path(__file__).resolve().parents[2]
    fixture_directory = repository_root / "scripts" / "webgpu" / "truehd" / "fixtures"
    fixture_directory.mkdir(parents=True, exist_ok=True)
    registry_output_path = arguments.registry_output.resolve()
    if arguments.check_registry:
        if arguments.check or arguments.regenerate_sources:
            raise HarnessError(
                "--check-registry cannot be combined with --check or "
                "--regenerate-sources"
            )
        write_or_check_fragment(
            registry_output_path,
            create_registry_fragment(repository_root),
            check=True,
        )
        print(f"Verified {registry_output_path}")
        return 0
    if arguments.check and arguments.regenerate_sources:
        raise HarnessError("--check and --regenerate-sources cannot be combined")
    ffmpeg = require_executable("ffmpeg")
    ffprobe = require_executable("ffprobe")

    fixture_records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="jellyfin-truehd-fixtures-") as temporary_directory:
        temporary_root = Path(temporary_directory)
        for definition in FIXTURE_DEFINITIONS:
            source = fixture_directory / f"{definition.name}.{definition.codec}"
            if arguments.regenerate_sources:
                generated_source = temporary_root / source.name
                generate_source(ffmpeg, definition, generated_source)
                shutil.copy2(generated_source, source)
            if not source.is_file():
                raise RuntimeError(
                    f"Missing {source}; rerun with --regenerate-sources"
                )
            fixture_records.append(
                create_fixture_record(ffmpeg, ffprobe, definition, source)
            )

    output_path = arguments.output.resolve()
    generated_typescript = format_typescript(fixture_records)
    registry_fragment = create_registry_fragment(repository_root)
    if arguments.check:
        if not output_path.is_file() or output_path.read_text(
            encoding="ascii"
        ) != generated_typescript:
            raise RuntimeError(
                f"TrueHD capability fixture output is stale: {output_path}"
            )
        write_or_check_fragment(
            registry_output_path,
            registry_fragment,
            check=True,
        )
        print(f"Verified {output_path} and {registry_output_path}")
        return 0
    output_path.write_text(generated_typescript, encoding="ascii")
    write_or_check_fragment(
        registry_output_path,
        registry_fragment,
        check=False,
    )
    print(
        f"Generated {len(fixture_records)} TrueHD/MLP exact capability fixtures "
        f"and {registry_output_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
