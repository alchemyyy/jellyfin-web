#!/usr/bin/env python3
"""Generate bounded DTS capability access units from public-domain fixtures."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
from typing import Final, TypedDict

from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    REPOSITORY_ROOT,
    FixtureRegistrySpecification,
    create_fixture_registry_fragment,
    write_or_check_fragment,
)


class FixtureConfiguration(TypedDict):
    bits_per_sample: int
    channel_count: int
    channel_layout: str
    fixture_id: str
    name: str
    profile: str
    sample_rate: int
    sha256: str


FIXTURE_CONFIGURATIONS: Final[tuple[FixtureConfiguration, ...]] = (
    {
        "bits_per_sample": 24,
        "channel_count": 6,
        "channel_layout": "5.1",
        "fixture_id": "dts-core-5-1-48k",
        "name": "core_51_24_48_768_0.dtshd",
        "profile": "core",
        "sample_rate": 48_000,
        "sha256": "95653e7d94307a9d467c28ae10883440dcc39f06ac79d7401b27eb422cd99009",
    },
    {
        "bits_per_sample": 24,
        "channel_count": 6,
        "channel_layout": "5.1",
        "fixture_id": "dts-96-24-5-1-96k",
        "name": "x96_51_24_96_1509.dtshd",
        "profile": "96-24",
        "sample_rate": 96_000,
        "sha256": "d4d4df6d83042799df124fe48d3465381c57f4f3b2483cb0fe8aa52ea403a9f5",
    },
    {
        "bits_per_sample": 24,
        "channel_count": 7,
        "channel_layout": "6.1",
        "fixture_id": "dts-es-6-1-48k",
        "name": "xch_61_24_48_768.dtshd",
        "profile": "es",
        "sample_rate": 48_000,
        "sha256": "db7c44e47b3c01c57829ac9947a0e77aa93798475773e1f2fd74f99a607c48b7",
    },
    {
        "bits_per_sample": 24,
        "channel_count": 8,
        "channel_layout": "7.1",
        "fixture_id": "dts-hd-hra-7-1-48k",
        "name": "xbr_xxch_71_24_48_3840.dtshd",
        "profile": "hd-hra",
        "sample_rate": 48_000,
        "sha256": "b24e66db937a45b7ce522b773388d29492a88e83fc8680930be00c5987ac93a1",
    },
    {
        "bits_per_sample": 24,
        "channel_count": 8,
        "channel_layout": "7.1",
        "fixture_id": "dts-hd-ma-7-1-48k",
        "name": "xll_71_24_48_768_0.dtshd",
        "profile": "hd-ma",
        "sample_rate": 48_000,
        "sha256": "8d380d1323a6fff90a8885d65697217b1bbc4f2c027e30af870fa0dfa50f8eb3",
    },
    {
        "bits_per_sample": 24,
        "channel_count": 8,
        "channel_layout": "7.1",
        "fixture_id": "dts-hd-ma-7-1-96k",
        "name": "xll_71_24_96_768.dtshd",
        "profile": "hd-ma",
        "sample_rate": 96_000,
        "sha256": "d2911b34183f7379359cf914ee93228796894e0b0f0055e6ee5baefa4fd6a923",
    },
    {
        "bits_per_sample": 16,
        "channel_count": 6,
        "channel_layout": "5.1",
        "fixture_id": "dts-hd-ma-5-1-192k",
        "name": "xll_51_16_192_768_0.dtshd",
        "profile": "hd-ma",
        "sample_rate": 192_000,
        "sha256": "34441a4f2df89e086f67a7b0f72aa871e1cbb3b04b301470a7727038bb91b618",
    },
)
MATROSKA_FIXTURE_SHA256: Final = (
    "8a82706387b2609b1d6fce40fc65dea860cfd4e5a6f7f7021bb4480af09e8c6d"
)


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[2]
    default_fixture_directory = (
        repository_root
        / "scripts/webgpu/dts/fixtures"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture-directory",
        type=Path,
        default=default_fixture_directory,
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            repository_root
            / "src/plugins/webGPUVideoPlayer/custom/DTSExactCapabilityFixtures.ts"
        ),
    )
    parser.add_argument(
        "--registry-output",
        type=Path,
        default=DEFAULT_FRAGMENT_DIRECTORY / "dts.json",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked-in output is not current",
    )
    return parser.parse_args()


def require_file_hash(path: Path, expected_sha256: str) -> bytes:
    data = path.read_bytes()
    actual_sha256 = hashlib.sha256(data).hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"DTS fixture hash mismatch for {path.name}: {actual_sha256}"
        )
    return data


def create_registry_fragment(fixture_directory: Path) -> dict[str, object]:
    """Creates all exact DTS and Matroska registry records."""

    try:
        repository_fixture_directory = fixture_directory.resolve().relative_to(
            REPOSITORY_ROOT
        )
    except ValueError as error:
        raise RuntimeError(
            "DTS registry fixtures must be inside the repository"
        ) from error
    specifications: list[FixtureRegistrySpecification] = []
    for configuration in FIXTURE_CONFIGURATIONS:
        specifications.append(
            FixtureRegistrySpecification(
                fixture_id=configuration["fixture_id"],
                repository_path=(
                    repository_fixture_directory / configuration["name"]
                ).as_posix(),
                expected_sha256=configuration["sha256"],
                license_expression="LicenseRef-Public-Domain",
                license_evidence_uri="repo://scripts/webgpu/dts/fixtures/README.md",
                provenance={
                    "generatorArguments": [
                        "python",
                        "scripts/webgpu/generate_dts_capability_fixtures.py",
                        "--check",
                    ],
                    "kind": "upstream",
                    "revision": "8665d5718888f2b9192516f86014cc3642ed653a",
                    "source": "foo86/dcadec-samples",
                },
                media={
                    "audio": {
                        "bitsPerSample": configuration["bits_per_sample"],
                        "channelCount": configuration["channel_count"],
                        "channelLayout": configuration["channel_layout"],
                        "codec": "dts",
                        "profile": configuration["profile"],
                        "sampleRate": configuration["sample_rate"],
                    },
                    "container": "dts-hd",
                    "packetization": "dts-access-units",
                },
            )
        )
    specifications.append(
        FixtureRegistrySpecification(
            fixture_id="dts-core-5-1-48k-matroska",
            repository_path=(
                repository_fixture_directory / "core_51_24_48_768_0.mka"
            ).as_posix(),
            expected_sha256=MATROSKA_FIXTURE_SHA256,
            license_expression="LicenseRef-Public-Domain",
            license_evidence_uri="repo://scripts/webgpu/dts/fixtures/README.md",
            provenance={
                "generatorArguments": [
                    "ffmpeg",
                    "-fflags",
                    "+bitexact",
                    "-i",
                    "core_51_24_48_768_0.dtshd",
                    "-c:a",
                    "copy",
                    "-f",
                    "matroska",
                    "core_51_24_48_768_0.mka",
                ],
                "kind": "upstream",
                "revision": "8665d5718888f2b9192516f86014cc3642ed653a-remux-v1",
                "source": "foo86/dcadec-samples remuxed without metadata",
            },
            media={
                "audio": {
                    "bitsPerSample": 24,
                    "channelCount": 6,
                    "channelLayout": "5.1",
                    "codec": "dts",
                    "profile": "core",
                    "sampleRate": 48_000,
                },
                "container": "matroska",
                "packetization": "a-dts",
            },
        )
    )
    return create_fixture_registry_fragment(
        registry_id="dts",
        generator_uri="repo://scripts/webgpu/generate_dts_capability_fixtures.py",
        specifications=specifications,
    )


def generate_typescript(fixture_directory: Path) -> str:
    packet_definitions = json.loads(
        (fixture_directory / "packets.json").read_text(encoding="utf-8")
    )
    generated_definitions: list[str] = []
    for configuration in FIXTURE_CONFIGURATIONS:
        file_name = configuration["name"]
        fixture_data = require_file_hash(
            fixture_directory / file_name,
            configuration["sha256"],
        )
        definition = packet_definitions[file_name]
        packet_index = int(definition["qualificationPacketIndex"])
        stereo_fingerprint = definition.get("qualificationStereoFingerprint")
        stereo_fingerprint_typescript = (
            str(int(stereo_fingerprint))
            if stereo_fingerprint is not None
            else "null"
        )
        encoded_access_units: list[str] = []
        for packet_offset, packet_length in definition["packets"][: packet_index + 1]:
            access_unit = fixture_data[packet_offset : packet_offset + packet_length]
            if len(access_unit) != packet_length:
                raise RuntimeError(f"DTS qualification packet is truncated: {file_name}")
            encoded_access_units.append(
                base64.b64encode(access_unit).decode("ascii")
            )
        access_units_typescript = ", ".join(
            f"'{encoded_access_unit}'"
            for encoded_access_unit in encoded_access_units
        )
        generated_definitions.append(
            "    Object.freeze({\n"
            f"        accessUnitsBase64: Object.freeze([{access_units_typescript}]),\n"
            f"        bitsPerSample: {int(definition['expectedBitsPerSample'])},\n"
            f"        channelMask: {int(definition['expectedChannelMask'])},\n"
            f"        expectedFingerprint: {int(definition['qualificationFingerprint'])},\n"
            f"        expectedStereoFingerprint: {stereo_fingerprint_typescript},\n"
            f"        frameCount: {int(definition['qualificationFrameCount'])},\n"
            f"        profile: {int(definition['expectedProfile'])},\n"
            f"        sampleRate: {int(definition['expectedSampleRate'])},\n"
            f"        source: '{file_name}'\n"
            "    })"
        )

    definitions = ",\n".join(generated_definitions)
    return f"""// Generated by scripts/webgpu/generate_dts_capability_fixtures.py
