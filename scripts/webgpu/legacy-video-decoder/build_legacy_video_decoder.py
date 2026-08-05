#!/usr/bin/env python3
"""Build the pinned progressive MPEG-2 Video and VC-1 decoder as WebAssembly."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
SOURCE_REPOSITORY_ROOT = SCRIPT_DIRECTORY.parents[2]
SOURCE_SCRIPT_PATH = (
    SOURCE_REPOSITORY_ROOT
    / "scripts"
    / "webgpu"
    / "legacy-video-decoder"
    / "build_legacy_video_decoder.py"
)
SOURCE_TREE_LAYOUT = SOURCE_SCRIPT_PATH.resolve() == Path(__file__).resolve()
WEBGPU_SCRIPT_DIRECTORY = (
    SCRIPT_DIRECTORY.parent if SOURCE_TREE_LAYOUT else SCRIPT_DIRECTORY
)
REPOSITORY_ROOT = SOURCE_REPOSITORY_ROOT if SOURCE_TREE_LAYOUT else SCRIPT_DIRECTORY
sys.path.insert(0, str(WEBGPU_SCRIPT_DIRECTORY))

from pinned_ffmpeg_build import (  # noqa: E402
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


ARTIFACT_DIRECTORY = SCRIPT_DIRECTORY / "artifacts"
ENABLED_DECODERS = ("mpeg2video", "vc1")
EXPORTED_FUNCTIONS = (
    "_legacy_video_decoder_create",
    "_legacy_video_decoder_get_extradata",
    "_legacy_video_decoder_open",
    "_legacy_video_decoder_configure_packet",
    "_legacy_video_decoder_send_packet",
    "_legacy_video_decoder_start_drain",
    "_legacy_video_decoder_receive_frame",
    "_legacy_video_decoder_frame_is_i420",
    "_legacy_video_decoder_get_plane",
    "_legacy_video_decoder_get_stride",
    "_legacy_video_decoder_get_width",
    "_legacy_video_decoder_get_height",
    "_legacy_video_decoder_get_crop_left",
    "_legacy_video_decoder_get_crop_top",
    "_legacy_video_decoder_get_crop_right",
    "_legacy_video_decoder_get_crop_bottom",
    "_legacy_video_decoder_get_color_primaries",
    "_legacy_video_decoder_get_color_transfer",
    "_legacy_video_decoder_get_color_matrix",
    "_legacy_video_decoder_get_color_range",
    "_legacy_video_decoder_get_interlaced",
    "_legacy_video_decoder_get_top_field_first",
    "_legacy_video_decoder_get_repeat_picture",
    "_legacy_video_decoder_get_timestamp",
    "_legacy_video_decoder_get_duration",
    "_legacy_video_decoder_error_again",
    "_legacy_video_decoder_error_eof",
    "_legacy_video_decoder_close",
)
CONFIGURED_COMPONENTS = (
    "--disable-all",
    "--disable-everything",
    "--disable-gpl",
    "--disable-version3",
    "--disable-nonfree",
    "--enable-avcodec",
    "--enable-decoder=mpeg2video",
    "--enable-decoder=vc1",
)


def build_ffmpeg(
    bash_path: Path,
    compiler_path: Path,
    source_root: Path,
    jobs: int,
) -> None:
    """Builds only FFmpeg avcodec/avutil with the required legacy decoders."""
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
        f"-ffile-prefix-map={REPOSITORY_ROOT}=jellyfin-web"
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
        *CONFIGURED_COMPONENTS,
        "--disable-autodetect",
        "--disable-pthreads",
        "--disable-runtime-cpudetect",
        "--disable-iconv",
        f"--cc={compiler}",
        f"--cxx={cxx_compiler}",
        f"--ar={archiver}",
        f"--ranlib={ranlib}",
        f"--host-cc={host_compiler}",
        f"--nm={symbol_reader}",
        f"--extra-cflags=-DNDEBUG -O3 -flto {prefix_map_flags}",
        "--extra-ldflags=-O3 -flto",
    ]
    run_bash(bash_path, configure_command, source_root, compiler_path)
    require_ffmpeg_configuration(source_root, ENABLED_DECODERS)
    run_bash(
        bash_path,
        ["make", f"-j{jobs}"],
        source_root,
        compiler_path,
    )


def link_decoder(
    bash_path: Path,
    compiler_path: Path,
    source_root: Path,
    output_path: Path,
) -> None:
    """Links the focused legacy video libraries to the classic-worker bridge."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    compiler = get_emscripten_tool(compiler_path, "emcc")
    exported_functions_json = json.dumps(EXPORTED_FUNCTIONS, separators=(",", ":"))
    command = [
        str(compiler),
        str(SCRIPT_DIRECTORY / "bridge.c"),
        str(source_root / "libavcodec" / "libavcodec.a"),
        str(source_root / "libavutil" / "libavutil.a"),
        f"-I{source_root}",
        f"-ffile-prefix-map={source_root}=ffmpeg-source",
        f"-ffile-prefix-map={REPOSITORY_ROOT}=jellyfin-web",
        "-O3",
        "-flto",
        "-sWASM=1",
        "-sWASM_BIGINT=1",
        "-sFILESYSTEM=0",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sINITIAL_MEMORY=67108864",
        "-sMAXIMUM_MEMORY=536870912",
        "-sSTACK_SIZE=5242880",
        "-sMODULARIZE=1",
        "-sEXPORT_NAME=LegacyVideoDecoderModule",
        "-sENVIRONMENT=worker,node",
        "-sASSERTIONS=0",
        "-sMALLOC=emmalloc",
        f"-sEXPORTED_FUNCTIONS={exported_functions_json}",
        "-sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPU8']",
        "-Wl,--no-entry",
        "-o",
        str(output_path),
    ]
    run_bash(bash_path, command, REPOSITORY_ROOT, compiler_path)


