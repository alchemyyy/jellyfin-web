"""Tests safe, pinned release-build input handling."""

from __future__ import annotations

import importlib.util
import io
import os
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parents[1]
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import pinned_ffmpeg_build  # noqa: E402


def load_dts_build_module() -> ModuleType:
    """Loads the standalone DTS release script for direct helper tests."""
    module_path = SCRIPT_DIRECTORY / "build_dts_decoder.py"
    specification = importlib.util.spec_from_file_location(
        "webgpu_build_dts_decoder",
        module_path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the DTS build script")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


DTS_BUILD = load_dts_build_module()


def write_tar_member(
    archive: tarfile.TarFile,
    name: str,
    contents: bytes,
) -> None:
    """Writes one deterministic regular-file member."""
    member = tarfile.TarInfo(name)
    member.size = len(contents)
    member.mtime = 0
    archive.addfile(member, io.BytesIO(contents))


class PinnedDecoderBuildTest(unittest.TestCase):
    """Covers release input isolation and path safety."""

    def test_ffmpeg_extraction_rejects_parent_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            archive_path = temporary_root / "unsafe.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                write_tar_member(archive, "../outside", b"unsafe")

            with self.assertRaisesRegex(RuntimeError, "unsafe path"):
                pinned_ffmpeg_build.extract_source_archive(
                    archive_path,
                    temporary_root / "extract",
                )

            self.assertFalse((temporary_root / "outside").exists())

    def test_ffmpeg_extraction_rejects_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            archive_path = temporary_root / "unsafe-link.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                link = tarfile.TarInfo(
                    f"FFmpeg-{pinned_ffmpeg_build.FFMPEG_COMMIT}/link"
                )
                link.type = tarfile.SYMTYPE
                link.linkname = "../outside"
                archive.addfile(link)

            with self.assertRaisesRegex(RuntimeError, "unsafe path"):
                pinned_ffmpeg_build.extract_source_archive(
                    archive_path,
                    temporary_root / "extract",
                )

    def test_ffmpeg_extraction_requires_an_empty_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            destination = temporary_root / "extract"
            destination.mkdir()
            (destination / "stale").write_bytes(b"stale")

            with self.assertRaisesRegex(RuntimeError, "must be empty"):
                pinned_ffmpeg_build.extract_source_archive(
                    temporary_root / "unused.tar.gz",
                    destination,
                )

    def test_atomic_copy_replaces_output_and_accepts_same_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            source = temporary_root / "source"
            destination = temporary_root / "output" / "destination"
            source.write_bytes(b"release")
            destination.parent.mkdir()
            destination.write_bytes(b"stale")

            pinned_ffmpeg_build.copy_if_different(source, destination)
            self.assertEqual(destination.read_bytes(), b"release")
            pinned_ffmpeg_build.copy_if_different(destination, destination)
            self.assertEqual(destination.read_bytes(), b"release")
            self.assertEqual(list(destination.parent.glob(".*.tmp")), [])

    def test_toolchain_validation_requires_exact_revision(self) -> None:
        compiler = Path("emcc.bat")
        accepted_output = (
            "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) "
            f"{pinned_ffmpeg_build.EMSCRIPTEN_VERSION} "
            f"({pinned_ffmpeg_build.EMSCRIPTEN_REVISION})"
        )
        with patch.object(
            pinned_ffmpeg_build.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=accepted_output,
                stderr="",
            ),
        ):
            pinned_ffmpeg_build.require_emscripten_version(compiler)

        rejected_output = accepted_output.replace(
            pinned_ffmpeg_build.EMSCRIPTEN_REVISION,
            "0" * len(pinned_ffmpeg_build.EMSCRIPTEN_REVISION),
        )
        with patch.object(
            pinned_ffmpeg_build.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout=rejected_output,
                stderr="",
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "Expected Emscripten"):
                pinned_ffmpeg_build.require_emscripten_version(compiler)

    def test_build_environments_remove_external_compiler_flags(self) -> None:
        compiler = Path("C:/pinned/emsdk/upstream/emscripten/emcc.bat")
        hostile_environment = {
            "CFLAGS": "-DINJECTED",
            "EMCC_CFLAGS": "-sINJECTED=1",
            "LDFLAGS": "-linjected",
            "MAKEFLAGS": "--eval=unsafe",
        }
        with patch.dict(os.environ, hostile_environment):
            ffmpeg_environment = pinned_ffmpeg_build.create_build_environment(
                compiler
            )
            dts_environment = DTS_BUILD.create_build_environment(compiler)

        for environment in (ffmpeg_environment, dts_environment):
            for variable_name in hostile_environment:
                self.assertNotIn(variable_name, environment)
            self.assertEqual(environment["SOURCE_DATE_EPOCH"], "0")
            self.assertEqual(environment["ZERO_AR_DATE"], "1")
            self.assertEqual(environment["LC_ALL"], "C")

    def test_dts_prefers_the_packaged_pinned_archive(self) -> None:
        packaged_source = (
            REPOSITORY_ROOT
            / "scripts"
            / "webgpu"
            / "dts"
            / "artifacts"
            / "libdcadec-source.tar.gz"
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            packaged_archive = (
                temporary_root
                / "scripts"
                / "webgpu"
                / "dts"
                / "artifacts"
                / "libdcadec-source.tar.gz"
            )
            packaged_archive.parent.mkdir(parents=True)
            shutil.copy2(packaged_source, packaged_archive)

            with patch.object(
                DTS_BUILD,
                "download_source_archive",
                side_effect=AssertionError("cache download must not run"),
            ):
                selected_archive = DTS_BUILD.select_source_archive(
                    None,
                    temporary_root,
                )

            self.assertEqual(selected_archive, packaged_archive.resolve())

    def test_dts_build_scope_uses_only_reviewed_library_sources(self) -> None:
        expected_source_files = (
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
        self.assertEqual(DTS_BUILD.LIBDCADEC_SOURCE_FILES, expected_source_files)

    def test_source_tree_build_layouts_resolve_inside_repository(self) -> None:
        dts_layout = DTS_BUILD.resolve_build_layout()
        self.assertEqual(dts_layout[0], REPOSITORY_ROOT)
        self.assertEqual(
            dts_layout[1],
            REPOSITORY_ROOT
            / "scripts"
            / "webgpu"
            / "dts"
            / "libdcadec_bridge.c",
        )

        truehd_namespace = runpy.run_path(
            str(SCRIPT_DIRECTORY / "build_truehd_decoder.py")
        )
        truehd_layout = truehd_namespace["resolve_build_layout"]()
        self.assertEqual(truehd_layout[0], REPOSITORY_ROOT)
        self.assertEqual(
            truehd_layout[1],
            REPOSITORY_ROOT
            / "scripts"
            / "webgpu"
            / "truehd"
            / "ffmpeg_truehd_bridge.c",
        )

    def test_distributed_build_layouts_use_only_sibling_materials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            for file_name in (
                "build_dts_decoder.py",
                "build_truehd_decoder.py",
                "pinned_ffmpeg_build.py",
            ):
                shutil.copy2(SCRIPT_DIRECTORY / file_name, temporary_root / file_name)
            shutil.copy2(
                SCRIPT_DIRECTORY / "dts" / "libdcadec_bridge.c",
                temporary_root / "libdcadec_bridge.c",
            )
            shutil.copy2(
                SCRIPT_DIRECTORY / "truehd" / "ffmpeg_truehd_bridge.c",
                temporary_root / "ffmpeg_truehd_bridge.c",
            )

            dts_namespace = runpy.run_path(
                str(temporary_root / "build_dts_decoder.py")
            )
            truehd_namespace = runpy.run_path(
                str(temporary_root / "build_truehd_decoder.py")
            )
            for namespace, bridge_name in (
                (dts_namespace, "libdcadec_bridge.c"),
                (truehd_namespace, "ffmpeg_truehd_bridge.c"),
            ):
                layout = namespace["resolve_build_layout"]()
                self.assertEqual(layout[0], temporary_root)
                self.assertEqual(layout[1], temporary_root / bridge_name)
                self.assertEqual(layout[2], temporary_root / "relinked")

            legacy_directory = temporary_root / "legacy-video"
            legacy_directory.mkdir()
            for source_path, file_name in (
                (
                    SCRIPT_DIRECTORY
                    / "legacy-video-decoder"
                    / "build_legacy_video_decoder.py",
                    "build_legacy_video_decoder.py",
                ),
                (SCRIPT_DIRECTORY / "pinned_ffmpeg_build.py", "pinned_ffmpeg_build.py"),
            ):
                shutil.copy2(source_path, legacy_directory / file_name)
            legacy_namespace = runpy.run_path(
                str(legacy_directory / "build_legacy_video_decoder.py")
            )
            self.assertFalse(legacy_namespace["SOURCE_TREE_LAYOUT"])
            self.assertEqual(legacy_namespace["REPOSITORY_ROOT"], legacy_directory)

    def test_dts_extraction_rejects_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            archive_path = temporary_root / "unsafe-link.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                link = tarfile.TarInfo(
                    f"dcadec-{DTS_BUILD.LIBDCADEC_COMMIT}/link"
                )
                link.type = tarfile.LNKTYPE
                link.linkname = "../outside"
                archive.addfile(link)

            with self.assertRaisesRegex(RuntimeError, "unsafe path"):
                DTS_BUILD.extract_source_archive(
                    archive_path,
                    temporary_root / "extract",
                )


if __name__ == "__main__":
    unittest.main()