// Source samples are public domain; see scripts/webgpu/dts/fixtures/README.md

import type {{ DTSDecodedProfile }} from './DTSSoftwareAudioDecoder';

export type DTSExactCapabilityFixture = Readonly<{{
    accessUnits: readonly Uint8Array[]
    bitsPerSample: 16 | 24
    channelMask: number
    expectedFingerprint: number
    expectedStereoFingerprint: number | null
    frameCount: number
    profile: DTSDecodedProfile
    sampleRate: 48_000 | 96_000 | 192_000
    source: string
}}>;

type EncodedDTSExactCapabilityFixture = Omit<
    DTSExactCapabilityFixture,
    'accessUnits'
> & Readonly<{{ accessUnitsBase64: readonly string[] }}>;

const ENCODED_DTS_EXACT_CAPABILITY_FIXTURES = Object.freeze([
{definitions}
]) satisfies readonly EncodedDTSExactCapabilityFixture[];

function decodeBase64(value: string): Uint8Array {{
    const decoded = globalThis.atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {{
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }}
    return bytes;
}}

/** Creates isolated qualification access units for every authorized DTS profile. */
export function createDTSExactCapabilityFixtures(): readonly DTSExactCapabilityFixture[] {{
    const fixtures: DTSExactCapabilityFixture[] = [];
    for (const fixture of ENCODED_DTS_EXACT_CAPABILITY_FIXTURES) {{
        fixtures.push(Object.freeze({{
            accessUnits: Object.freeze(fixture.accessUnitsBase64.map(decodeBase64)),
            bitsPerSample: fixture.bitsPerSample,
            channelMask: fixture.channelMask,
            expectedFingerprint: fixture.expectedFingerprint,
            expectedStereoFingerprint: fixture.expectedStereoFingerprint,
            frameCount: fixture.frameCount,
            profile: fixture.profile,
            sampleRate: fixture.sampleRate,
            source: fixture.source
        }}));
    }}
    return Object.freeze(fixtures);
}}
"""


def main() -> None:
    arguments = parse_arguments()
    fixture_directory = arguments.fixture_directory.resolve()
    output_path = arguments.output.resolve()
    registry_output_path = arguments.registry_output.resolve()
    generated_typescript = generate_typescript(fixture_directory)
    registry_fragment = create_registry_fragment(fixture_directory)
    if arguments.check:
        if not output_path.is_file() or output_path.read_text(
            encoding="utf-8"
        ) != generated_typescript:
            raise RuntimeError(
                f"DTS capability fixture output is stale: {output_path}"
            )
        write_or_check_fragment(
            registry_output_path,
            registry_fragment,
            check=True,
        )
        print(f"Verified {output_path} and {registry_output_path}")
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        generated_typescript,
        encoding="utf-8",
        newline="\n",
    )
    write_or_check_fragment(
        registry_output_path,
        registry_fragment,
        check=False,
    )
    print(f"Generated {output_path} and {registry_output_path}")


if __name__ == "__main__":
    main()
