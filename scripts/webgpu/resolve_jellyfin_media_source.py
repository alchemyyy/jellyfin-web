"""Resolves a local Jellyfin item to same-host media source paths."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Mapping, Sequence, cast


CLIENT_AUTHORIZATION = (
    'MediaBrowser Client="WebGPU A/B Harness", Device="Local Validation", '
    'DeviceId="webgpu-ab-harness", Version="1"'
)


class SourceResolutionError(RuntimeError):
    """Reports a bounded local Jellyfin source-resolution failure."""


def create_argument_parser() -> argparse.ArgumentParser:
    """Creates a credential-safe source resolver CLI."""

    parser = argparse.ArgumentParser(
        description="Resolve a Jellyfin item to local source paths for mpv comparison."
    )
    parser.add_argument("--item-id", required=True)
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WEBGPU_AB_SERVER_URL", "http://localhost:8096"),
    )
    parser.add_argument("--username", default=os.environ.get("WEBGPU_AB_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("WEBGPU_AB_PASSWORD"))
    parser.add_argument(
        "--first-local-path",
        action="store_true",
        help="Print only the first source path that exists on this machine",
    )
    return parser


def request_json(
    *,
    method: str,
    url: str,
    body: Mapping[str, object] | None = None,
    token: str | None = None,
) -> object:
    """Sends one bounded Jellyfin JSON request without logging credentials."""

    encoded_token = urllib.parse.quote(token or "", safe="")
    headers = {
        "Accept": "application/json",
        "Authorization": f'{CLIENT_AUTHORIZATION}, Token="{encoded_token}"',
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise SourceResolutionError(f"Jellyfin request failed: {error}") from error


def require_mapping(value: object, label: str) -> dict[str, object]:
    """Returns one JSON object or raises an actionable response error."""

    if not isinstance(value, dict):
        raise SourceResolutionError(f"{label} response was not an object")
    return cast(dict[str, object], value)


def extract_source_candidates(item: Mapping[str, object]) -> list[dict[str, object]]:
    """Extracts unique item and media-source paths without guessing mount mappings."""

    candidates: list[dict[str, object]] = []
    seen_paths: set[str] = set()

    def append_candidate(path_value: object, source_identifier: object) -> None:
        if not isinstance(path_value, str) or not path_value or path_value in seen_paths:
            return
        seen_paths.add(path_value)
        local_path = Path(path_value)
        candidates.append({
            "existsLocally": local_path.is_file(),
            "path": path_value,
            "sourceId": source_identifier if isinstance(source_identifier, str) else None,
        })

    append_candidate(item.get("Path"), item.get("Id"))
    media_sources = item.get("MediaSources")
    if isinstance(media_sources, list):
        for media_source_value in media_sources:
            if not isinstance(media_source_value, dict):
                continue
            append_candidate(
                media_source_value.get("Path"),
                media_source_value.get("Id"),
            )
    return candidates


def execute(arguments: argparse.Namespace) -> dict[str, object]:
    """Authenticates, reads the exact item, and returns local source candidates."""

    if not arguments.username or not arguments.password:
        raise SourceResolutionError(
            "Pass --username/--password or set WEBGPU_AB_USERNAME/WEBGPU_AB_PASSWORD"
        )
    server_url = arguments.server_url.rstrip("/")
    authentication = require_mapping(
        request_json(
            method="POST",
            url=f"{server_url}/Users/AuthenticateByName",
            body={"Pw": arguments.password, "Username": arguments.username},
        ),
        "Authentication",
    )
    token = authentication.get("AccessToken")
    user = authentication.get("User")
    if not isinstance(token, str) or not isinstance(user, dict):
        raise SourceResolutionError("Jellyfin authentication response was incomplete")
    user_identifier = user.get("Id")
    if not isinstance(user_identifier, str):
        raise SourceResolutionError("Jellyfin authentication returned no user ID")
    encoded_user_identifier = urllib.parse.quote(user_identifier, safe="")
    encoded_item_identifier = urllib.parse.quote(arguments.item_id, safe="")
    item = require_mapping(
        request_json(
            method="GET",
            url=(
                f"{server_url}/Users/{encoded_user_identifier}/Items/"
                f"{encoded_item_identifier}"
            ),
            token=token,
        ),
        "Item",
    )
    candidates = extract_source_candidates(item)
    return {
        "candidates": candidates,
        "itemId": arguments.item_id,
        "itemName": item.get("Name") if isinstance(item.get("Name"), str) else None,
        "status": "resolved" if candidates else "no-paths",
    }


def main(command_arguments: Sequence[str] | None = None) -> int:
    """Prints either structured candidates or one shell-friendly local path."""

    arguments = create_argument_parser().parse_args(command_arguments)
    try:
        result = execute(arguments)
    except SourceResolutionError as error:
        print(f"Jellyfin media source resolution failed: {error}", file=sys.stderr)
        return 1
    if arguments.first_local_path:
        for candidate_value in result["candidates"]:
            candidate = cast(dict[str, object], candidate_value)
            if candidate["existsLocally"] is True:
                print(candidate["path"])
                return 0
        print("No Jellyfin source path exists on this machine", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "resolved" else 1


if __name__ == "__main__":
    raise SystemExit(main())
