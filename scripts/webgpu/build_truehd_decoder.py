#!/usr/bin/env python3
"""Build a pinned, TrueHD/MLP-only FFmpeg decoder as WebAssembly."""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

from pinned_ffmpeg_build import (
    EMSCRIPTEN_VERSION,
    EMSCRIPTEN_REVISION,
    FFMPEG_COMMIT,
    FFMPEG_SOURCE_SHA256,
    copy_if_different,
    extract_source_archive,
    find_bash,
    find_emscripten_compiler,
    get_emscripten_tool,
    positive_jobs,
    require_emscripten_version,
    require_ffmpeg_configuration,
    run_bash,
    select_source_archive,
    sha256_file,
)


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
EXPORTED_FUNCTIONS = (
    "_malloc",
    "_free",
    "_jellyfin_truehd_create",
    "_jellyfin_truehd_configure_packet",
    "_jellyfin_truehd_send_packet",
    "_jellyfin_truehd_receive_frame",
    "_jellyfin_truehd_get_interleaved_data",
    "_jellyfin_truehd_get_sample_format",
    "_jellyfin_truehd_get_bytes_per_sample",
    "_jellyfin_truehd_get_sample_count",
    "_jellyfin_truehd_get_channel_count",
    "_jellyfin_truehd_get_channel_mask",
    "_jellyfin_truehd_get_sample_rate",
    "_jellyfin_truehd_get_bits_per_raw_sample",
    "_jellyfin_truehd_get_profile",
    "_jellyfin_truehd_get_pts",
    "_jellyfin_truehd_clear",
    "_jellyfin_truehd_destroy",
    "_jellyfin_truehd_library_version",
)


def build_ffmpeg(
    bash_path: Path,
    compiler_path: Path,
    source_root: Path,
    repository_root: Path,
    jobs: int,
) -> None:
    """Builds only the pinned FFmpeg libraries needed by TrueHD and MLP."""
    compiler = get_emscripten_tool(compiler_path, "emcc")
    cxx_compiler = get_emscripten_tool(compiler_path, "em++")
    archiver = get_emscripten_tool(compiler_path, "emar.py")
    ranlib = get_emscripten_tool(compiler_path, "emranlib.py")
    host_compiler = compiler_path.parent.parent / "bin" / "clang.exe"
    symbol_reader = compiler_path.parent.parent / "bin" / "llvm-nm.exe"
    if not host_compiler.is_file() or not symbol_reader.is_file():
        raise RuntimeError("The pinned Emscripten SDK native LLVM tools are unavailable")

    prefix_map_flags = (
        f"-ffile-prefix-map={source_root}=ffmpeg-source "
        f"-ffile-prefix-map={repository_root}=jellyfin-web"
    )
    configure_command = [
        "./configure",
        "--target-os=none",
        "--arch=x86_32",
        "--enable-cross-compile",
        "--disable-asm",
        "--disable-x86asm",
        "--disable-inline-asm",
        "--disable-programs",
        "--disable-doc",
        "--disable-debug",
        "--disable-all",
        "--disable-everything",
        "--disable-autodetect",
        "--disable-pthreads",
        "--disable-runtime-cpudetect",
        "--disable-gpl",
        "--disable-iconv",
        "--disable-version3",
        "--disable-nonfree",
        "--enable-avcodec",
        "--enable-decoder=mlp",
        "--enable-decoder=truehd",
        f"--cc={compiler}",
        f"--cxx={cxx_compiler}",
        f"--ar={archiver}",
        f"--ranlib={ranlib}",
        f"--host-cc={host_compiler}",
        f"--nm={symbol_reader}",
        f"--extra-cflags=-DNDEBUG -Oz -flto -msimd128 {prefix_map_flags}",
        "--extra-ldflags=-Oz -flto",
    ]
    run_bash(bash_path, configure_command, source_root, compiler_path)
    require_ffmpeg_configuration(source_root, ("mlp", "truehd"))
    run_bash(
        bash_path,
        ["make", f"-j{jobs}"],
        source_root,
        compiler_path,
    )


