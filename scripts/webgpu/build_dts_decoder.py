#!/usr/bin/env python3
"""Build the pinned libdcadec decoder as a bounded WebAssembly module."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
LIBDCADEC_COMMIT = "b93deed1a231dd6dd7e39b9fe7d2abe05aa00158"
LIBDCADEC_SOURCE_SHA256 = (
    "a33105039c74f913264ba4cca5d40e23d25b11f4149c9411fe4aad4d1c6a3a41"
)
LIBDCADEC_SOURCE_URL = (
    "https://github.com/foo86/dcadec/archive/"
    f"{LIBDCADEC_COMMIT}.tar.gz"
)
EMSCRIPTEN_VERSION = "4.0.13"
EMSCRIPTEN_REVISION = "2659582941bef14008476903f48941909db1b196"
DETERMINISTIC_SOURCE_DATE_EPOCH = "0"
IGNORED_BUILD_ENVIRONMENT_VARIABLES = (
    "AR",
    "CC",
    "CFLAGS",
    "CONFIG_SITE",
    "CPPFLAGS",
    "CXX",
    "CXXFLAGS",
    "EMCC_CFLAGS",
    "EMCC_FORCE_STDLIBS",
    "EMCC_ONLY_FORCED_STDLIBS",
    "EMMAKEN_CFLAGS",
    "EMMAKEN_JUST_CONFIGURE",
    "LD",
    "LDFLAGS",
    "LIBS",
    "MAKEFLAGS",
    "MFLAGS",
    "NM",
    "PKG_CONFIG",
    "PKG_CONFIG_LIBDIR",
    "PKG_CONFIG_PATH",
    "RANLIB",
)

LIBDCADEC_SOURCE_FILES = (
    "bitstream.c",
    "core_decoder.c",
    "dca_context.c",
    "dca_frame.c",
    "dmix_tables.c",
    "exss_parser.c",
    "idct_fixed.c",
    "idct_float.c",
    "interpolator.c",
    "interpolator_fixed.c",
    "interpolator_float.c",
    "lbr_decoder.c",
    "ta.c",
    "xll_decoder.c",
)

EXPORTED_FUNCTIONS = (
    "_jellyfin_dts_create",
    "_jellyfin_dts_configure_packet",
    "_jellyfin_dts_decode_packet",
    "_jellyfin_dts_get_plane",
    "_jellyfin_dts_get_sample_count",
    "_jellyfin_dts_get_channel_mask",
    "_jellyfin_dts_get_sample_rate",
    "_jellyfin_dts_get_bits_per_sample",
    "_jellyfin_dts_get_profile",
    "_jellyfin_dts_get_parse_status",
    "_jellyfin_dts_get_filter_status",
    "_jellyfin_dts_clear",
    "_jellyfin_dts_destroy",
    "_jellyfin_dts_library_version",
)


def require_sha256(path: Path, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(block)
    actual_sha256 = digest.hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"SHA-256 mismatch for {path}: expected {expected_sha256}, "
            f"received {actual_sha256}"
        )


def sha256_file(path: Path) -> str:
    """Returns the lowercase SHA-256 digest for a file."""
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_source_archive(destination: Path) -> None:
    """Downloads the pinned source archive without exposing partial output."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        require_sha256(destination, LIBDCADEC_SOURCE_SHA256)
        return

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            with urllib.request.urlopen(LIBDCADEC_SOURCE_URL) as response:
                shutil.copyfileobj(response, temporary_file)
        require_sha256(temporary_path, LIBDCADEC_SOURCE_SHA256)
        temporary_path.replace(destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    require_sha256(destination, LIBDCADEC_SOURCE_SHA256)


def select_source_archive(
    requested_archive: Path | None,
    repository_root: Path,
) -> Path:
    """Selects only an explicit, packaged, or downloaded pinned archive."""
    if requested_archive is not None:
        archive_path = requested_archive.resolve(strict=True)
        require_sha256(archive_path, LIBDCADEC_SOURCE_SHA256)
        return archive_path

    standalone_archive = repository_root / "libdcadec-source.tar.gz"
    if standalone_archive.is_file():
        require_sha256(standalone_archive, LIBDCADEC_SOURCE_SHA256)
        return standalone_archive.resolve()

    packaged_archive = (
        repository_root
        / "scripts"
        / "webgpu"
        / "dts"
        / "artifacts"
        / "libdcadec-source.tar.gz"
    )
    if packaged_archive.is_file():
        require_sha256(packaged_archive, LIBDCADEC_SOURCE_SHA256)
        return packaged_archive.resolve()

    cached_archive = (
        repository_root / ".cache" / "webgpu-dts" / "libdcadec-source.tar.gz"
    )
    download_source_archive(cached_archive)
    return cached_archive.resolve()


def extract_source_archive(archive_path: Path, destination: Path) -> Path:
    """Safely extracts the exact pinned libdcadec source root."""
    if destination.exists() and any(destination.iterdir()):
        raise RuntimeError("libdcadec extraction destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        destination_resolved = destination.resolve()
        for member in members:
            member_destination = (destination / member.name).resolve()
            if (
                member_destination == destination_resolved
                or not member_destination.is_relative_to(destination_resolved)
                or not (member.isfile() or member.isdir())
            ):
                raise RuntimeError("libdcadec source archive contains an unsafe path")
        archive.extractall(destination, members=members, filter="data")

    expected_source_directory = destination / f"dcadec-{LIBDCADEC_COMMIT}"
    source_directories = [
        candidate
        for candidate in destination.iterdir()
        if candidate.is_dir()
    ]
    if source_directories != [expected_source_directory]:
        raise RuntimeError("Unable to locate the extracted libdcadec source")
    return expected_source_directory


def find_emscripten_compiler(explicit_path: Path | None, repository_root: Path) -> Path:
    candidates: list[Path] = []
    if explicit_path is not None:
        candidates.append(explicit_path)
    command_path = shutil.which("emcc")
    if command_path:
        candidates.append(Path(command_path))
    candidates.extend(
        (
            repository_root.parent / "emsdk" / "upstream" / "emscripten" / "emcc.bat",
            repository_root.parent / "emsdk" / "upstream" / "emscripten" / "emcc",
        )
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(
        f"Emscripten {EMSCRIPTEN_VERSION} is required; pass --emcc or install the pinned SDK"
    )


def require_emscripten_version(compiler_path: Path) -> None:
    result: subprocess.CompletedProcess[str] = subprocess.run(
        [str(compiler_path), "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    version_output = f"{result.stdout}\n{result.stderr}"
    expected_version_marker = (
        f") {EMSCRIPTEN_VERSION} ({EMSCRIPTEN_REVISION})"
    )
    if expected_version_marker not in version_output:
        raise RuntimeError(
            f"Expected Emscripten {EMSCRIPTEN_VERSION} "
            f"({EMSCRIPTEN_REVISION}), received:\n{version_output.strip()}"
        )


def create_build_environment(compiler_path: Path) -> dict[str, str]:
    """Creates deterministic environment inputs for release builds."""
    environment = os.environ.copy()
    for variable_name in IGNORED_BUILD_ENVIRONMENT_VARIABLES:
        environment.pop(variable_name, None)
    emscripten_configuration = compiler_path.parents[2] / ".emscripten"
    if emscripten_configuration.is_file():
        environment["EM_CONFIG"] = str(emscripten_configuration)
    environment["SOURCE_DATE_EPOCH"] = DETERMINISTIC_SOURCE_DATE_EPOCH
    environment["ZERO_AR_DATE"] = "1"
    environment["LANG"] = "C"
    environment["LC_ALL"] = "C"
    environment["PYTHONHASHSEED"] = "0"
    environment["TZ"] = "UTC"
    return environment


def copy_if_different(source: Path, destination: Path) -> None:
    """Atomically copies an input unless both paths identify the same file."""
    source = source.resolve(strict=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and source.samefile(destination):
        return

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
        shutil.copy2(source, temporary_path)
        temporary_path.replace(destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def build_decoder(
    compiler_path: Path,
    repository_root: Path,
    bridge_path: Path,
    source_root: Path,
    output_path: Path,
) -> None:
    libdcadec_directory = source_root / "libdcadec"
    source_paths = [libdcadec_directory / file_name for file_name in LIBDCADEC_SOURCE_FILES]
    missing_paths = [path for path in source_paths if not path.is_file()]
    if missing_paths:
        raise RuntimeError(f"Pinned libdcadec source is incomplete: {missing_paths}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not bridge_path.is_file():
        raise RuntimeError("The pinned libdcadec bridge source is unavailable")
    command = [
        str(compiler_path),
        "-std=gnu99",
        "-O3",
        "-DNDEBUG",
        "-fno-exceptions",
        f"-ffile-prefix-map={repository_root}=jellyfin-web",
        f"-ffile-prefix-map={source_root}=libdcadec-source",
        f"-I{libdcadec_directory}",
        str(bridge_path),
        *(str(path) for path in source_paths),
        "-sMODULARIZE=1",
        "-sEXPORT_ES6=1",
        "-sENVIRONMENT=worker",
        "-sFILESYSTEM=0",
        "-sSINGLE_FILE=1",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sINITIAL_MEMORY=33554432",
        "-sMAXIMUM_MEMORY=268435456",
        "-sMALLOC=emmalloc",
        "-sASSERTIONS=0",
        "-sWASM_BIGINT=1",
        f"-sEXPORTED_FUNCTIONS={list(EXPORTED_FUNCTIONS)!r}",
        "-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8','HEAP32']",
        "-Wl,--no-entry",
        "-o",
        str(output_path),
    ]
    subprocess.run(
        command,
        check=True,
        cwd=repository_root,
        env=create_build_environment(compiler_path),
    )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emcc", type=Path, help="Path to the pinned emcc executable")
    parser.add_argument(
        "--source-archive",
        type=Path,
        help="Use an existing pinned source archive instead of the packaged copy",
    )
    parser.add_argument(
        "--verify-reproducible",
        action="store_true",
        help="Build twice in isolated directories and require identical output",
    )
    return parser.parse_args()


def resolve_build_layout() -> tuple[Path, Path, Path, Path]:
    """Resolves source-tree or distributed relink-material paths."""
    source_repository_root = SCRIPT_DIRECTORY.parents[1]
    source_script_path = (
        source_repository_root / "scripts" / "webgpu" / "build_dts_decoder.py"
    )
    if source_script_path.resolve() == Path(__file__).resolve():
        return (
            source_repository_root,
            source_repository_root / "scripts" / "webgpu" / "dts" / "libdcadec_bridge.c",
            source_repository_root / "src" / "lib" / "libdcadec",
            source_repository_root / "scripts" / "webgpu" / "dts" / "artifacts",
        )
    return (
        SCRIPT_DIRECTORY,
        SCRIPT_DIRECTORY / "libdcadec_bridge.c",
        SCRIPT_DIRECTORY / "relinked",
        SCRIPT_DIRECTORY,
    )


def main() -> int:
    arguments = parse_arguments()
    (
        repository_root,
        bridge_path,
        runtime_output_directory,
        artifact_output_directory,
    ) = resolve_build_layout()
    artifact_output_directory.mkdir(parents=True, exist_ok=True)
    archive_path = select_source_archive(arguments.source_archive, repository_root)

    compiler_path = find_emscripten_compiler(arguments.emcc, repository_root)
    require_emscripten_version(compiler_path)
    with tempfile.TemporaryDirectory(
        prefix="jellyfin-libdcadec-release-"
    ) as temporary_directory:
        temporary_root = Path(temporary_directory)
        source_root = extract_source_archive(archive_path, temporary_root / "first")
        first_runtime_module = temporary_root / "first-output" / "libdcadec.mjs"
        build_decoder(
            compiler_path,
            repository_root,
            bridge_path,
            source_root,
            first_runtime_module,
        )
        if arguments.verify_reproducible:
            second_source_root = extract_source_archive(
                archive_path,
                temporary_root / "second",
            )
            second_runtime_module = temporary_root / "second-output" / "libdcadec.mjs"
            build_decoder(
                compiler_path,
                repository_root,
                bridge_path,
                second_source_root,
                second_runtime_module,
            )
            if sha256_file(first_runtime_module) != sha256_file(second_runtime_module):
                raise RuntimeError("The isolated libdcadec rebuild was not reproducible")

        runtime_output_directory.mkdir(parents=True, exist_ok=True)
        copy_if_different(
            first_runtime_module,
            runtime_output_directory / "libdcadec.mjs",
        )
        copy_if_different(
            source_root / "COPYING.LGPLv2.1",
            artifact_output_directory / "COPYING.LGPLv2.1",
        )

    artifact_archive_path = artifact_output_directory / "libdcadec-source.tar.gz"
    copy_if_different(archive_path, artifact_archive_path)
    runtime_module_path = runtime_output_directory / "libdcadec.mjs"
    reproducibility_status = (
        "verified" if arguments.verify_reproducible else "not requested"
    )
    (artifact_output_directory / "REVISION").write_text(
        f"libdcadec commit: {LIBDCADEC_COMMIT}\n"
        f"libdcadec source SHA-256: {LIBDCADEC_SOURCE_SHA256}\n"
        f"Emscripten: {EMSCRIPTEN_VERSION}\n"
        f"Emscripten revision: {EMSCRIPTEN_REVISION}\n"
        f"Bridge SHA-256: {sha256_file(bridge_path)}\n"
        f"Runtime module SHA-256: {sha256_file(runtime_module_path)}\n"
        f"Isolated reproducible rebuild: {reproducibility_status}\n",
        encoding="ascii",
        newline="\n",
    )
    print(f"Built libdcadec {LIBDCADEC_COMMIT} with Emscripten {EMSCRIPTEN_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
