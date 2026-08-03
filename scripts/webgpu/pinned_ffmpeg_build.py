"""Shared pinned-source and toolchain helpers for focused FFmpeg WASM builds."""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


FFMPEG_COMMIT = "a59498db085e3d635532397128550141ab87408a"
FFMPEG_SOURCE_SHA256 = (
    "fff68fd0b5061b1befba1cd9fc95357d9fc85eb3201bfed597c70d5f8033567e"
)
FFMPEG_SOURCE_URL = (
    "https://github.com/FFmpeg/FFmpeg/archive/"
    f"{FFMPEG_COMMIT}.tar.gz"
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


def sha256_file(path: Path) -> str:
    """Returns the lowercase SHA-256 digest for a file."""
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_sha256(path: Path, expected_sha256: str) -> None:
    """Rejects a file unless it matches the pinned SHA-256 digest."""
    actual_sha256 = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"SHA-256 mismatch for {path}: expected {expected_sha256}, "
            f"received {actual_sha256}"
        )


def download_source_archive(destination: Path) -> None:
    """Downloads the pinned FFmpeg archive when it is not already cached."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        require_sha256(destination, FFMPEG_SOURCE_SHA256)
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
            with urllib.request.urlopen(FFMPEG_SOURCE_URL) as response:
                shutil.copyfileobj(response, temporary_file)
        require_sha256(temporary_path, FFMPEG_SOURCE_SHA256)
        temporary_path.replace(destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    require_sha256(destination, FFMPEG_SOURCE_SHA256)


def select_source_archive(
    requested_archive: Path | None,
    repository_root: Path,
) -> Path:
    """Selects an explicit, packaged, or downloaded pinned FFmpeg archive."""
    if requested_archive is not None:
        archive_path = requested_archive.resolve()
        require_sha256(archive_path, FFMPEG_SOURCE_SHA256)
        return archive_path

    standalone_archive = repository_root / "ffmpeg-source.tar.gz"
    if standalone_archive.is_file():
        require_sha256(standalone_archive, FFMPEG_SOURCE_SHA256)
        return standalone_archive.resolve()

    packaged_archive = (
        repository_root
        / "scripts"
        / "webgpu"
        / "truehd"
        / "artifacts"
        / "ffmpeg-source.tar.gz"
    )
    if packaged_archive.is_file():
        require_sha256(packaged_archive, FFMPEG_SOURCE_SHA256)
        return packaged_archive.resolve()

    cached_archive = (
        repository_root / ".cache" / "webgpu-ffmpeg" / "ffmpeg-source.tar.gz"
    )
    download_source_archive(cached_archive)
    return cached_archive.resolve()


def extract_source_archive(archive_path: Path, destination: Path) -> Path:
    """Safely extracts the pinned archive and returns its source directory."""
    if destination.exists() and any(destination.iterdir()):
        raise RuntimeError("FFmpeg extraction destination must be empty")
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
                raise RuntimeError("FFmpeg source archive contains an unsafe path")
        archive.extractall(destination, members=members, filter="data")

    expected_source_directory = destination / f"FFmpeg-{FFMPEG_COMMIT}"
    source_directories = [
        candidate
        for candidate in destination.iterdir()
        if candidate.is_dir()
    ]
    if source_directories != [expected_source_directory]:
        raise RuntimeError("Unable to locate the extracted FFmpeg source")
    return expected_source_directory


def find_emscripten_compiler(
    explicit_path: Path | None,
    repository_root: Path,
) -> Path:
    """Finds the Emscripten compiler launcher used for version validation."""
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
    """Rejects any Emscripten compiler other than the pinned release."""
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
            f"({EMSCRIPTEN_REVISION}), received:\n"
            f"{version_output.strip()}"
        )


def find_bash(explicit_path: Path | None) -> Path:
    """Finds Git Bash for the FFmpeg configure and make steps."""
    candidates: list[Path] = []
    if explicit_path is not None:
        candidates.append(explicit_path)
    command_path = shutil.which("bash")
    if command_path:
        candidates.append(Path(command_path))
    candidates.extend(
        (
            Path("C:/Program Files/Git/bin/bash.exe"),
            Path("C:/Program Files/Git/usr/bin/bash.exe"),
        )
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError("Git Bash is required to configure the pinned FFmpeg build")


def get_emscripten_tool(compiler_path: Path, tool_name: str) -> Path:
    """Returns a Bash-callable tool from the validated Emscripten directory."""
    tool_path = compiler_path.parent / tool_name
    if tool_path.is_file():
        return tool_path
    batch_path = compiler_path.parent / f"{tool_name}.bat"
    if batch_path.is_file():
        return batch_path
    raise RuntimeError(f"The pinned Emscripten tool is unavailable: {tool_name}")


def create_build_environment(compiler_path: Path) -> dict[str, str]:
    """Creates the normalized environment shared by focused release builds."""
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


def run_bash(
    bash_path: Path,
    command: list[str],
    working_directory: Path,
    compiler_path: Path,
) -> None:
    """Runs one quoted command through Git Bash with deterministic inputs."""
    shell_command = " ".join(
        shlex.quote(argument.replace("\\", "/")) for argument in command
    )
    subprocess.run(
        [str(bash_path), "-lc", shell_command],
        check=True,
        cwd=working_directory,
        env=create_build_environment(compiler_path),
    )


def require_ffmpeg_configuration(
    source_root: Path,
    expected_decoders: tuple[str, ...],
) -> None:
    """Rejects a configured FFmpeg tree outside the exact LGPL decoder scope."""
    configuration = (source_root / "config.h").read_text(
        encoding="utf8",
        errors="strict",
    )
    component_configuration = (source_root / "config_components.h").read_text(
        encoding="utf8",
        errors="strict",
    )
    required_markers = (
        "#define CONFIG_AVCODEC 1",
        "#define CONFIG_GPL 0",
        "#define CONFIG_NONFREE 0",
        "#define CONFIG_VERSION3 0",
    )
    for marker in required_markers:
        if marker not in configuration:
            raise RuntimeError(f"FFmpeg configuration is missing {marker}")

    enabled_decoders = {
        match.group(1).lower()
        for match in re.finditer(
            r"^#define CONFIG_([A-Z0-9_]+)_DECODER 1$",
            component_configuration,
            flags=re.MULTILINE,
        )
    }
    expected_decoder_set = {decoder.lower() for decoder in expected_decoders}
    if enabled_decoders != expected_decoder_set:
        raise RuntimeError(
            "FFmpeg enabled decoder set differs from the pinned scope: "
            f"expected {sorted(expected_decoder_set)}, "
            f"received {sorted(enabled_decoders)}"
        )


def copy_if_different(source: Path, destination: Path) -> None:
    """Atomically copies an input unless source and destination are the same file."""
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


def positive_jobs(value: str) -> int:
    """Parses a positive parallel build job count."""
    jobs = int(value)
    if jobs < 1:
        raise ValueError("Build jobs must be a positive integer")
    return jobs
