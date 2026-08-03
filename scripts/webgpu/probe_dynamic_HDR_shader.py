"""Launches isolated Chromium and delegates the HDR10+ WGSL probe to Node."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Sequence


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parent.parent
BROWSER_PROBE_PATH = SCRIPT_DIRECTORY / "probe-dynamic-HDR-shader-browser.mjs"
DEFAULT_TIMEOUT_SECONDS = 60
WINDOWS_CHROME_CANDIDATES = (
    Path(os.environ.get("PROGRAMFILES", "C:/Program Files"))
    / "Google/Chrome/Application/chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)"))
    / "Microsoft/Edge/Application/msedge.exe",
    Path(os.environ.get("PROGRAMFILES", "C:/Program Files"))
    / "Microsoft/Edge/Application/msedge.exe",
)


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the standalone probe CLI."""

    parser = argparse.ArgumentParser(
        description="Compile the production dynamic-HDR WGSL in headless Chromium."
    )
    parser.add_argument("--chrome", help="Chrome or Edge executable path")
    parser.add_argument("--output", help="Optional JSON report destination")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
    )
    return parser


def resolve_chromium(argument: str | None) -> Path:
    """Resolves an explicit browser or a known Windows installation."""

    if argument:
        explicit_path = Path(argument).expanduser().resolve()
        if explicit_path.is_file():
            return explicit_path
        raise FileNotFoundError(f"Chromium executable does not exist: {explicit_path}")
    for candidate in WINDOWS_CHROME_CANDIDATES:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("Chrome or Edge was not found")


def wait_for_debugging_port(profile_directory: Path, timeout_seconds: int) -> int:
    """Waits for Chromium's exact ephemeral debugging port record."""

    active_port_path = profile_directory / "DevToolsActivePort"
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            first_line = active_port_path.read_text(encoding="utf-8").splitlines()[0]
            port = int(first_line)
            if 1 <= port <= 65_535:
                return port
        except (FileNotFoundError, IndexError, ValueError):
            time.sleep(0.05)
    raise TimeoutError("Chromium did not expose its debugging port")


def run_probe(
    chromium_path: Path,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    """Owns one isolated browser process and one bounded Node probe."""

    with tempfile.TemporaryDirectory(prefix="webgpu-hdr10plus-probe-") as profile:
        profile_directory = Path(profile)
        browser_command = [
            str(chromium_path),
            "--disable-background-networking",
            "--enable-unsafe-webgpu",
            "--headless=new",
            "--no-default-browser-check",
            "--no-first-run",
            "--remote-debugging-port=0",
            f"--user-data-dir={profile_directory}",
            "about:blank",
        ]
        browser_process = subprocess.Popen(
            browser_command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            debugging_port = wait_for_debugging_port(
                profile_directory,
                timeout_seconds,
            )
            return subprocess.run(
                [
                    "node",
                    str(BROWSER_PROBE_PATH),
                    f"http://localhost:{debugging_port}",
                ],
                cwd=REPOSITORY_ROOT,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout_seconds,
            )
        finally:
            browser_process.terminate()
            try:
                browser_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser_process.kill()
                browser_process.wait(timeout=5)


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Runs the probe and optionally persists its JSON result."""

    arguments = create_argument_parser().parse_args(command_arguments)
    if arguments.timeout_seconds < 1:
        raise ValueError("The timeout must be positive")
    completed_command = run_probe(
        resolve_chromium(arguments.chrome),
        arguments.timeout_seconds,
    )
    if completed_command.returncode != 0:
        raise RuntimeError(
            "The browser shader probe failed:\n"
            f"{completed_command.stdout}\n{completed_command.stderr}"
        )
    report = json.loads(completed_command.stdout)
    output = json.dumps(report, indent=2, sort_keys=True)
    print(output)
    if arguments.output:
        output_path = Path(arguments.output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(f"{output}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
