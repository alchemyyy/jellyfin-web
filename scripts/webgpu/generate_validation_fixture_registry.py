#!/usr/bin/env python3
"""Generate all checked validation fixture-registry fragments without transcoding."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

from ab_harness import HarnessError, write_json
from generate_dts_capability_fixtures import (
    create_registry_fragment as create_dts_fragment,
)
from generate_jpeg2000_capability_fixture import (
    DEFAULT_OUTPUT as JPEG2000_OUTPUT,
    create_registry_fragment as create_jpeg2000_fragment,
)
from generate_legacy_video_capability_fixture import (
    create_registry_fragment as create_legacy_video_fragment,
)
from generate_truehd_capability_fixtures import (
    create_registry_fragment as create_truehd_fragment,
)
from validation_fixture_registry import (
    DEFAULT_FRAGMENT_DIRECTORY,
    REPOSITORY_ROOT,
    write_or_check_fragment,
)


FragmentFactory = Callable[[], dict[str, object]]
MANIFEST_PATH = REPOSITORY_ROOT / "scripts" / "webgpu" / "validation" / "manifest.json"


def parse_arguments() -> argparse.Namespace:
    """Parses the registry-only generation mode."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if any checked-in registry fragment is stale",
    )
    return parser.parse_args()


def fragment_factories() -> tuple[tuple[str, FragmentFactory], ...]:
    """Returns every canonical registry fragment in stable load order."""

    dts_fixture_directory = REPOSITORY_ROOT / "scripts" / "webgpu" / "dts" / "fixtures"
    factories: list[tuple[str, FragmentFactory]] = []
    factories.append(
        ("jpeg2000.json", lambda: create_jpeg2000_fragment(JPEG2000_OUTPUT))
    )
    factories.append(("legacy-video.json", create_legacy_video_fragment))
    factories.append(("dts.json", lambda: create_dts_fragment(dts_fixture_directory)))
    factories.append(("truehd.json", lambda: create_truehd_fragment(REPOSITORY_ROOT)))
    return tuple(factories)


def write_or_check_manifest_references(
    file_names: tuple[str, ...],
    *,
    check: bool,
) -> None:
    """Keeps generated records out of the hand-maintained manifest."""

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise HarnessError("Validation manifest must be a JSON object")
    fragment_uris = [
        f"repo://scripts/webgpu/validation/generated/{file_name}"
        for file_name in file_names
    ]
    if check:
        if manifest.get("fixtureRegistryFragments") != fragment_uris:
            raise HarnessError(
                "Validation manifest fixture registry references are stale"
            )
        if manifest.get("fixtures") != []:
            raise HarnessError(
                "Generated fixtures must not be duplicated in the manifest"
            )
        return
    existing_fixtures = manifest.get("fixtures")
    if existing_fixtures not in (None, []):
        raise HarnessError(
            "Refusing to discard hand-maintained inline fixtures from the manifest"
        )
    manifest["fixtureRegistryFragments"] = fragment_uris
    manifest["fixtures"] = []
    write_json(MANIFEST_PATH, manifest)


def main() -> int:
    """Writes or checks all registry fragments without invoking a codec tool."""

    arguments = parse_arguments()
    factories = fragment_factories()
    for file_name, factory in factories:
        output_path: Path = DEFAULT_FRAGMENT_DIRECTORY / file_name
        write_or_check_fragment(
            output_path,
            factory(),
            check=arguments.check,
        )
        action = "Verified" if arguments.check else "Generated"
        print(f"{action} {output_path}")
    write_or_check_manifest_references(
        tuple(file_name for file_name, _factory in factories),
        check=arguments.check,
    )
    print(f"{'Verified' if arguments.check else 'Updated'} {MANIFEST_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