def build_runtime_artifacts(
    archive_path: Path,
    build_root: Path,
    bash_path: Path,
    compiler_path: Path,
    jobs: int,
) -> tuple[Path, Path, Path]:
    """Builds one isolated JS/WASM pair and returns its upstream license."""
    source_root = extract_source_archive(archive_path, build_root / "source")
    build_ffmpeg(bash_path, compiler_path, source_root, jobs)
    output_path = build_root / "output" / "legacy-video-decode.js"
    link_decoder(bash_path, compiler_path, source_root, output_path)
    return output_path, output_path.with_suffix(".wasm"), source_root / "COPYING.LGPLv2.1"


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


def main() -> int:
    """Builds, verifies, and records the focused legacy video artifacts."""
    arguments = parse_arguments()
    archive_path = select_source_archive(arguments.source_archive, REPOSITORY_ROOT)
    compiler_path = find_emscripten_compiler(arguments.emcc, REPOSITORY_ROOT)
    require_emscripten_version(compiler_path)
    bash_path = find_bash(arguments.bash)
    ARTIFACT_DIRECTORY.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="jellyfin-ffmpeg-legacy-video-release-"
    ) as temporary_directory:
        temporary_root = Path(temporary_directory)
        first_js, first_wasm, upstream_license = build_runtime_artifacts(
            archive_path,
            temporary_root / "first",
            bash_path,
            compiler_path,
            arguments.jobs,
        )
        if arguments.verify_reproducible:
            second_js, second_wasm, _ = build_runtime_artifacts(
                archive_path,
                temporary_root / "second",
                bash_path,
                compiler_path,
                arguments.jobs,
            )
            if (
                sha256_file(first_js) != sha256_file(second_js)
                or sha256_file(first_wasm) != sha256_file(second_wasm)
            ):
                raise RuntimeError("The isolated legacy video rebuild was not reproducible")

        output_js = ARTIFACT_DIRECTORY / "legacy-video-decode.js"
        output_wasm = ARTIFACT_DIRECTORY / "legacy-video-decode.wasm"
        copy_if_different(first_js, output_js)
        copy_if_different(first_wasm, output_wasm)
        copy_if_different(
            upstream_license,
            SCRIPT_DIRECTORY / "LICENSE.ffmpeg.txt",
        )

    copy_if_different(
        archive_path,
        ARTIFACT_DIRECTORY / "ffmpeg-source.tar.gz",
    )

    bridge_path = SCRIPT_DIRECTORY / "bridge.c"
    reproducibility_status = (
        "verified" if arguments.verify_reproducible else "not requested"
    )
    (SCRIPT_DIRECTORY / "REVISION").write_text(
        f"FFmpeg commit: {FFMPEG_COMMIT}\n"
        f"FFmpeg source SHA-256: {FFMPEG_SOURCE_SHA256}\n"
        f"Emscripten: {EMSCRIPTEN_VERSION}\n"
        f"Emscripten revision: {EMSCRIPTEN_REVISION}\n"
        "Configured license: LGPL version 2.1 or later\n"
        f"Bridge SHA-256: {sha256_file(bridge_path)}\n"
        f"Isolated reproducible rebuild: {reproducibility_status}\n",
        encoding="ascii",
        newline="\n",
    )
    manifest = {
        "artifacts": {
            "legacy-video-decode.js": sha256_file(output_js),
            "legacy-video-decode.wasm": sha256_file(output_wasm),
        },
        "bridgeSHA256": sha256_file(bridge_path),
        "configuredComponents": list(CONFIGURED_COMPONENTS),
        "decoders": list(ENABLED_DECODERS),
        "emscripten": EMSCRIPTEN_VERSION,
        "emscriptenRevision": EMSCRIPTEN_REVISION,
        "ffmpegRevision": FFMPEG_COMMIT,
        "ffmpegSourceSHA256": FFMPEG_SOURCE_SHA256,
        "license": "LGPL version 2.1 or later",
        "reproducibleBuild": arguments.verify_reproducible,
    }
    (ARTIFACT_DIRECTORY / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="ascii",
        newline="\n",
    )
    print(
        f"Built FFmpeg {FFMPEG_COMMIT} MPEG-2 Video and VC-1 decoders with "
        f"Emscripten {EMSCRIPTEN_VERSION}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