def link_decoder(
    bash_path: Path,
    compiler_path: Path,
    repository_root: Path,
    bridge_path: Path,
    source_root: Path,
    output_path: Path,
) -> None:
    """Links the focused FFmpeg libraries and GPL bridge into one module."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    compiler = get_emscripten_tool(compiler_path, "emcc")
    if not bridge_path.is_file():
        raise RuntimeError("The pinned TrueHD/MLP bridge source is unavailable")
    command = [
        str(compiler),
        str(bridge_path),
        str(source_root / "libavcodec" / "libavcodec.a"),
        str(source_root / "libavutil" / "libavutil.a"),
        f"-I{source_root}",
        f"-ffile-prefix-map={source_root}=ffmpeg-source",
        f"-ffile-prefix-map={repository_root}=jellyfin-web",
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
        "-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8','HEAP16','HEAP32']",
        "-msimd128",
        "-flto",
        "-Oz",
        "-Wl,--no-entry",
        "-o",
        str(output_path),
    ]
    run_bash(bash_path, command, repository_root, compiler_path)


def build_runtime_module(
    archive_path: Path,
    build_root: Path,
    bash_path: Path,
    compiler_path: Path,
    repository_root: Path,
    bridge_path: Path,
    jobs: int,
) -> tuple[Path, Path]:
    """Builds one isolated runtime and returns it with its upstream license."""
    source_root = extract_source_archive(archive_path, build_root / "source")
    build_ffmpeg(
        bash_path,
        compiler_path,
        source_root,
        repository_root,
        jobs,
    )
    output_path = build_root / "output" / "ffmpeg-truehd.mjs"
    link_decoder(
        bash_path,
        compiler_path,
        repository_root,
        bridge_path,
        source_root,
        output_path,
    )
    return output_path, source_root / "COPYING.LGPLv2.1"


def parse_arguments() -> argparse.Namespace:
    """Parses focused decoder release-build arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bash", type=Path, help="Path to Git Bash")
    parser.add_argument("--emcc", type=Path, help="Path to the pinned emcc executable")
    parser.add_argument(
        "--source-archive",
        type=Path,
        help="Use an existing pinned source archive instead of the packaged copy",
    )
    parser.add_argument(
        "--jobs",
        type=positive_jobs,
        default=max(1, os.cpu_count() or 1),
        help="Parallel make job count",
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
        source_repository_root / "scripts" / "webgpu" / "build_truehd_decoder.py"
    )
    if source_script_path.resolve() == Path(__file__).resolve():
        return (
            source_repository_root,
            source_repository_root
            / "scripts"
            / "webgpu"
            / "truehd"
            / "ffmpeg_truehd_bridge.c",
            source_repository_root / "src" / "lib" / "ffmpeg-truehd",
            source_repository_root / "scripts" / "webgpu" / "truehd" / "artifacts",
        )
    return (
        SCRIPT_DIRECTORY,
        SCRIPT_DIRECTORY / "ffmpeg_truehd_bridge.c",
        SCRIPT_DIRECTORY / "relinked",
        SCRIPT_DIRECTORY,
    )


def main() -> int:
    """Builds, verifies, and records the focused TrueHD/MLP release artifact."""
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
    bash_path = find_bash(arguments.bash)

    with tempfile.TemporaryDirectory(
        prefix="jellyfin-ffmpeg-truehd-release-"
    ) as temporary_directory:
        temporary_root = Path(temporary_directory)
        first_module, upstream_license = build_runtime_module(
            archive_path,
            temporary_root / "first",
            bash_path,
            compiler_path,
            repository_root,
            bridge_path,
            arguments.jobs,
        )
        if arguments.verify_reproducible:
            second_module, _ = build_runtime_module(
                archive_path,
                temporary_root / "second",
                bash_path,
                compiler_path,
                repository_root,
                bridge_path,
                arguments.jobs,
            )
            if sha256_file(first_module) != sha256_file(second_module):
                raise RuntimeError("The isolated TrueHD/MLP rebuild was not reproducible")

        runtime_output_directory.mkdir(parents=True, exist_ok=True)
        copy_if_different(
            first_module,
            runtime_output_directory / "ffmpeg-truehd.mjs",
        )
        copy_if_different(
            upstream_license,
            artifact_output_directory / "COPYING.LGPLv2.1",
        )

    copy_if_different(
        archive_path,
        artifact_output_directory / "ffmpeg-source.tar.gz",
    )
    runtime_module_path = runtime_output_directory / "ffmpeg-truehd.mjs"
    reproducibility_status = (
        "verified" if arguments.verify_reproducible else "not requested"
    )
    (artifact_output_directory / "REVISION").write_text(
        f"FFmpeg commit: {FFMPEG_COMMIT}\n"
        f"FFmpeg source SHA-256: {FFMPEG_SOURCE_SHA256}\n"
        f"Emscripten: {EMSCRIPTEN_VERSION}\n"
        f"Emscripten revision: {EMSCRIPTEN_REVISION}\n"
        "Configured license: LGPL version 2.1 or later\n"
        f"Bridge SHA-256: {sha256_file(bridge_path)}\n"
        f"Runtime module SHA-256: {sha256_file(runtime_module_path)}\n"
        f"Isolated reproducible rebuild: {reproducibility_status}\n",
        encoding="ascii",
        newline="\n",
    )
    print(
        f"Built FFmpeg {FFMPEG_COMMIT} TrueHD/MLP decoder with "
        f"Emscripten {EMSCRIPTEN_VERSION}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
