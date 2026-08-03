"""Runs a deterministic WebGPU-versus-mpv playback comparison."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Sequence, cast

from ab_harness import (
    CompletedCommand,
    ExecutableResolution,
    HarnessError,
    analyze_float32_pcm,
    command_for_report,
    format_media_seconds,
    normalize_manifest,
    parse_psnr_output,
    parse_ssim_output,
    read_json,
    require_mapping,
    resolve_executable,
    run_checked,
    write_json,
)


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIRECTORY.parent.parent
DEFAULT_ARTIFACT_ROOT = REPOSITORY_ROOT / "artifacts" / "webgpu-mpv-ab"
DEFAULT_JELLYFIN_DIRECTORY = REPOSITORY_ROOT.parent / "jellyfin-12.0-nightly-windows"
DEFAULT_FFMPEG_PATH = DEFAULT_JELLYFIN_DIRECTORY / "ffmpeg.exe"
MPV_CAPTURE_SCRIPT = SCRIPT_DIRECTORY / "mpv_reference_capture.lua"
BROWSER_CAPTURE_SCRIPT = SCRIPT_DIRECTORY / "run-browser-reference-capture.mjs"
BROWSER_CLEANUP_SCRIPT = SCRIPT_DIRECTORY / "cleanup-browser-reference-capture.mjs"
ALL_STAGES = ("browser", "mpv", "audio", "compare")
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_BROWSER_PHASE_TIMEOUT_SECONDS = 60
DEFAULT_SETTLE_MILLISECONDS = 400
MAXIMUM_FRAME_ALIGNMENT_DELTA_MICROSECONDS = 2_000
MINIMUM_MPV_PACING_TOLERANCE_MICROSECONDS = 250_000
MPV_PACING_TOLERANCE_FRACTION = 0.05
NULL_OUTPUT_PATH = "NUL" if os.name == "nt" else "/dev/null"


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates the command-line contract without embedding local secrets."""

    parser = argparse.ArgumentParser(
        description="Capture WebGPU and mpv reference playback into one local report."
    )
    parser.add_argument("--manifest", required=True, help="Versioned A/B case JSON")
    parser.add_argument("--source", help="Local media file used by mpv")
    parser.add_argument("--output", help="Artifact directory; defaults to a timestamped run")
    parser.add_argument(
        "--stages",
        default=",".join(ALL_STAGES),
        help="Comma-separated browser,mpv,audio,compare stages",
    )
    parser.add_argument("--node", help="Node executable path")
    parser.add_argument("--mpv", help="mpv executable path")
    parser.add_argument(
        "--ffmpeg",
        help="FFmpeg executable path; defaults to the sibling Jellyfin 12 nightly",
    )
    parser.add_argument(
        "--browser-phase-timeout-seconds",
        type=int,
        default=DEFAULT_BROWSER_PHASE_TIMEOUT_SECONDS,
        help="Bound for each browser wait phase",
    )
    parser.add_argument(
        "--debug-url",
        default=os.environ.get("WEBGPU_AB_DEBUG_URL", "http://localhost:9224"),
    )
    parser.add_argument(
        "--frontend-url",
        default=os.environ.get("WEBGPU_AB_FRONTEND_URL", "http://localhost:8096/web/"),
    )
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WEBGPU_AB_SERVER_URL", "http://localhost:8096"),
    )
    parser.add_argument("--username", default=os.environ.get("WEBGPU_AB_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("WEBGPU_AB_PASSWORD"))
    parser.add_argument(
        "--gpu-api",
        choices=("d3d11", "opengl", "vulkan"),
        default="d3d11",
        help="Explicit mpv GPU API",
    )
    parser.add_argument(
        "--settle-ms",
        type=int,
        default=DEFAULT_SETTLE_MILLISECONDS,
        help="Paused-frame settle time before each mpv screenshot",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Bound for each external command",
    )
    return parser


def parse_stages(value: str) -> tuple[str, ...]:
    """Normalizes a stage list and rejects silent misspellings."""

    stages: list[str] = []
    for raw_stage in value.split(","):
        stage = raw_stage.strip().lower()
        if not stage:
            continue
        if stage not in ALL_STAGES:
            raise HarnessError(f"Unsupported stage: {stage}")
        if stage not in stages:
            stages.append(stage)
    if not stages:
        raise HarnessError("At least one harness stage is required")
    return tuple(stages)


def create_output_directory(argument: str | None, case_identifier: str) -> Path:
    """Returns an explicit path or a collision-resistant default run directory."""

    if argument:
        return Path(argument).expanduser().resolve()
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return (DEFAULT_ARTIFACT_ROOT / f"{case_identifier}-{timestamp}").resolve()


def require_source_path(argument: str | None) -> Path:
    """Resolves the exact local media input without recording it in tracked data."""

    if not argument:
        raise HarnessError("The mpv and audio stages require --source")
    source_path = Path(argument).expanduser().resolve()
    if not source_path.is_file():
        raise HarnessError(f"Media source does not exist: {source_path}")
    return source_path


def executable_record(resolution: ExecutableResolution) -> dict[str, object]:
    """Serializes executable provenance for the ignored local run report."""

    return {
        "path": str(resolution.path),
        "resolutionSource": resolution.source,
        "version": resolution.version,
    }


def sanitize_text(value: str, replacements: Mapping[str, str]) -> str:
    """Applies the same exact replacements used for reported argument vectors."""

    return command_for_report([value], replacements)[0]


def command_record(
    command: CompletedCommand,
    replacements: Mapping[str, str],
) -> dict[str, object]:
    """Creates a bounded, redacted command record."""

    return {
        "arguments": command_for_report(command.arguments, replacements),
        "returnCode": command.return_code,
        "standardErrorTail": sanitize_text(
            "\n".join(command.standard_error.splitlines()[-40:]),
            replacements,
        ),
        "standardOutputTail": sanitize_text(
            "\n".join(command.standard_output.splitlines()[-40:]),
            replacements,
        ),
    }


def create_report_replacements(
    source_path: Path | None,
    username: str | None,
    password: str | None,
) -> dict[str, str]:
    """Creates unambiguous report redactions for paths and credentials."""

    replacements: dict[str, str] = {}
    if source_path:
        replacements[str(source_path)] = "<MEDIA_SOURCE>"
    if username and password and username == password:
        replacements[username] = "<JELLYFIN_CREDENTIAL>"
        return replacements
    if username:
        replacements[username] = "<USERNAME>"
    if password:
        replacements[password] = "<PASSWORD>"
    return replacements


def relative_path(path: Path, output_directory: Path) -> str:
    """Returns a report path relative to the self-contained artifact directory."""

    return path.resolve().relative_to(output_directory.resolve()).as_posix()


def run_browser_capture(
    *,
    arguments: argparse.Namespace,
    node: ExecutableResolution,
    normalized_plan_path: Path,
    output_directory: Path,
    replacements: Mapping[str, str],
) -> dict[str, object]:
    """Invokes the reusable CDP browser capture runner."""

    if not arguments.username or not arguments.password:
        raise HarnessError(
            "The browser stage requires --username/--password or WEBGPU_AB credentials"
        )
    browser_directory = output_directory / "browser"
    browser_directory.mkdir(parents=True, exist_ok=True)
    command_arguments = [
        str(node.path),
        str(BROWSER_CAPTURE_SCRIPT),
        "--plan",
        str(normalized_plan_path),
        "--output-directory",
        str(browser_directory),
        "--debug-url",
        arguments.debug_url,
        "--frontend-url",
        arguments.frontend_url,
        "--server-url",
        arguments.server_url,
        "--username",
        arguments.username,
        "--password",
        arguments.password,
        "--timeout-ms",
        str(arguments.browser_phase_timeout_seconds * 1_000),
    ]
    try:
        completed_command = run_checked(
            command_arguments,
            working_directory=REPOSITORY_ROOT,
            timeout_seconds=arguments.timeout_seconds,
        )
    except HarnessError as capture_error:
        cleanup_arguments = [
            str(node.path),
            str(BROWSER_CLEANUP_SCRIPT),
            "--debug-url",
            arguments.debug_url,
            "--frontend-url",
            arguments.frontend_url,
            "--timeout-ms",
            "15000",
        ]
        try:
            run_checked(
                cleanup_arguments,
                working_directory=REPOSITORY_ROOT,
                timeout_seconds=30,
            )
        except HarnessError as cleanup_error:
            raise HarnessError(
                f"{capture_error}\nBrowser reference cleanup also failed: {cleanup_error}"
            ) from capture_error
        raise
    report_path = browser_directory / "browser-report.json"
    report = require_mapping(read_json(report_path), "Browser report")
    if report.get("status") != "captured":
        raise HarnessError("Browser capture report did not finish in the captured state")
    return {
        "command": command_record(completed_command, replacements),
        "report": relative_path(report_path, output_directory),
        "visualCaptureCount": len(cast(list[object], report.get("visualCaptures", []))),
    }


def create_mpv_capture_plan(
    *,
    manifest: dict[str, object],
    profile: dict[str, object],
    profile_directory: Path,
    settle_milliseconds: int,
) -> dict[str, object]:
    """Builds the minimal safe plan consumed by the checked-in Lua script."""

    visual = require_mapping(manifest["visual"], "Manifest visual")
    pacing = require_mapping(manifest["pacing"], "Manifest pacing")
    timestamps = cast(list[int], visual["timestampsMicroseconds"])
    case_identifier = cast(str, manifest["caseId"])
    profile_identifier = cast(str, profile["id"])
    captures: list[dict[str, object]] = []
    for timestamp_microseconds in timestamps:
        filename = (
            f"{case_identifier}-mpv-{profile_identifier}-{timestamp_microseconds}.png"
        )
        captures.append(
            {
                "filename": filename,
                "outputPath": str((profile_directory / filename).resolve()),
                "requestedMediaTimeMicroseconds": timestamp_microseconds,
            }
        )
    return {
        "captureToleranceMicroseconds": visual["captureToleranceMicroseconds"],
        "captures": captures,
        "caseId": case_identifier,
        "pacing": dict(pacing),
        "profile": dict(profile),
        "schemaVersion": 1,
        "settleMilliseconds": settle_milliseconds,
    }


def create_mpv_visual_arguments(
    *,
    arguments: argparse.Namespace,
    audio: dict[str, object],
    manifest: dict[str, object],
    mpv: ExecutableResolution,
    profile: dict[str, object],
    profile_directory: Path,
    source_path: Path,
) -> list[str]:
    """Creates an argument vector for a fixed SDR-target mpv reference render."""

    visual = require_mapping(manifest["visual"], "Manifest visual")
    output_peak_nits = cast(float, visual["outputPeakNits"])
    output_peak_text = f"{output_peak_nits:g}"
    profile_identifier = cast(str, profile["id"])
    log_path = profile_directory / f"mpv-{profile_identifier}.log"
    return [
        str(mpv.path),
        "--no-config",
        "--input-default-bindings=no",
        "--input-cursor=no",
        "--input-vo-keyboard=no",
        "--osc=no",
        "--osd-level=0",
        "--osd-bar=no",
        "--sub=no",
        "--pause=yes",
        "--keep-open=no",
        "--force-window=immediate",
        "--border=no",
        f"--geometry={visual['width']}x{visual['height']}",
        "--keepaspect=yes",
        "--vo=gpu-next",
        f"--gpu-api={arguments.gpu_api}",
        "--hwdec=auto",
        "--video-sync=audio",
        "--target-colorspace-hint=no",
        "--target-prim=bt.709",
        "--target-trc=srgb",
        f"--target-peak={output_peak_text}",
        f"--tone-mapping={profile['toneMapping']}",
        f"--gamut-mapping-mode={profile['gamutMapping']}",
        f"--hdr-compute-peak={'yes' if profile['hdrComputePeak'] else 'no'}",
        "--screenshot-sw=no",
        "--screenshot-high-bit-depth=no",
        "--screenshot-tag-colorspace=no",
        "--ao=null",
        f"--aid={audio['mpvAudioTrack']}",
        f"--audio-channels={audio['channelLayout']}",
        f"--audio-samplerate={audio['sampleRate']}",
        "--audio-normalize-downmix=no",
        "--audio-pitch-correction=no",
        "--replaygain=no",
        "--volume=100",
        "--mute=no",
        "--msg-level=all=warn",
        f"--log-file={log_path}",
        f"--script={MPV_CAPTURE_SCRIPT}",
        str(source_path),
    ]


def read_counter_delta(
    before: dict[str, object],
    after: dict[str, object],
    key: str,
) -> int | None:
    """Returns a non-negative cumulative counter delta when both values exist."""

    before_value = before.get(key)
    after_value = after.get(key)
    if (
        isinstance(before_value, bool)
        or not isinstance(before_value, int)
        or isinstance(after_value, bool)
        or not isinstance(after_value, int)
    ):
        return None
    return max(0, after_value - before_value)


def summarize_mpv_pacing(report: dict[str, object]) -> dict[str, object]:
    """Rejects reference pacing that did not advance close to real time."""

    pacing = require_mapping(report.get("pacing"), "mpv pacing")
    before = require_mapping(pacing.get("before"), "mpv pacing before")
    after = require_mapping(pacing.get("after"), "mpv pacing after")
    before_media_time = before.get("mediaTimeMicroseconds")
    after_media_time = after.get("mediaTimeMicroseconds")
    wall_duration = pacing.get("observedWallDurationMicroseconds")
    if (
        isinstance(before_media_time, bool)
        or not isinstance(before_media_time, int)
        or isinstance(after_media_time, bool)
        or not isinstance(after_media_time, int)
        or isinstance(wall_duration, bool)
        or not isinstance(wall_duration, int)
        or wall_duration <= 0
    ):
        raise HarnessError("mpv pacing report has invalid media or wall timestamps")

    media_duration = after_media_time - before_media_time
    clock_error = media_duration - wall_duration
    timing_tolerance = max(
        MINIMUM_MPV_PACING_TOLERANCE_MICROSECONDS,
        round(wall_duration * MPV_PACING_TOLERANCE_FRACTION),
    )
    counter_deltas = {
        key: read_counter_delta(before, after, key)
        for key in (
            "decoderFrameDropCount",
            "delayedFrameCount",
            "frameDropCount",
            "mistimedFrameCount",
        )
    }
    failure_reasons: list[str] = []
    if media_duration <= 0:
        failure_reasons.append("media-time-did-not-advance")
    elif abs(clock_error) > timing_tolerance:
        failure_reasons.append("media-clock-diverged-from-wall-clock")
    if counter_deltas["decoderFrameDropCount"] not in {None, 0}:
        failure_reasons.append("decoder-frames-dropped")
    if counter_deltas["frameDropCount"] not in {None, 0}:
        failure_reasons.append("display-frames-dropped")
    if counter_deltas["mistimedFrameCount"] not in {None, 0}:
        failure_reasons.append("frames-mistimed")
    if after.get("pausedForCache") is True:
        failure_reasons.append("paused-for-cache")

    return {
        "clockErrorMicroseconds": clock_error,
        "counterDeltas": counter_deltas,
        "failureReasons": failure_reasons,
        "hardwareDecoder": after.get("hwdecCurrent"),
        "mediaDurationMicroseconds": media_duration,
        "status": "valid" if len(failure_reasons) == 0 else "invalid",
        "timingToleranceMicroseconds": timing_tolerance,
        "wallDurationMicroseconds": wall_duration,
    }


def run_mpv_visual_capture(
    *,
    arguments: argparse.Namespace,
    manifest: dict[str, object],
    mpv: ExecutableResolution,
    output_directory: Path,
    replacements: Mapping[str, str],
    source_path: Path,
) -> list[dict[str, object]]:
    """Captures every mpv tone-mapping profile and its live pacing counters."""

    audio = require_mapping(manifest["audio"], "Manifest audio")
    profile_values = cast(list[object], manifest["mpvProfiles"])
    results: list[dict[str, object]] = []
    for profile_value in profile_values:
        profile = require_mapping(profile_value, "mpv profile")
        profile_identifier = cast(str, profile["id"])
        profile_directory = output_directory / "mpv" / profile_identifier
        profile_directory.mkdir(parents=True, exist_ok=True)
        capture_plan = create_mpv_capture_plan(
            manifest=manifest,
            profile=profile,
            profile_directory=profile_directory,
            settle_milliseconds=arguments.settle_ms,
        )
        capture_plan_path = profile_directory / "capture-plan.json"
        report_path = profile_directory / "mpv-report.json"
        write_json(capture_plan_path, capture_plan)
        command_arguments = create_mpv_visual_arguments(
            arguments=arguments,
            audio=audio,
            manifest=manifest,
            mpv=mpv,
            profile=profile,
            profile_directory=profile_directory,
            source_path=source_path,
        )
        command_environment = {
            "WEBGPU_MPV_CAPTURE_PLAN": str(capture_plan_path.resolve()),
            "WEBGPU_MPV_CAPTURE_REPORT": str(report_path.resolve()),
        }
        completed_command = run_checked(
            command_arguments,
            working_directory=REPOSITORY_ROOT,
            environment=command_environment,
            timeout_seconds=arguments.timeout_seconds,
        )
        report = require_mapping(read_json(report_path), "mpv report")
        if report.get("status") != "captured":
            raise HarnessError(f"mpv profile {profile_identifier} did not finish capture")
        pacing_summary = summarize_mpv_pacing(report)
        report["pacingSummary"] = pacing_summary
        report["command"] = command_record(completed_command, replacements)
        report["capturePlan"] = relative_path(capture_plan_path, output_directory)
        write_json(report_path, report)
        if pacing_summary["status"] != "valid":
            failure_reasons = ", ".join(cast(list[str], pacing_summary["failureReasons"]))
            raise HarnessError(
                f"mpv profile {profile_identifier} produced invalid pacing: "
                f"{failure_reasons}"
            )
        results.append(
            {
                "pacing": pacing_summary,
                "profileId": profile_identifier,
                "report": relative_path(report_path, output_directory),
                "visualCaptureCount": len(cast(list[object], report.get("captures", []))),
            }
        )
    return results


def run_mpv_audio_capture(
    *,
    arguments: argparse.Namespace,
    manifest: dict[str, object],
    mpv: ExecutableResolution,
    output_directory: Path,
    replacements: Mapping[str, str],
    source_path: Path,
) -> dict[str, object]:
    """Renders a bounded raw float PCM segment and records amplitude statistics."""

    audio = require_mapping(manifest["audio"], "Manifest audio")
    audio_directory = output_directory / "mpv" / "audio"
    audio_directory.mkdir(parents=True, exist_ok=True)
    pcm_path = audio_directory / "reference-f32le.pcm"
    report_path = audio_directory / "audio-report.json"
    start_microseconds = cast(int, audio["startTimeMicroseconds"])
    duration_microseconds = cast(int, audio["durationMicroseconds"])
    command_arguments = [
        str(mpv.path),
        "--no-config",
        "--input-default-bindings=no",
        "--osc=no",
        "--osd-level=0",
        "--vid=no",
        "--ao=pcm",
        f"--ao-pcm-file={pcm_path}",
        "--ao-pcm-waveheader=no",
        "--audio-format=float",
        f"--audio-channels={audio['channelLayout']}",
        f"--audio-samplerate={audio['sampleRate']}",
        f"--aid={audio['mpvAudioTrack']}",
        "--audio-normalize-downmix=no",
        "--audio-pitch-correction=no",
        "--replaygain=no",
        "--speed=1",
        "--volume=100",
        "--mute=no",
        f"--start={format_media_seconds(start_microseconds)}",
        f"--length={format_media_seconds(duration_microseconds)}",
        "--msg-level=all=warn",
        str(source_path),
    ]
    completed_command = run_checked(
        command_arguments,
        working_directory=REPOSITORY_ROOT,
        timeout_seconds=arguments.timeout_seconds,
    )
    statistics = analyze_float32_pcm(
        pcm_path,
        cast(int, audio["channelCount"]),
        cast(int, audio["sampleRate"]),
    )
    report = {
        "command": command_record(completed_command, replacements),
        "pcm": relative_path(pcm_path, output_directory),
        "schemaVersion": 1,
        "segment": {
            "durationMicroseconds": duration_microseconds,
            "startTimeMicroseconds": start_microseconds,
        },
        "statistics": statistics,
        "status": "captured",
    }
    write_json(report_path, report)
    return {
        "report": relative_path(report_path, output_directory),
        "statistics": statistics,
    }


def run_metric_command(
    *,
    browser_image: Path,
    ffmpeg: ExecutableResolution,
    filter_name: str,
    height: int,
    mpv_image: Path,
    output_directory: Path,
    replacements: Mapping[str, str],
    width: int,
) -> tuple[dict[str, object], CompletedCommand]:
    """Runs one display-referred image metric after deterministic scaling."""

    filter_graph = (
        f"[0:v]scale={width}:{height}:flags=lanczos,format=yuv444p[b];"
        f"[1:v]scale={width}:{height}:flags=lanczos,format=yuv444p[m];"
        f"[b][m]{filter_name}"
    )
    command_arguments = [
        str(ffmpeg.path),
        "-hide_banner",
        "-nostdin",
        "-i",
        str(browser_image),
        "-i",
        str(mpv_image),
        "-filter_complex",
        filter_graph,
        "-frames:v",
        "1",
        "-f",
        "null",
        NULL_OUTPUT_PATH,
    ]
    completed_command = run_checked(
        command_arguments,
        working_directory=output_directory,
        timeout_seconds=60,
    )
    combined_output = f"{completed_command.standard_output}\n{completed_command.standard_error}"
    if filter_name == "ssim":
        metrics: dict[str, object] = parse_ssim_output(combined_output)
    else:
        metrics = parse_psnr_output(combined_output)
    return metrics, completed_command


def create_triptych(
    *,
    browser_image: Path,
    destination: Path,
    ffmpeg: ExecutableResolution,
    height: int,
    mpv_image: Path,
    output_directory: Path,
    width: int,
) -> CompletedCommand:
    """Writes browser, mpv, and absolute display-code difference side by side."""

    filter_graph = (
        f"[0:v]scale={width}:{height}:flags=lanczos,format=gbrp[b];"
        f"[1:v]scale={width}:{height}:flags=lanczos,format=gbrp[m];"
        "[b]split=2[bmain][bdiff];"
        "[m]split=2[mmain][mdiff];"
        "[bdiff][mdiff]blend=all_mode=difference[diff];"
        "[bmain][mmain][diff]hstack=inputs=3[out]"
    )
    command_arguments = [
        str(ffmpeg.path),
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(browser_image),
        "-i",
        str(mpv_image),
        "-filter_complex",
        filter_graph,
        "-map",
        "[out]",
        "-frames:v",
        "1",
        str(destination),
    ]
    return run_checked(
        command_arguments,
        working_directory=output_directory,
        timeout_seconds=60,
    )


def index_captures(report: dict[str, object], label: str) -> dict[int, dict[str, object]]:
    """Indexes capture entries and rejects duplicate timestamp evidence."""

    captures_value = report.get("visualCaptures", report.get("captures"))
    if not isinstance(captures_value, list):
        raise HarnessError(f"{label} does not contain captures")
    captures: dict[int, dict[str, object]] = {}
    for capture_index, capture_value in enumerate(captures_value):
        capture = require_mapping(capture_value, f"{label} capture {capture_index}")
        timestamp_value = capture.get("requestedMediaTimeMicroseconds")
        if isinstance(timestamp_value, bool) or not isinstance(timestamp_value, int):
            raise HarnessError(f"{label} capture {capture_index} has no integer timestamp")
        if timestamp_value in captures:
            raise HarnessError(f"{label} contains a duplicate capture timestamp")
        captures[timestamp_value] = capture
    return captures


def capture_alignment_record(
    browser_capture: dict[str, object],
    mpv_capture: dict[str, object],
    requested_media_time_microseconds: int,
) -> dict[str, int | str]:
    """Requires browser and mpv evidence to represent the same source frame."""

    browser_actual = browser_capture.get("actualMediaTimeMicroseconds")
    mpv_actual = mpv_capture.get("actualMediaTimeMicroseconds")
    if (
        isinstance(browser_actual, bool)
        or not isinstance(browser_actual, int)
        or isinstance(mpv_actual, bool)
        or not isinstance(mpv_actual, int)
    ):
        raise HarnessError("Comparison capture is missing an integer actual timestamp")
    cross_player_delta = browser_actual - mpv_actual
    if abs(cross_player_delta) > MAXIMUM_FRAME_ALIGNMENT_DELTA_MICROSECONDS:
        raise HarnessError(
            "Comparison captures are not frame-aligned at "
            f"{requested_media_time_microseconds} microseconds: browser={browser_actual}, "
            f"mpv={mpv_actual}"
        )
    return {
        "browserFromRequestedMicroseconds": (
            browser_actual - requested_media_time_microseconds
        ),
        "browserMinusMpvMicroseconds": cross_player_delta,
        "maximumAllowedDeltaMicroseconds": MAXIMUM_FRAME_ALIGNMENT_DELTA_MICROSECONDS,
        "mpvFromRequestedMicroseconds": mpv_actual - requested_media_time_microseconds,
        "status": "frame-aligned",
    }


def compare_audio_statistics(
    browser_report: dict[str, object],
    audio_report: dict[str, object] | None,
) -> dict[str, object] | None:
    """Compares amplitude statistics without claiming a perceptual loudness score."""

    if audio_report is None:
        return None
    pacing = require_mapping(browser_report.get("pacing"), "Browser pacing")
    browser_statistics_value = pacing.get("audioSignal")
    if browser_statistics_value is None:
        return {
            "status": "unavailable",
            "reason": "Browser AudioWorklet signal telemetry was unavailable",
        }
    browser_statistics = require_mapping(
        browser_statistics_value,
        "Browser audio signal statistics",
    )
    mpv_statistics = require_mapping(
        audio_report.get("statistics"),
        "mpv audio statistics",
    )

    def difference(key: str) -> float | None:
        browser_value = browser_statistics.get(key)
        mpv_value = mpv_statistics.get(key)
        if not isinstance(browser_value, (int, float)) or isinstance(browser_value, bool):
            return None
        if not isinstance(mpv_value, (int, float)) or isinstance(mpv_value, bool):
            return None
        return float(browser_value) - float(mpv_value)

    return {
        "browser": dict(browser_statistics),
        "differenceBrowserMinusMpv": {
            "crestFactorDecibels": difference("crestFactorDecibels"),
            "peakDecibelsFullScale": difference("peakDecibelsFullScale"),
            "rootMeanSquareDecibelsFullScale": difference(
                "rootMeanSquareDecibelsFullScale"
            ),
        },
        "mpv": dict(mpv_statistics),
        "status": "descriptive-only",
    }


def run_comparison(
    *,
    ffmpeg: ExecutableResolution,
    manifest: dict[str, object],
    output_directory: Path,
    replacements: Mapping[str, str],
) -> dict[str, object]:
    """Produces visual triptychs, image deltas, and an audio amplitude comparison."""

    browser_report_path = output_directory / "browser" / "browser-report.json"
    browser_report = require_mapping(read_json(browser_report_path), "Browser report")
    browser_captures = index_captures(browser_report, "Browser report")
    visual = require_mapping(manifest["visual"], "Manifest visual")
    width = cast(int, visual["width"])
    height = cast(int, visual["height"])
    comparison_directory = output_directory / "comparison"
    comparison_directory.mkdir(parents=True, exist_ok=True)
    profile_results: list[dict[str, object]] = []
    for profile_value in cast(list[object], manifest["mpvProfiles"]):
        profile = require_mapping(profile_value, "mpv profile")
        profile_identifier = cast(str, profile["id"])
        mpv_report_path = (
            output_directory / "mpv" / profile_identifier / "mpv-report.json"
        )
        mpv_report = require_mapping(read_json(mpv_report_path), "mpv report")
        mpv_captures = index_captures(mpv_report, f"mpv profile {profile_identifier}")
        capture_results: list[dict[str, object]] = []
        for timestamp_microseconds in cast(list[int], visual["timestampsMicroseconds"]):
            browser_capture = browser_captures.get(timestamp_microseconds)
            mpv_capture = mpv_captures.get(timestamp_microseconds)
            if not browser_capture or not mpv_capture:
                raise HarnessError(
                    f"Missing comparison capture at {timestamp_microseconds} microseconds"
                )
            browser_image = browser_report_path.parent / cast(
                str,
                browser_capture["filename"],
            )
            mpv_image = mpv_report_path.parent / cast(str, mpv_capture["filename"])
            if not browser_image.is_file() or not mpv_image.is_file():
                raise HarnessError(
                    f"A comparison image is missing at {timestamp_microseconds} microseconds"
                )
            alignment = capture_alignment_record(
                browser_capture,
                mpv_capture,
                timestamp_microseconds,
            )
            ssim, ssim_command = run_metric_command(
                browser_image=browser_image,
                ffmpeg=ffmpeg,
                filter_name="ssim",
                height=height,
                mpv_image=mpv_image,
                output_directory=output_directory,
                replacements=replacements,
                width=width,
            )
            psnr, psnr_command = run_metric_command(
                browser_image=browser_image,
                ffmpeg=ffmpeg,
                filter_name="psnr",
                height=height,
                mpv_image=mpv_image,
                output_directory=output_directory,
                replacements=replacements,
                width=width,
            )
            triptych_path = comparison_directory / (
                f"{manifest['caseId']}-{profile_identifier}-"
                f"{timestamp_microseconds}-triptych.png"
            )
            triptych_command = create_triptych(
                browser_image=browser_image,
                destination=triptych_path,
                ffmpeg=ffmpeg,
                height=height,
                mpv_image=mpv_image,
                output_directory=output_directory,
                width=width,
            )
            capture_results.append(
                {
                    "alignment": alignment,
                    "browserActualMediaTimeMicroseconds": browser_capture.get(
                        "actualMediaTimeMicroseconds"
                    ),
                    "commands": {
                        "psnr": command_record(psnr_command, replacements),
                        "ssim": command_record(ssim_command, replacements),
                        "triptych": command_record(triptych_command, replacements),
                    },
                    "mpvActualMediaTimeMicroseconds": mpv_capture.get(
                        "actualMediaTimeMicroseconds"
                    ),
                    "psnr": psnr,
                    "requestedMediaTimeMicroseconds": timestamp_microseconds,
                    "ssim": ssim,
                    "triptych": relative_path(triptych_path, output_directory),
                }
            )
        profile_results.append(
            {
                "captures": capture_results,
                "profileId": profile_identifier,
            }
        )

    audio_report_path = output_directory / "mpv" / "audio" / "audio-report.json"
    audio_report = (
        require_mapping(read_json(audio_report_path), "mpv audio report")
        if audio_report_path.is_file()
        else None
    )
    report = {
        "audio": compare_audio_statistics(browser_report, audio_report),
        "metricPolicy": (
            "SSIM and PSNR are descriptive display-code deltas, not perceptual "
            "tone-mapping pass/fail thresholds."
        ),
        "profiles": profile_results,
        "schemaVersion": 1,
        "status": "compared",
    }
    report_path = comparison_directory / "comparison-report.json"
    write_json(report_path, report)
    return {
        "profileCount": len(profile_results),
        "report": relative_path(report_path, output_directory),
    }


def media_source_record(source_path: Path | None) -> dict[str, object] | None:
    """Records stable file identity without leaking its absolute library path."""

    if source_path is None:
        return None
    statistics = source_path.stat()
    return {
        "fileName": source_path.name,
        "lastModifiedUtc": datetime.fromtimestamp(
            statistics.st_mtime,
            UTC,
        ).isoformat(),
        "sizeBytes": statistics.st_size,
    }


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Executes selected stages and writes progressive failure-safe evidence."""

    stages = parse_stages(arguments.stages)
    if arguments.timeout_seconds <= 0:
        raise HarnessError("Timeout must be positive")
    if arguments.browser_phase_timeout_seconds <= 0:
        raise HarnessError("Browser phase timeout must be positive")
    if (
        "browser" in stages
        and arguments.browser_phase_timeout_seconds + 15 >= arguments.timeout_seconds
    ):
        raise HarnessError(
            "Command timeout must exceed the browser phase timeout by more than 15 seconds"
        )
    if arguments.settle_ms < 0 or arguments.settle_ms > 5_000:
        raise HarnessError("Settle time must be from 0 through 5000 milliseconds")
    manifest_path = Path(arguments.manifest).expanduser().resolve()
    manifest = normalize_manifest(read_json(manifest_path))
    case_identifier = cast(str, manifest["caseId"])
    output_directory = create_output_directory(arguments.output, case_identifier)
    output_directory.mkdir(parents=True, exist_ok=True)
    normalized_plan_path = output_directory / "capture-plan.json"
    write_json(normalized_plan_path, manifest)

    needs_source = "mpv" in stages or "audio" in stages
    source_path = require_source_path(arguments.source) if needs_source else None
    replacements = create_report_replacements(
        source_path,
        arguments.username,
        arguments.password,
    )

    tools: dict[str, object] = {}
    node: ExecutableResolution | None = None
    mpv: ExecutableResolution | None = None
    ffmpeg: ExecutableResolution | None = None
    if "browser" in stages:
        node = resolve_executable("node", arguments.node, "WEBGPU_AB_NODE")
        tools["node"] = executable_record(node)
    if "mpv" in stages or "audio" in stages:
        mpv = resolve_executable("mpv", arguments.mpv, "WEBGPU_AB_MPV")
        tools["mpv"] = executable_record(mpv)
    if "compare" in stages:
        ffmpeg_argument = arguments.ffmpeg
        if ffmpeg_argument is None and DEFAULT_FFMPEG_PATH.is_file():
            ffmpeg_argument = str(DEFAULT_FFMPEG_PATH)
        ffmpeg = resolve_executable("ffmpeg", ffmpeg_argument, "WEBGPU_AB_FFMPEG")
        tools["ffmpeg"] = executable_record(ffmpeg)

    report_path = output_directory / "run-report.json"
    report: dict[str, object] = {
        "capturePlan": relative_path(normalized_plan_path, output_directory),
        "caseId": case_identifier,
        "createdAtUtc": datetime.now(UTC).isoformat(),
        "mediaSource": media_source_record(source_path),
        "schemaVersion": 1,
        "selectedStages": list(stages),
        "stages": {},
        "status": "running",
        "tools": tools,
    }
    write_json(report_path, report)
    stage_results = cast(dict[str, object], report["stages"])

    try:
        if "browser" in stages:
            if node is None:
                raise HarnessError("Node resolution was unexpectedly unavailable")
            stage_results["browser"] = run_browser_capture(
                arguments=arguments,
                node=node,
                normalized_plan_path=normalized_plan_path,
                output_directory=output_directory,
                replacements=replacements,
            )
            write_json(report_path, report)
        if "mpv" in stages:
            if mpv is None or source_path is None:
                raise HarnessError("mpv visual prerequisites were unexpectedly unavailable")
            stage_results["mpv"] = run_mpv_visual_capture(
                arguments=arguments,
                manifest=manifest,
                mpv=mpv,
                output_directory=output_directory,
                replacements=replacements,
                source_path=source_path,
            )
            write_json(report_path, report)
        if "audio" in stages:
            if mpv is None or source_path is None:
                raise HarnessError("mpv audio prerequisites were unexpectedly unavailable")
            stage_results["audio"] = run_mpv_audio_capture(
                arguments=arguments,
                manifest=manifest,
                mpv=mpv,
                output_directory=output_directory,
                replacements=replacements,
                source_path=source_path,
            )
            write_json(report_path, report)
        if "compare" in stages:
            if ffmpeg is None:
                raise HarnessError("FFmpeg resolution was unexpectedly unavailable")
            stage_results["compare"] = run_comparison(
                ffmpeg=ffmpeg,
                manifest=manifest,
                output_directory=output_directory,
                replacements=replacements,
            )
        report["completedAtUtc"] = datetime.now(UTC).isoformat()
        report["status"] = "completed"
        write_json(report_path, report)
        return {
            "outputDirectory": str(output_directory),
            "report": str(report_path),
            "status": "completed",
        }
    except (HarnessError, OSError) as error:
        report["completedAtUtc"] = datetime.now(UTC).isoformat()
        report["error"] = sanitize_text(str(error), replacements)
        report["status"] = "failed"
        write_json(report_path, report)
        raise


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Prints one machine-readable result and suppresses expected tracebacks."""

    parser = create_argument_parser()
    arguments = parser.parse_args(command_arguments)
    try:
        result = execute(arguments)
    except (HarnessError, OSError) as error:
        print(f"WebGPU/mpv A/B harness failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
