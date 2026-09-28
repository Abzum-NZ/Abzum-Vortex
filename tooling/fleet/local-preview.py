#!/usr/bin/env python3
"""Run one explicitly owned, local-only preview against an exact Git commit.

This standard-library-only runner has no scheduler, GitHub write, hosted target, package install,
or cleanup/revert behavior. A run deliberately resets the already-running local Supabase database
and leaves its declared source fixtures in the caller's checkout for inspection.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import shutil
import shlex
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit


PATCHED_SIGN_IN = Path("apps/web/app/auth/sign-in/page.tsx")
TEST_SIGN_IN_HELPER = Path("apps/web/app/auth/dev-test-sign-in.ts")
PREPARED_NEXT_ENV = Path("apps/web/next-env.d.ts")
SETUP_STATE = Path("supabase/.temp/development-setup-state.json")
DIAGNOSTIC_OWNER_EMAIL = "codex-preview@vortex.test"
DIAGNOSTIC_STATUS = "DIAGNOSTIC_COMPLETE"
DIAGNOSTIC_HELPER_SHA256 = "0faeee5d13256b283bacc71688add055b29bed58f5d9049e0f209e84580fd987"
MAX_SETUP_STATE_BYTES = 1024 * 1024
MAX_NEXT_ENV_BYTES = 1024 * 1024
MAX_AUTH_USERS_RESPONSE = 2 * 1024 * 1024
MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
MAX_SCREENSHOT_DIMENSION = 8192
SCREENSHOT_BASENAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,47}\.png\Z")
AUTH_USERS_PAGE_SIZE = 200
AUTH_USERS_MAX_PAGES = 10
NEXT_DEVELOPMENT_ENV_FILES = (
    ".env.development.local",
    ".env.local",
    ".env.development",
    ".env",
)
REQUIRED_BROWSER_CHECKS = (
    "sign_in",
    "companies_list",
    "new_company",
    "save_company",
    "maia_root",
    "maia_active_menu",
    "maia_table",
    "secondary_button",
    "customer_dimensions",
    "primary_rest",
    "primary_hover",
    "large_radius",
    "default_style_distinct",
)
THEME_METRIC_FIELDS = (
    "customer_computed_width_px",
    "customer_computed_height_px",
    "customer_rect_width_px",
    "customer_rect_height_px",
    "maia_table_header_padding_px",
    "maia_table_border_px",
    "maia_base_radius_px",
    "maia_menu_radius_px",
    "nova_base_radius_px",
    "nova_menu_radius_px",
)
THEME_METRIC_DEPENDENCIES = {
    "maia_active_menu": ("maia_menu_radius_px",),
    "maia_table": ("maia_table_header_padding_px", "maia_table_border_px"),
    "customer_dimensions": THEME_METRIC_FIELDS[:4],
    "large_radius": (
        "maia_base_radius_px",
        "maia_menu_radius_px",
        "nova_base_radius_px",
        "nova_menu_radius_px",
    ),
}
SAFE_BROWSER_REASONS = frozenset(
    {
        "ambiguous_control",
        "browser_connect_failed",
        "browser_exit_unconfirmed",
        "browser_protocol_invalid",
        "browser_start_failed",
        "browser_start_timeout",
        "candidate_checkout_unavailable",
        "candidate_head_mismatch",
        "candidate_head_unavailable",
        "company_name_unavailable",
        "company_save_unconfirmed",
        "company_type_unavailable",
        "companies_row_unavailable",
        "devtools_instance_mismatch",
        "devtools_target_ambiguous",
        "devtools_unavailable",
        "edge_not_found",
        "fixture_mismatch",
        "fixture_size_limit",
        "internal_error",
        "invalid_arguments",
        "invalid_fixture_fingerprints",
        "invalid_head_sha",
        "invalid_origin",
        "invalid_run_nonce",
        "navigation_failed",
        "navigation_timeout",
        "page_state_unavailable",
        "page_unavailable",
        "profile_cleanup_failed",
        "required_control_unavailable",
        "run_timeout",
        "sign_in_timeout",
        "screenshot_artifact_failed",
        "step_timeout",
        "theme_check_failed",
        "unexpected_origin",
    }
)
SAFE_BROWSER_ACTION_STAGES = frozenset(
    {
        "not_started",
        "sign_in",
        "companies_list",
        "new_company_click",
        "company_create_route",
        "company_name_control",
        "customer_control",
        "company_name_value",
        "customer_value",
        "save_control",
        "save_confirmation",
        "companies_screenshot",
        "maia_root",
        "maia_active_menu",
        "maia_table",
        "secondary_button",
        "customer_dimensions",
        "primary_rest",
        "primary_hover",
        "default_style_comparison",
        "complete",
    }
)
SAFE_MAIA_MENU_FAILED_PREDICATES = frozenset(
    {
        "wrong_route",
        "root_count",
        "root_theme",
        "nav_item_count",
        "current_link_count",
        "link_not_visible",
        "inactive_link",
        "sidebar_scope",
        "sentinel_resolution",
        "menu_radius",
        "base_radius",
        "menu_background",
        "comparison_state",
    }
)
MAIA_FOREGROUND_PROBE_FIELDS = (
    "root_primary_foreground_present",
    "sidebar_primary_foreground_present",
    "sidebar_accent_foreground_present",
    "anchor_accent_foreground_present",
    "anchor_matches_accent_foreground",
    "label_matches_anchor",
    "accent_matches_primary_foreground",
    "sidebar_dark_scheme_resolved",
)
CUSTOMER_PROBE_COUNT_FIELDS = (
    "form_count",
    "group_count",
    "checkbox_candidate_count",
    "visible_candidate_count",
    "customer_name_match_count",
    "visible_customer_match_count",
    "disabled_customer_match_count",
    "visible_customer_label_count",
)
CUSTOMER_PROBE_GROUP_FIELDS = CUSTOMER_PROBE_COUNT_FIELDS[2:]
CUSTOMER_VISIBILITY_FLAGS = (
    "self_hidden",
    "self_aria_hidden",
    "ancestor_hidden",
    "ancestor_aria_hidden",
    "self_display_none",
    "ancestor_display_none",
    "self_visibility_hidden",
    "ancestor_visibility_hidden",
    "self_opacity_zero",
    "ancestor_opacity_zero",
    "no_client_rect",
    "zero_rect_width",
    "zero_rect_height",
    "computed_display_inline",
    "has_checkbox_class",
    "has_inline_style",
)
RUN_TIMEOUTS = {
    "auth_prepare": 120,
    "supabase_status": 60,
    "database_reset": 600,
    "local_owner": 30,
    "setup_local": 900,
    "server_ready": 180,
    "browser_smoke": 600,
    "server_stop": 20,
}
MAX_CAPTURED_OUTPUT = 64 * 1024


class PreviewError(Exception):
    def __init__(self, code: str, message: str, *, step: str | None = None):
        super().__init__(message)
        self.code = code
        self.step = step


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


@dataclass
class CommandResult:
    exit_code: int
    elapsed_seconds: float
    timed_out: bool = False
    stdout: bytes = b""
    stopped: bool = True


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_existing(raw: str, label: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise PreviewError("invalid_path", f"{label} must be an absolute path")
    try:
        return path.resolve(strict=True)
    except OSError:
        raise PreviewError("missing_path", f"{label} does not exist") from None


def _resolve_future(raw: str, label: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise PreviewError("invalid_path", f"{label} must be an absolute path")
    return path.resolve(strict=False)


def _is_reparse_point(info: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & reparse_flag)


def _reject_reparse_components(path: Path, label: str) -> None:
    """Reject symlink/reparse components before resolving an artifact destination."""
    if not path.is_absolute():
        raise PreviewError("screenshot_path_invalid", f"{label} must be absolute")
    cursor = Path(path.anchor)
    parts = path.parts[1:]
    for index, part in enumerate(parts):
        if part in ("", "."):
            continue
        if part == "..":
            cursor = cursor.parent
            continue
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            raise PreviewError("screenshot_path_invalid", f"{label} path cannot be inspected") from None
        if _is_reparse_point(info):
            raise PreviewError("screenshot_path_invalid", f"{label} cannot contain a symlink or reparse point")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise PreviewError("screenshot_path_invalid", f"{label} parent path is not a directory")


def _prepare_screenshot_target(args: argparse.Namespace, checkout: Path) -> tuple[Path, Path] | None:
    raw_target = getattr(args, "screenshot_output", None)
    if raw_target is None:
        return None
    raw_state = str(args.state_dir)
    if any(
        len(raw_path) > 4096 or any(ord(character) < 0x20 for character in raw_path)
        for raw_path in (raw_target, raw_state)
    ):
        raise PreviewError("screenshot_path_invalid", "Screenshot paths are invalid or too long")
    target_input = Path(raw_target).expanduser()
    state_input = Path(raw_state).expanduser()
    if not target_input.is_absolute() or not state_input.is_absolute():
        raise PreviewError("screenshot_path_invalid", "Screenshot and state paths must be absolute")
    if any(
        segment in {".", ".."}
        for raw_path in (raw_target, raw_state)
        for segment in raw_path.replace("/", "\\").split("\\")
    ):
        raise PreviewError("screenshot_path_invalid", "Screenshot paths cannot contain dot segments")
    if not SCREENSHOT_BASENAME_PATTERN.fullmatch(target_input.name):
        raise PreviewError("screenshot_path_invalid", "Screenshot output must use a conservative PNG basename")
    if target_input.stem.upper() in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
    }:
        raise PreviewError("screenshot_path_invalid", "Screenshot output basename is reserved by the operating system")
    _reject_reparse_components(state_input, "--state-dir")
    _reject_reparse_components(target_input, "--screenshot-output")
    state_dir = state_input.resolve(strict=False)
    target = target_input.resolve(strict=False)
    if target.parent != state_dir or target.name != target_input.name:
        raise PreviewError("screenshot_path_invalid", "Screenshot output must be a direct child of --state-dir")
    _outside_checkout(state_dir, checkout, "--state-dir")
    _outside_git_worktrees(state_dir, "--state-dir")

    try:
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            os.chmod(state_dir, 0o700)
    except OSError:
        raise PreviewError("screenshot_state_dir_invalid", "The private screenshot state directory is unavailable") from None
    _reject_reparse_components(state_dir, "--state-dir")
    try:
        state_info = state_dir.lstat()
    except OSError:
        raise PreviewError("screenshot_state_dir_invalid", "The private screenshot state directory is unavailable") from None
    if _is_reparse_point(state_info) or not stat.S_ISDIR(state_info.st_mode):
        raise PreviewError("screenshot_state_dir_invalid", "The screenshot state path is not a regular directory")
    try:
        if state_dir.resolve(strict=True) != state_dir:
            raise PreviewError("screenshot_state_dir_invalid", "The screenshot state directory is not canonical")
    except OSError:
        raise PreviewError("screenshot_state_dir_invalid", "The private screenshot state directory is unavailable") from None
    if os.name != "nt" and stat.S_IMODE(state_info.st_mode) & 0o077:
        raise PreviewError("screenshot_state_dir_invalid", "The screenshot state directory is not private")
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    except OSError:
        raise PreviewError("screenshot_path_invalid", "Screenshot output cannot be inspected") from None
    else:
        raise PreviewError("screenshot_path_exists", "Screenshot output must not already exist")
    return state_dir, target


def _verified_screenshot_metadata(
    state_dir: Path, target: Path, report: Any
) -> dict[str, Any] | None:
    """Revalidate a completed adapter PNG after its process and browser have exited."""
    if not isinstance(report, dict) or set(report) != {"sha256", "bytes"}:
        return None
    reported_hash = report.get("sha256")
    reported_bytes = report.get("bytes")
    if (
        not isinstance(reported_hash, str)
        or not re.fullmatch(r"[0-9a-f]{64}", reported_hash)
        or type(reported_bytes) is not int
        or reported_bytes < 33
        or reported_bytes > MAX_SCREENSHOT_BYTES
    ):
        return None
    if target.parent != state_dir or target.name == "" or not SCREENSHOT_BASENAME_PATTERN.fullmatch(target.name):
        return None
    try:
        _outside_git_worktrees(state_dir, "screenshot state directory")
        _reject_reparse_components(state_dir, "screenshot state directory")
        _reject_reparse_components(target, "screenshot artifact")
        if state_dir.resolve(strict=True) != state_dir or target.resolve(strict=True) != target:
            return None
        before = target.lstat()
        if _is_reparse_point(before) or not stat.S_ISREG(before.st_mode):
            return None
        if before.st_size != reported_bytes or before.st_size > MAX_SCREENSHOT_BYTES:
            return None
        with target.open("rb") as artifact:
            opened = os.fstat(artifact.fileno())
            if _is_reparse_point(opened) or not stat.S_ISREG(opened.st_mode):
                return None
            payload = artifact.read(MAX_SCREENSHOT_BYTES + 1)
            after = os.fstat(artifact.fileno())
        final = target.lstat()
    except (OSError, PreviewError):
        return None
    stable = all(
        left == right
        for left, right in (
            (before.st_dev, opened.st_dev),
            (before.st_ino, opened.st_ino),
            (opened.st_dev, after.st_dev),
            (opened.st_ino, after.st_ino),
            (after.st_dev, final.st_dev),
            (after.st_ino, final.st_ino),
            (before.st_size, after.st_size),
            (before.st_mtime_ns, after.st_mtime_ns),
            (after.st_size, final.st_size),
        )
    )
    if (
        not stable
        or _is_reparse_point(final)
        or not stat.S_ISREG(final.st_mode)
        or len(payload) != reported_bytes
        or len(payload) > MAX_SCREENSHOT_BYTES
        or payload[:8] != b"\x89PNG\r\n\x1a\n"
        or payload[8:12] != b"\x00\x00\x00\x0d"
        or payload[12:16] != b"IHDR"
        or (zlib.crc32(payload[12:29]) & 0xFFFFFFFF) != int.from_bytes(payload[29:33], "big")
        or hashlib.sha256(payload).hexdigest() != reported_hash
    ):
        return None
    width, height = struct.unpack(">II", payload[16:24])
    if width < 1 or height < 1 or width > MAX_SCREENSHOT_DIMENSION or height > MAX_SCREENSHOT_DIMENSION:
        return None
    return {"sha256": reported_hash, "bytes": reported_bytes}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    except OSError:
        raise PreviewError("unreadable_file", f"Cannot read declared file: {path}") from None
    return digest.hexdigest()


def _checked_digest(actual: str, expected: str, label: str) -> None:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected) or actual.lower() != expected.lower():
        raise PreviewError("fingerprint_mismatch", f"{label} SHA-256 does not match its declaration")


def _run_process(
    command: list[str],
    *,
    cwd: Path,
    timeout: int,
    env: dict[str, str] | None = None,
    capture_stdout: bool = False,
) -> CommandResult:
    started = time.monotonic()
    creationflags = 0
    options: dict[str, Any] = {}
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
        options["creationflags"] = creationflags
    else:
        options["start_new_session"] = True
    try:
        child = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **options,
        )
    except OSError:
        return CommandResult(127, time.monotonic() - started)

    if not capture_stdout:
        try:
            child.wait(timeout=timeout)
            return CommandResult(
                child.returncode if child.returncode is not None else 1,
                time.monotonic() - started,
            )
        except subprocess.TimeoutExpired:
            stopped = _stop_owned_tree(child, timeout=RUN_TIMEOUTS["server_stop"])
            return CommandResult(124, time.monotonic() - started, timed_out=True, stopped=stopped)

    assert child.stdout is not None
    captured = bytearray()
    overflow = threading.Event()
    read_failed = threading.Event()

    def read_bounded_stdout() -> None:
        try:
            while True:
                block = child.stdout.read(4096)
                if not block:
                    return
                if len(captured) + len(block) > MAX_CAPTURED_OUTPUT:
                    overflow.set()
                    return
                captured.extend(block)
        except (OSError, ValueError):
            read_failed.set()

    reader = threading.Thread(target=read_bounded_stdout, name="preview-stdout-reader", daemon=True)
    reader.start()
    deadline = started + timeout
    while True:
        if overflow.is_set():
            stopped = _stop_owned_tree(child, timeout=RUN_TIMEOUTS["server_stop"])
            try:
                child.wait(timeout=RUN_TIMEOUTS["server_stop"])
            except subprocess.TimeoutExpired:
                stopped = False
            reader_stopped = _finish_capture_reader(reader, child.stdout)
            stopped = stopped and reader_stopped
            return CommandResult(125, time.monotonic() - started, stopped=stopped)
        if child.poll() is not None:
            if not _finish_capture_reader(reader, child.stdout):
                return CommandResult(125, time.monotonic() - started, stdout=bytes(captured), stopped=False)
            if overflow.is_set() or read_failed.is_set():
                return CommandResult(125, time.monotonic() - started)
            return CommandResult(child.returncode or 0, time.monotonic() - started, stdout=bytes(captured))
        if time.monotonic() >= deadline:
            stopped = _stop_owned_tree(child, timeout=RUN_TIMEOUTS["server_stop"])
            try:
                child.wait(timeout=RUN_TIMEOUTS["server_stop"])
            except subprocess.TimeoutExpired:
                stopped = False
            reader_stopped = _finish_capture_reader(reader, child.stdout)
            stopped = stopped and reader_stopped
            return CommandResult(124, time.monotonic() - started, timed_out=True, stopped=stopped)
        time.sleep(0.05)


def _finish_capture_reader(reader: threading.Thread, stream: Any) -> bool:
    reader.join(timeout=1)
    if reader.is_alive():
        # Closing a stream from another thread can block on its read lock. Leave it owned by
        # the daemon reader and fail closed; the runner process exit closes the descriptor.
        return False
    try:
        stream.close()
    except OSError:
        return False
    return True


def _stop_owned_tree(child: subprocess.Popen[bytes], *, timeout: int, require_running: bool = False) -> bool:
    """Stop only a process group created by this invocation, never a name-matched process."""
    if child.poll() is not None:
        return not require_running
    if os.name == "nt":
        taskkill = shutil.which("taskkill.exe") or shutil.which("taskkill")
        if taskkill is None:
            return False
        try:
            killer = subprocess.run(
                [taskkill, "/PID", str(child.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if killer.returncode not in (0, 128):
                return child.poll() is not None
            child.wait(timeout=timeout)
            return True
        except (OSError, subprocess.TimeoutExpired):
            return child.poll() is not None
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=min(timeout, 5))
        return True
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=timeout)
            return True
        except (OSError, subprocess.TimeoutExpired):
            return child.poll() is not None
    except OSError:
        return child.poll() is not None


def _git(checkout: Path, args: list[str], *, capture: bool = True) -> CommandResult:
    return _run_process(
        ["git", *args],
        cwd=checkout,
        timeout=20,
        capture_stdout=capture,
    )


def _git_text(checkout: Path, args: list[str]) -> str:
    result = _git(checkout, args)
    if not result.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "A Git identity check left process cleanup uncertain")
    if result.timed_out or result.exit_code != 0:
        raise PreviewError("git_read_failed", "A read-only Git identity check failed")
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError:
        raise PreviewError("git_output_invalid", "Git returned unexpected text") from None


def _git_paths(checkout: Path, args: list[str]) -> set[str]:
    result = _git(checkout, args)
    if not result.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "A Git change check left process cleanup uncertain")
    if result.timed_out or result.exit_code != 0:
        raise PreviewError("git_read_failed", "A read-only Git change check failed")
    return {part.decode("utf-8") for part in result.stdout.split(b"\0") if part}


def _validate_sha(value: str) -> str:
    if not re.fullmatch(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})", value):
        raise PreviewError("invalid_sha", "--sha must be a full 40- or 64-character commit SHA")
    return value.lower()


def _checkout_and_sha(raw_checkout: str, raw_sha: str) -> tuple[Path, str, str]:
    checkout = _resolve_existing(raw_checkout, "--checkout")
    if not checkout.is_dir():
        raise PreviewError("invalid_checkout", "--checkout must name a directory")
    top = Path(_git_text(checkout, ["rev-parse", "--show-toplevel"])).resolve()
    if top != checkout:
        raise PreviewError("not_checkout_root", "--checkout must be the Git worktree root")
    expected = _validate_sha(raw_sha)
    actual = _git_text(checkout, ["rev-parse", "HEAD"]).lower()
    if expected != actual:
        raise PreviewError("head_mismatch", "Checkout HEAD does not equal the declared full SHA")
    return checkout, expected, actual


def _read_dotenv(path: Path) -> dict[str, str]:
    """Read simple KEY=VALUE entries without ever returning values to the caller's output."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise PreviewError("env_file_unreadable", "The local web environment file is unreadable") from None
    for line in lines:
        item = line.strip()
        if not item or item.startswith("#"):
            continue
        if item.startswith("export "):
            item = item[7:].lstrip()
        if "=" not in item:
            continue
        key, raw = item.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        raw = raw.strip()
        if raw.startswith(("'", '"')):
            try:
                parsed = shlex.split(raw, comments=False, posix=True)
            except ValueError:
                raise PreviewError("env_file_format", "The local env file uses unsupported quoting") from None
            if len(parsed) != 1:
                raise PreviewError("env_file_format", "The local env file uses unsupported quoting")
            value = parsed[0]
        else:
            value = raw.split(" #", 1)[0].strip()
        values[key] = value
    return values


def _forbidden_next_admin_key(name: str) -> bool:
    upper = name.upper()
    return (
        "SERVICE_ROLE" in upper
        or upper.endswith("SECRET_KEY")
        or upper.endswith("SERVICE_KEY")
        or re.search(r"(?:^|_)ADMIN(?:_[A-Z0-9]+)*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$", upper) is not None
    )


def _has_forbidden_next_admin_line(path: Path) -> bool:
    """Catch credential names even when dotenv syntax differs from our simple parser."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise PreviewError("env_file_unreadable", "A Next development environment source is unreadable") from None
    for line in lines:
        item = line.lstrip()
        if item and not item.startswith("#"):
            names = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", item)
            if any(_forbidden_next_admin_key(name) for name in names):
                return True
    return False


def _validate_next_env_sources(checkout: Path, primary_values: dict[str, str]) -> None:
    """Reject admin credentials in every dotenv file Next dev can auto-load."""
    web = checkout / "apps" / "web"
    for filename in NEXT_DEVELOPMENT_ENV_FILES:
        path = web / filename
        if not path.exists() and not path.is_symlink():
            continue
        try:
            if path.is_symlink() or not path.is_file() or not _inside(path.resolve(strict=True), checkout):
                raise PreviewError("invalid_env_file", "A Next development environment source is not a regular checkout file")
            if path.stat().st_size > MAX_NEXT_ENV_BYTES:
                raise PreviewError("invalid_env_file", "A Next development environment source exceeds its size limit")
        except PreviewError:
            raise
        except OSError:
            raise PreviewError("invalid_env_file", "A Next development environment source is unavailable") from None
        values = primary_values if filename == ".env.development.local" else _read_dotenv(path)
        if _has_forbidden_next_admin_line(path) or any(_forbidden_next_admin_key(name) for name in values):
            raise PreviewError("next_env_admin_key_forbidden", "A Next development environment source contains an admin credential key")


def _loopback_url(value: str, label: str, *, port: int | None = None) -> str:
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        is_loopback = host == "localhost" or (host is not None and ipaddress.ip_address(host).is_loopback)
        parsed_port = parsed.port
    except (ValueError, TypeError):
        is_loopback = False
        parsed = None
        parsed_port = None
    if parsed is None or parsed.scheme != "http" or not is_loopback or parsed.username or parsed.password:
        raise PreviewError("nonlocal_url", f"{label} must be a plain HTTP loopback URL")
    if port is not None and parsed_port != port:
        raise PreviewError("unexpected_local_port", f"{label} must use local port {port}")
    return value.rstrip("/")


def _pr_pair(args: argparse.Namespace) -> tuple[str, int] | None:
    repo = getattr(args, "pr_repo", None)
    number = getattr(args, "pr_number", None)
    if (repo is None) != (number is None):
        raise PreviewError("invalid_pr_identity", "Specify both --pr-repo and --pr-number, or neither")
    if repo is None:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or number < 1:
        raise PreviewError("invalid_pr_identity", "The optional PR identity is invalid")
    return repo, number


def _outside_checkout(path: Path, checkout: Path, label: str) -> None:
    if _inside(path, checkout):
        raise PreviewError("path_inside_checkout", f"{label} must be outside the candidate checkout")


def _outside_git_worktrees(path: Path, label: str) -> None:
    cursor = path
    while True:
        git_marker = cursor / ".git"
        if git_marker.exists() or git_marker.is_symlink():
            raise PreviewError("path_inside_checkout", f"{label} must be outside every Git worktree")
        if cursor.parent == cursor:
            return
        cursor = cursor.parent


def _file_arg(raw: str, digest: str, checkout: Path, label: str) -> tuple[Path, str]:
    path = _resolve_existing(raw, label)
    if not path.is_file():
        raise PreviewError("invalid_file", f"{label} must be a regular file")
    _outside_checkout(path, checkout, label)
    actual = _sha256(path)
    _checked_digest(actual, digest, label)
    return path, actual


def _validate_env_file(raw: str, checkout: Path) -> tuple[Path, dict[str, str]]:
    env_file = _resolve_existing(raw, "--web-env-file")
    expected = (checkout / "apps" / "web" / ".env.development.local").resolve()
    if env_file != expected or not env_file.is_file():
        raise PreviewError(
            "invalid_env_file",
            "--web-env-file must be this checkout's apps/web/.env.development.local",
        )
    ignored = _git(checkout, ["check-ignore", "--quiet", "--", "apps/web/.env.development.local"])
    if not ignored.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "The Git ignore check left process cleanup uncertain")
    if ignored.timed_out or ignored.exit_code != 0:
        raise PreviewError("env_file_not_ignored", "The local environment file is not Git-ignored")
    values = _read_dotenv(env_file)
    _validate_next_env_sources(checkout, values)
    required = (
        "VORTEX_IDENTITY_AUTHORITY_ID",
        "VORTEX_SUPABASE_URL",
        "VORTEX_SUPABASE_PUBLISHABLE_KEY",
        "VORTEX_SITE_URL",
    )
    if any(not values.get(name) for name in required):
        raise PreviewError("env_file_incomplete", "The local environment file lacks required local app settings")
    try:
        uuid.UUID(values["VORTEX_IDENTITY_AUTHORITY_ID"])
    except (ValueError, AttributeError):
        raise PreviewError("invalid_authority_id", "The local identity authority ID is not a UUID") from None
    _loopback_url(values["VORTEX_SUPABASE_URL"], "VORTEX_SUPABASE_URL", port=54321)
    _loopback_url(values["VORTEX_SITE_URL"], "VORTEX_SITE_URL")
    if not values["VORTEX_SUPABASE_PUBLISHABLE_KEY"].strip():
        raise PreviewError("missing_publishable_key", "The local publishable key is empty")
    if values.get("VORTEX_ENVIRONMENT", "local") != "local":
        raise PreviewError("nonlocal_environment", "VORTEX_ENVIRONMENT must be local")
    if values.get("NODE_ENV", "development") == "production" or values.get("CI", "").lower() == "true":
        raise PreviewError("nonlocal_environment", "The local web environment cannot be production or CI")
    for name, value in values.items():
        if (
            name != "VORTEX_RUNTIME_DATABASE_URL"
            and name.startswith(("VORTEX_", "SUPABASE_"))
            and name.endswith(("_URL", "_ORIGIN"))
        ):
            expected_port = 54321 if name in {"VORTEX_SUPABASE_URL", "SUPABASE_URL"} else None
            _loopback_url(value, name, port=expected_port)
        if name == "VORTEX_RUNTIME_DATABASE_URL":
            try:
                database = urlsplit(value)
                host = database.hostname
                local = host == "localhost" or (host is not None and ipaddress.ip_address(host).is_loopback)
            except (ValueError, TypeError):
                local = False
                database = None
            if database is None or database.scheme != "postgresql" or not local or database.port != 54322:
                raise PreviewError("nonlocal_database_url", "VORTEX_RUNTIME_DATABASE_URL must use local port 54322")
    return env_file, values


def _validate_pr_remote(repo: str, number: int, sha: str, cwd: Path) -> dict[str, Any]:
    gh = shutil.which("gh")
    if gh is None:
        raise PreviewError("gh_unavailable", "GitHub CLI is unavailable for the requested read-only PR check")
    result = _run_process(
        [gh, "pr", "view", str(number), "--repo", repo, "--json", "headRefOid,state"],
        cwd=cwd,
        timeout=30,
        capture_stdout=True,
    )
    if not result.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "The PR head check left process cleanup uncertain")
    if result.timed_out or result.exit_code != 0:
        raise PreviewError("pr_read_failed", "The read-only pull request head check failed")
    try:
        data = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise PreviewError("pr_response_invalid", "The pull request head response was invalid") from None
    head = data.get("headRefOid")
    state = data.get("state")
    if not isinstance(head, str) or head.lower() != sha or state != "OPEN":
        raise PreviewError("pr_head_mismatch", "The pull request is closed or its head differs from the candidate SHA")
    return {"repo": repo, "number": number, "state": state, "head_sha": head.lower()}


def _parse_cli_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--checkout", required=True, help="Absolute path to the prepared candidate worktree")
    parser.add_argument("--sha", required=True, help="Full 40- or 64-character HEAD commit SHA")
    parser.add_argument("--pr-repo", help="Optional OWNER/REPO for a read-only exact-head check")
    parser.add_argument("--pr-number", type=int, help="Optional open pull request number")


def _add_run_args(parser: argparse.ArgumentParser, *, state_dir: bool) -> None:
    _parse_cli_args(parser)
    parser.add_argument("--web-env-file", required=True, help="Ignored local apps/web/.env.development.local")
    parser.add_argument("--fixture-page-sha256", required=True, help="Expected SHA-256 of the prepared sign-in page")
    parser.add_argument("--fixture-helper-sha256", required=True, help="Expected SHA-256 of the prepared local sign-in helper")
    parser.add_argument("--fixture-next-env-sha256", required=True, help="Expected SHA-256 of the prepared Next.js-generated apps/web/next-env.d.ts")
    parser.add_argument("--browser-adapter", required=True, help="External local browser adapter (.mjs) meeting the JSON contract")
    parser.add_argument("--browser-adapter-sha256", required=True, help="Expected SHA-256 of the browser adapter")
    parser.add_argument("--owner-email", required=True, help="Disposable local first-owner email; never a password")
    parser.add_argument("--port", type=int, default=3000, help="Loopback Next.js port; default 3000")
    if state_dir:
        parser.add_argument("--state-dir", required=True, help="Stable absolute result directory outside all candidate checkouts")


def _add_diagnostic_args(parser: argparse.ArgumentParser, *, live: bool) -> None:
    _add_run_args(parser, state_dir=live)
    parser.add_argument("--setup-state-sha256", required=True, help="Exact SHA-256 of the completed ignored local setup state")
    if live:
        parser.add_argument("--owner-id", required=True, help="Exact disposable local Auth UUID returned by diagnose-preflight")
        parser.add_argument("--confirm-rotate-owner-id", required=True, help="Repeat --owner-id to authorize only its local password rotation")
        parser.add_argument(
            "--screenshot-output",
            help="Optional new private PNG directly under --state-dir; only diagnose-existing accepts this",
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="One-shot exact-SHA local preview runner; no install, hosted check, scheduler, or GitHub write."
    )
    modes = parser.add_subparsers(dest="mode", required=True)
    plan = modes.add_parser("plan", help="Print the ordered plan without touching the checkout or services")
    _parse_cli_args(plan)
    preflight = modes.add_parser("preflight", help="Read-only checks; performs no reset or process startup")
    _add_run_args(preflight, state_dir=False)
    run = modes.add_parser("run", help="Run after review and explicit local-reset confirmation")
    _add_run_args(run, state_dir=True)
    run.add_argument("--confirm-reset-sha", required=True, help="Repeat --sha to authorize the local database reset")
    diagnosis_preflight = modes.add_parser("diagnose-preflight", help="Read-only existing-setup and disposable-owner checks")
    _add_diagnostic_args(diagnosis_preflight, live=False)
    diagnosis = modes.add_parser("diagnose-existing", help="Browser-only diagnosis of the pinned completed local setup")
    _add_diagnostic_args(diagnosis, live=True)
    return parser


def _safe_email(email: str) -> bool:
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email))


def _preflight(args: argparse.Namespace, *, require_setup_absent: bool = True) -> dict[str, Any]:
    checkout, sha, _ = _checkout_and_sha(args.checkout, args.sha)
    if not _safe_email(args.owner_email):
        raise PreviewError("invalid_owner_email", "--owner-email is not a valid email address")
    if args.port < 1024 or args.port > 65535:
        raise PreviewError("invalid_port", "--port must be between 1024 and 65535")

    web_env_file, _ = _validate_env_file(args.web_env_file, checkout)
    adapter, adapter_hash = _file_arg(
        args.browser_adapter, args.browser_adapter_sha256, checkout, "--browser-adapter"
    )
    if adapter.suffix.lower() != ".mjs":
        raise PreviewError("invalid_browser_adapter", "The browser adapter must be a pinned .mjs file")
    prepared_fixtures = _fixture_changes(checkout)
    page = checkout / PATCHED_SIGN_IN
    helper = checkout / TEST_SIGN_IN_HELPER
    next_env = checkout / PREPARED_NEXT_ENV
    if not page.is_file() or not helper.is_file() or not next_env.is_file():
        raise PreviewError("fixture_missing", "A declared local sign-in fixture is missing")
    if require_setup_absent:
        _ensure_setup_state_absent(checkout)
    page_hash = prepared_fixtures[PATCHED_SIGN_IN.as_posix()]
    helper_hash = prepared_fixtures[TEST_SIGN_IN_HELPER.as_posix()]
    next_env_hash = prepared_fixtures[PREPARED_NEXT_ENV.as_posix()]
    _checked_digest(page_hash, args.fixture_page_sha256, "Prepared sign-in page")
    _checked_digest(helper_hash, args.fixture_helper_sha256, "Prepared sign-in helper")
    _checked_digest(next_env_hash, args.fixture_next_env_sha256, "Prepared Next.js generated type declaration")
    if not (checkout / "tooling" / "supabase" / "ensure-local-signing-key.mjs").is_file():
        raise PreviewError("auth_tool_missing", "The canonical local auth preparation script is unavailable")
    if not (checkout / "node_modules" / "supabase" / "dist" / "supabase.js").is_file():
        raise PreviewError("supabase_cli_missing", "The pinned Supabase CLI entry point is not already installed")
    if not (checkout / "apps" / "web" / "node_modules" / "next" / "dist" / "bin" / "next").is_file():
        raise PreviewError("next_cli_missing", "The installed Next.js entry point is unavailable")
    if not (checkout / "apps" / "web" / "node_modules" / "tsx").exists():
        raise PreviewError("tsx_missing", "The installed web setup runtime is unavailable")
    if shutil.which("node") is None or shutil.which("git") is None:
        raise PreviewError("runtime_missing", "Node.js or Git is unavailable")
    _server_paths(checkout)
    pair = _pr_pair(args)
    return {
        "checkout": str(checkout),
        "head_sha": sha,
        "optional_pr": None if pair is None else {"repo": pair[0], "number": pair[1]},
        "local_env_file": str(web_env_file),
        "fixtures": {
            PATCHED_SIGN_IN.as_posix(): page_hash,
            TEST_SIGN_IN_HELPER.as_posix(): helper_hash,
            PREPARED_NEXT_ENV.as_posix(): next_env_hash,
        },
        "browser_adapter_path": str(adapter),
        "browser_adapter_sha256": adapter_hash,
        "side_effects": [],
        "commands_executed": ["read-only git identity/diff/ignore checks", "filesystem metadata/hash reads"],
    }


def _diagnostic_preflight(args: argparse.Namespace, *, check_availability: bool = True) -> dict[str, Any]:
    if args.owner_email != DIAGNOSTIC_OWNER_EMAIL:
        raise PreviewError("diagnostic_owner_email_invalid", "Diagnosis is limited to the disposable local preview account")
    if _pr_pair(args) is not None:
        raise PreviewError("diagnostic_pr_unsupported", "Existing-setup diagnosis does not inspect a hosted pull request")
    base = _preflight(args, require_setup_absent=False)
    checkout = Path(base["checkout"])
    if base["fixtures"][TEST_SIGN_IN_HELPER.as_posix()] != DIAGNOSTIC_HELPER_SHA256:
        raise PreviewError("diagnostic_helper_mismatch", "Diagnosis requires the reviewed existing-user-only sign-in helper")
    setup_hash = _diagnostic_setup_state(checkout, args.setup_state_sha256)
    lock_dir = (Path.home() / ".vortex-local-preview").resolve(strict=False)
    _outside_checkout(lock_dir, checkout, "preview lock directory")
    _outside_git_worktrees(lock_dir, "preview lock directory")
    if check_availability:
        lock = lock_dir / "local-preview.lock"
        if lock.exists() or lock.is_symlink():
            raise PreviewError("preview_locked", "The shared local preview lock already exists")
        if not _port_is_free(args.port):
            raise PreviewError("web_port_occupied", "The requested loopback web port is already occupied")
    _, local_values = _validate_env_file(args.web_env_file, checkout)
    node = shutil.which("node")
    if node is None:
        raise PreviewError("runtime_missing", "Node.js is unavailable")
    cli = checkout / "node_modules" / "supabase" / "dist" / "supabase.js"
    api_url, service_key = _diagnostic_status(checkout, node, cli, _base_env())
    try:
        if api_url != _loopback_url(local_values["VORTEX_SUPABASE_URL"], "VORTEX_SUPABASE_URL", port=54321):
            raise PreviewError("supabase_url_mismatch", "The local stack and app Supabase URLs differ")
        owner_id = _find_diagnostic_owner(api_url, service_key)
    finally:
        service_key = ""
    return {
        **base,
        "schema": "vortex.local-preview.diagnostic-preflight.v1",
        "optional_pr": None,
        "owner_email": DIAGNOSTIC_OWNER_EMAIL,
        "owner_id": owner_id,
        "setup_state_sha256": setup_hash,
        "setup_completed": True,
        "diagnostic_only": True,
        "side_effects": [],
        "commands_executed": [
            *base["commands_executed"],
            "read-only pinned local Supabase status",
            "bounded read-only local Auth user lookup",
        ],
    }


def _base_env() -> dict[str, str]:
    env = os.environ.copy()
    for name in list(env):
        if (
            name.startswith(("VORTEX_", "SUPABASE_", "NEXT_PUBLIC_"))
            or re.search(r"(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE|API_KEY)$", name, re.IGNORECASE)
            or name in {
                "DATABASE_URL",
                "VERCEL",
                "VERCEL_ENV",
                "CI",
                "NODE_OPTIONS",
                "NODE_PATH",
            }
        ):
            env.pop(name, None)
    env["CI"] = ""
    return env


def _record(steps: list[dict[str, Any]], log_file: Any, **event: Any) -> None:
    entry = {"at": _utc_now(), **event}
    steps.append(entry)
    log_file.write(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n")
    log_file.flush()
    os.fsync(log_file.fileno())


def _command_step(
    name: str,
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int,
    steps: list[dict[str, Any]],
    log_file: Any,
    capture_stdout: bool = False,
) -> bytes:
    result = _run_process(command, cwd=cwd, env=env, timeout=timeout, capture_stdout=capture_stdout)
    _record(
        steps,
        log_file,
        step=name,
        exit_code=result.exit_code,
        timed_out=result.timed_out,
        elapsed_seconds=round(result.elapsed_seconds, 3),
        owned_process_tree_stopped=result.stopped,
    )
    if not result.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", f"Step {name} left process cleanup uncertain", step=name)
    if result.timed_out:
        raise PreviewError("command_timeout", f"Step {name} exceeded its bounded timeout", step=name)
    if result.exit_code != 0:
        raise PreviewError("command_failed", f"Step {name} exited nonzero ({result.exit_code})", step=name)
    return result.stdout


def _supabase_status(
    checkout: Path,
    node: str,
    cli: Path,
    env: dict[str, str],
    steps: list[dict[str, Any]],
    log_file: Any,
    step: str,
) -> tuple[str, str]:
    raw = _command_step(
        step,
        [node, str(cli), "status", "--output", "json"],
        cwd=checkout,
        env=env,
        timeout=RUN_TIMEOUTS["supabase_status"],
        steps=steps,
        log_file=log_file,
        capture_stdout=True,
    )
    if len(raw) > 64 * 1024:
        raise PreviewError("status_output_too_large", "Local Supabase status output exceeded its safe limit", step=step)
    try:
        status = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise PreviewError("status_output_invalid", "Local Supabase status was not valid JSON", step=step) from None
    if not isinstance(status, dict):
        raise PreviewError("status_output_invalid", "Local Supabase status was not a JSON object", step=step)
    api = status.get("API_URL")
    secret = status.get("SECRET_KEY")
    if not isinstance(api, str) or not isinstance(secret, str) or not secret:
        raise PreviewError("local_stack_unavailable", "The already-running local Supabase stack is unavailable", step=step)
    api = _loopback_url(api, "Supabase API_URL", port=54321)
    return api, secret


def _create_local_owner(api_url: str, service_key: str, email: str, password: str) -> tuple[int, str]:
    body = json.dumps({"email": email, "password": password, "email_confirm": True}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_url}/auth/v1/admin/users",
        data=body,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    try:
        with opener.open(request, timeout=RUN_TIMEOUTS["local_owner"]) as response:
            raw = response.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise PreviewError("owner_response_too_large", "Local Auth returned an oversized response", step="local_owner")
            result = json.loads(raw.decode("utf-8"))
            identity = result.get("id") if isinstance(result, dict) else None
            if response.status not in (200, 201) or not isinstance(identity, str):
                raise PreviewError("owner_create_failed", "Local Auth did not create the disposable first owner", step="local_owner")
            return response.status, identity
    except PreviewError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeError, json.JSONDecodeError):
        raise PreviewError("owner_create_failed", "The local Auth owner request failed", step="local_owner") from None


def _diagnostic_uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise PreviewError("diagnostic_owner_invalid", f"{label} must be a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        raise PreviewError("diagnostic_owner_invalid", f"{label} must be a canonical UUID") from None
    if parsed.int == 0 or str(parsed) != value.lower():
        raise PreviewError("diagnostic_owner_invalid", f"{label} must be a canonical UUID")
    return str(parsed)


def _diagnostic_status(checkout: Path, node: str, cli: Path, env: dict[str, str]) -> tuple[str, str]:
    """Read status without writing the local Auth key into preflight evidence."""
    result = _run_process(
        [node, str(cli), "status", "--output", "json"],
        cwd=checkout,
        env=env,
        timeout=RUN_TIMEOUTS["supabase_status"],
        capture_stdout=True,
    )
    if not result.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "The read-only local status process did not stop")
    if result.timed_out or result.exit_code != 0 or len(result.stdout) > MAX_CAPTURED_OUTPUT:
        raise PreviewError("local_stack_unavailable", "The already-running local Supabase stack is unavailable")
    try:
        status = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise PreviewError("status_output_invalid", "Local Supabase status was not valid JSON") from None
    api = status.get("API_URL") if isinstance(status, dict) else None
    secret = status.get("SECRET_KEY") if isinstance(status, dict) else None
    if not isinstance(api, str) or not isinstance(secret, str) or not secret:
        raise PreviewError("local_stack_unavailable", "The already-running local Supabase stack is unavailable")
    api = _loopback_url(api, "Supabase API_URL", port=54321)
    parsed = urlsplit(api)
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise PreviewError("nonlocal_url", "Supabase API_URL must be a plain loopback origin")
    return api, secret


def _diagnostic_auth_json(
    api_url: str,
    service_key: str,
    path: str,
    *,
    method: str,
    body: dict[str, str] | None = None,
    limit: int = MAX_AUTH_USERS_RESPONSE,
) -> tuple[dict[str, Any], dict[str, str | None]]:
    """Make one bounded, no-redirect request to the already-validated local Auth API."""
    validated_api = _loopback_url(api_url, "Supabase API_URL", port=54321)
    parsed_api = urlsplit(validated_api)
    if parsed_api.path not in ("", "/") or parsed_api.query or parsed_api.fragment:
        raise PreviewError("nonlocal_url", "Supabase API_URL must be a plain loopback origin")
    if method == "GET":
        if body is not None or not (
            re.fullmatch(r"/auth/v1/admin/users\?page=[1-9][0-9]*&per_page=200", path)
            or re.fullmatch(r"/auth/v1/admin/users/[0-9a-f-]{36}", path)
        ):
            raise PreviewError("diagnostic_auth_request_invalid", "Only bounded local Auth user reads are allowed")
    elif method == "PUT":
        if not re.fullmatch(r"/auth/v1/admin/users/[0-9a-f-]{36}", path) or not (
            isinstance(body, dict) and set(body) == {"password"} and isinstance(body["password"], str)
        ):
            raise PreviewError("diagnostic_auth_request_invalid", "Only the pinned local user's password update is allowed")
    else:
        raise PreviewError("diagnostic_auth_request_invalid", "Unsupported diagnostic Auth method")
    request = urllib.request.Request(
        f"{validated_api}{path}",
        data=None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    try:
        with opener.open(request, timeout=RUN_TIMEOUTS["local_owner"]) as response:
            if response.status != 200:
                raise PreviewError("diagnostic_auth_unavailable", "Local Auth did not return a confirmed response")
            raw = response.read(limit + 1)
            headers = {
                "link": response.headers.get("Link"),
                "total": response.headers.get("X-Total-Count"),
            }
    except PreviewError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise PreviewError("diagnostic_auth_unavailable", "The bounded local Auth request failed") from None
    if len(raw) > limit:
        raise PreviewError("diagnostic_auth_response_invalid", "Local Auth returned an oversized response")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise PreviewError("diagnostic_auth_response_invalid", "Local Auth returned invalid JSON") from None
    if not isinstance(document, dict):
        raise PreviewError("diagnostic_auth_response_invalid", "Local Auth returned an invalid object")
    return document, headers


def _diagnostic_page_metadata(
    headers: dict[str, str | None], api_url: str, page: int, count: int
) -> tuple[int | None, int | None, bool]:
    """Reject contradictory or malformed pagination metadata; never follow Link URLs."""
    total_text = headers["total"]
    total: int | None = None
    if total_text is not None:
        if not re.fullmatch(r"[0-9]+", total_text):
            raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth pagination metadata is invalid")
        total = int(total_text)
        if total > AUTH_USERS_PAGE_SIZE * AUTH_USERS_MAX_PAGES:
            raise PreviewError("diagnostic_owner_lookup_incomplete", "Local Auth user list exceeds the bounded scan")
    link_text = headers["link"]
    last_page: int | None = None
    has_next = False
    if link_text:
        seen_relations: set[str] = set()
        for part in link_text.split(","):
            match = re.fullmatch(r'\s*<([^<>]+)>\s*;\s*rel="(first|prev|next|last)"\s*', part)
            if match is None or match.group(2) in seen_relations:
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth pagination link is invalid")
            relation = match.group(2)
            seen_relations.add(relation)
            linked = urlsplit(urljoin(f"{api_url}/auth/v1/admin/users", match.group(1)))
            origin = urlsplit(api_url)
            try:
                query = parse_qs(linked.query, strict_parsing=True)
                linked_page = int(query["page"][0])
                linked_size = int(query["per_page"][0])
            except (ValueError, KeyError, IndexError):
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth pagination link is invalid") from None
            if (
                linked.scheme != origin.scheme
                or linked.netloc != origin.netloc
                or linked.path not in ("/auth/v1/admin/users", "/admin/users")
                or linked.fragment
                or set(query) != {"page", "per_page"}
                or len(query["page"]) != 1
                or len(query["per_page"]) != 1
                or linked_page < 1
                or linked_size != AUTH_USERS_PAGE_SIZE
                or (relation == "first" and linked_page != 1)
                or (relation == "prev" and (page == 1 or linked_page != page - 1))
                or (relation == "next" and linked_page != page + 1)
                or (relation == "next" and count == 0)
                or (relation == "last" and count > 0 and linked_page < page)
            ):
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth pagination link is invalid")
            if relation == "next":
                has_next = True
            if relation == "last":
                last_page = linked_page
                if last_page > AUTH_USERS_MAX_PAGES:
                    raise PreviewError("diagnostic_owner_lookup_incomplete", "Local Auth user list exceeds the bounded scan")
    return total, last_page, has_next


def _find_diagnostic_owner(api_url: str, service_key: str) -> str:
    matches: list[str] = []
    seen_users: set[str] = set()
    total_expected: int | None = None
    advertised_last: int | None = None
    preceding_next = False
    completed = False
    for page in range(1, AUTH_USERS_MAX_PAGES + 1):
        document, headers = _diagnostic_auth_json(
            api_url,
            service_key,
            f"/auth/v1/admin/users?page={page}&per_page={AUTH_USERS_PAGE_SIZE}",
            method="GET",
        )
        users = document.get("users")
        if not isinstance(users, list) or len(users) > AUTH_USERS_PAGE_SIZE:
            raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user list has an invalid page")
        total, last_page, has_next = _diagnostic_page_metadata(headers, api_url, page, len(users))
        if total is not None:
            if total_expected is not None and total != total_expected:
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user count changed during lookup")
            total_expected = total
        if last_page is not None:
            if advertised_last is not None and last_page != advertised_last:
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth last-page metadata changed")
            advertised_last = last_page
        if len(users) == 0 and (
            preceding_next or (advertised_last is not None and advertised_last > page)
        ):
            raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth advertised users beyond the terminal page")
        if len(users) > 0 and advertised_last is not None and advertised_last < page:
            raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth returned users beyond its last page")
        for user in users:
            if not isinstance(user, dict) or not isinstance(user.get("id"), str):
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user list has an invalid entry")
            identity = _diagnostic_uuid(user["id"], "Local Auth user ID")
            if identity in seen_users:
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user list repeated an identity")
            seen_users.add(identity)
            email = user.get("email")
            if email is not None and not isinstance(email, str):
                raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user list has an invalid email")
            if isinstance(email, str) and email.casefold() == DIAGNOSTIC_OWNER_EMAIL and email != DIAGNOSTIC_OWNER_EMAIL:
                raise PreviewError("diagnostic_owner_lookup_invalid", "The disposable local Auth email is not canonical")
            if email == DIAGNOSTIC_OWNER_EMAIL:
                matches.append(identity)
        if len(users) == 0:
            completed = True
            break
        preceding_next = has_next
    if not completed:
        raise PreviewError("diagnostic_owner_lookup_incomplete", "Local Auth user list did not end within the bounded scan")
    if total_expected is not None and len(seen_users) != total_expected:
        raise PreviewError("diagnostic_owner_lookup_invalid", "Local Auth user count did not match the completed scan")
    if len(matches) != 1:
        raise PreviewError("diagnostic_owner_not_unique", "Exactly one existing disposable local Auth user is required")
    return matches[0]


def _rotate_diagnostic_owner(api_url: str, service_key: str, owner_id: str, password: str) -> None:
    document, _ = _diagnostic_auth_json(
        api_url,
        service_key,
        f"/auth/v1/admin/users/{owner_id}",
        method="PUT",
        body={"password": password},
        limit=256 * 1024,
    )
    user = document.get("user", document)
    if (
        not isinstance(user, dict)
        or user.get("id") != owner_id
        or user.get("email") != DIAGNOSTIC_OWNER_EMAIL
    ):
        raise PreviewError("diagnostic_rotation_unconfirmed", "Local Auth did not confirm the exact disposable user update")


def _diagnostic_owner_still_matches(api_url: str, service_key: str, owner_id: str) -> bool:
    document, _ = _diagnostic_auth_json(
        api_url, service_key, f"/auth/v1/admin/users/{owner_id}", method="GET", limit=256 * 1024
    )
    user = document.get("user", document)
    return isinstance(user, dict) and user.get("id") == owner_id and user.get("email") == DIAGNOSTIC_OWNER_EMAIL


def _port_is_free(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def _http_ready(url: str, timeout: float = 3.0) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    try:
        with opener.open(url, timeout=timeout) as response:
            if response.status != 200:
                return False
            response.read(1024)
            return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def _listener_pids(port: int, *, cwd: Path, env: dict[str, str]) -> set[int]:
    if os.name == "nt":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if powershell is None:
            raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner")
        script = (
            "$ErrorActionPreference = 'Stop'; "
            f"Get-NetTCPConnection -State Listen -LocalPort {port} | "
            "ForEach-Object { [Console]::Out.WriteLine(([string]$_.LocalAddress) + '|' + ([string]$_.OwningProcess)) }"
        )
        result = _run_process(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            cwd=cwd,
            env=env,
            timeout=10,
            capture_stdout=True,
        )
        if not result.stopped:
            raise PreviewError("owned_process_stop_unconfirmed", "The listener query left process cleanup uncertain")
        if result.timed_out or result.exit_code != 0 or len(result.stdout) > MAX_CAPTURED_OUTPUT:
            raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner")
        pids: set[int] = set()
        try:
            for line in result.stdout.decode("utf-8").splitlines():
                address, raw_pid = line.split("|", 1)
                ip = ipaddress.ip_address(address)
                if not ip.is_loopback:
                    raise PreviewError("nonlocal_web_listener", "The requested web port has a non-loopback listener")
                if not raw_pid.isdigit():
                    raise ValueError("invalid owning process")
                pids.add(int(raw_pid))
        except (UnicodeError, ValueError):
            raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner") from None
        return pids
    if sys.platform.startswith("linux"):
        deadline = time.monotonic() + 5
        wanted: set[str] = set()
        target_port = f"{port:04X}"
        try:
            for table in ("tcp", "tcp6"):
                for line in (Path("/proc/net") / table).read_text(encoding="ascii").splitlines()[1:]:
                    fields = line.split()
                    address, raw_port = fields[1].split(":", 1)
                    if raw_port != target_port or fields[3] != "0A":
                        continue
                    if table == "tcp6" or address != "0100007F":
                        raise PreviewError("nonlocal_web_listener", "The requested web port has another listener")
                    wanted.add(fields[9])
        except (OSError, IndexError, UnicodeError, ValueError):
            raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner") from None
        owners: set[int] = set()
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            try:
                descriptors = (process / "fd").iterdir()
                for descriptor in descriptors:
                    if time.monotonic() >= deadline:
                        raise PreviewError("listener_owner_timeout", "Loopback listener ownership check timed out")
                    try:
                        target = os.readlink(descriptor)
                    except FileNotFoundError:
                        continue
                    except PermissionError:
                        raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner") from None
                    if target.startswith("socket:[") and target.endswith("]") and target[8:-1] in wanted:
                        owners.add(int(process.name))
            except FileNotFoundError:
                continue
            except PermissionError:
                raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner") from None
            except OSError:
                raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner") from None
        return owners
    raise PreviewError("listener_owner_unknown", "Cannot verify the loopback listener owner on this platform")


def _process_record(pid: int, *, cwd: Path, env: dict[str, str]) -> dict[str, Any] | None:
    """Read one process identity without persisting its command line or environment."""
    if os.name == "nt":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if powershell is None:
            raise PreviewError("process_identity_unknown", "Cannot verify the owned server process")
        script = (
            "$ErrorActionPreference = 'Stop'; "
            f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}'; "
            "if ($null -ne $p) { "
            "[pscustomobject]@{ pid = [int]$p.ProcessId; parent = [int]$p.ParentProcessId; "
            "created = [long]$p.CreationDate.ToUniversalTime().Ticks; "
            "executable = [string]$p.ExecutablePath; command = [string]$p.CommandLine } "
            "| ConvertTo-Json -Compress }"
        )
        result = _run_process(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            cwd=cwd,
            env=env,
            timeout=10,
            capture_stdout=True,
        )
        if not result.stopped:
            raise PreviewError("owned_process_stop_unconfirmed", "The process identity query left cleanup uncertain")
        if result.timed_out or result.exit_code != 0:
            raise PreviewError("process_identity_unknown", "Cannot verify the owned server process")
        if not result.stdout.strip():
            return None
        try:
            record = json.loads(result.stdout.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise PreviewError("process_identity_unknown", "Cannot verify the owned server process") from None
    elif sys.platform.startswith("linux"):
        process = Path("/proc") / str(pid)
        try:
            stat = (process / "stat").read_text(encoding="ascii")
            fields = stat[stat.rfind(")") + 2 :].split()
            command = (process / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8")
            record = {
                "pid": pid,
                "parent": int(fields[1]),
                "created": int(fields[19]),
                "executable": str((process / "exe").resolve(strict=True)),
                "command": command,
            }
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError, ValueError, IndexError):
            raise PreviewError("process_identity_unknown", "Cannot verify the owned server process") from None
    else:
        raise PreviewError("process_identity_unknown", "Cannot verify the owned server process")
    if (
        not isinstance(record, dict)
        or record.get("pid") != pid
        or not isinstance(record.get("parent"), int)
        or not isinstance(record.get("created"), int)
        or not isinstance(record.get("executable"), str)
        or not isinstance(record.get("command"), str)
    ):
        raise PreviewError("process_identity_unknown", "Cannot verify the owned server process")
    return record


def _same_path(actual: str, expected: Path) -> bool:
    try:
        left = Path(actual).resolve(strict=True)
        right = expected.resolve(strict=True)
    except OSError:
        return False
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _command_names_path(command: str, path: Path) -> bool:
    # Both the symlink path passed to Node and the resolved package path are legitimate.
    candidates = {str(path), str(path.resolve(strict=True))}
    normalized = command.replace("/", "\\") if os.name == "nt" else command
    for candidate in candidates:
        candidate = candidate.replace("/", "\\") if os.name == "nt" else candidate
        if re.search(r'(?:^|[\s"])' + re.escape(candidate) + r'(?:$|[\s"])', normalized, re.IGNORECASE if os.name == "nt" else 0):
            return True
    return False


def _server_paths(cwd: Path) -> tuple[Path, Path, Path]:
    node = shutil.which("node")
    if node is None:
        raise PreviewError("runtime_missing", "Node.js is unavailable")
    cli = cwd / "apps" / "web" / "node_modules" / "next" / "dist" / "bin" / "next"
    worker = cli.resolve(strict=True).parents[1] / "server" / "lib" / "start-server.js"
    if not worker.is_file():
        raise PreviewError("next_worker_missing", "The installed Next.js server worker is unavailable")
    return Path(node), cli, worker


def _assert_direct_server(child: subprocess.Popen[bytes], *, cwd: Path, env: dict[str, str]) -> dict[str, Any]:
    if child.poll() is not None:
        raise PreviewError("server_exited", "The owned local web server exited during verification", step="server_ready")
    node, cli, _ = _server_paths(cwd)
    direct = _process_record(child.pid, cwd=cwd, env=env)
    if direct is None or not _same_path(direct["executable"], node) or not _command_names_path(direct["command"], cli):
        raise PreviewError("server_identity_mismatch", "The direct Next.js process identity cannot be confirmed", step="server_ready")
    return direct


def _assert_owned_listener(
    child: subprocess.Popen[bytes], port: int, *, cwd: Path, env: dict[str, str], expected: tuple[int, int] | None = None
) -> tuple[int, int]:
    direct = _assert_direct_server(child, cwd=cwd, env=env)
    pids = _listener_pids(port, cwd=cwd, env=env)
    if len(pids) != 1:
        raise PreviewError("web_listener_owner_mismatch", "Loopback readiness did not belong exclusively to the owned server", step="server_ready")
    listener_pid = next(iter(pids))
    node, _, worker = _server_paths(cwd)
    listener = _process_record(listener_pid, cwd=cwd, env=env)
    if (
        listener is None
        or listener_pid == child.pid
        or listener["parent"] != child.pid
        or listener["created"] < direct["created"]
        or not _same_path(listener["executable"], node)
        or not _command_names_path(listener["command"], worker)
    ):
        raise PreviewError("web_listener_owner_mismatch", "Loopback listener is not the owned Next.js worker", step="server_ready")
    identity = (listener_pid, listener["created"])
    if expected is not None and identity != expected:
        raise PreviewError("web_listener_changed", "The owned Next.js listener changed during verification", step="server_ready")
    return identity


def _await_server(
    child: subprocess.Popen[bytes], base_url: str, port: int, *, cwd: Path, env: dict[str, str], timeout: int
) -> tuple[float, tuple[int, int]]:
    started = time.monotonic()
    deadline = started + timeout
    ready_url = f"{base_url}/auth/sign-in"
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise PreviewError("server_exited", "The owned local web server exited before readiness", step="server_ready")
        if _http_ready(ready_url):
            time.sleep(0.25)
            pids = _assert_owned_listener(child, port, cwd=cwd, env=env)
            return time.monotonic() - started, pids
        time.sleep(0.5)
    raise PreviewError("server_readiness_timeout", "The owned local web server did not return HTTP 200 before timeout", step="server_ready")


def _stop_owned_server(
    child: subprocess.Popen[bytes],
    listener_identity: tuple[int, int] | None,
    port: int,
    *,
    cwd: Path,
    env: dict[str, str],
) -> bool:
    """Stop the known CLI tree; an unproven worker remains for manual recovery."""
    try:
        if child.poll() is None:
            _assert_direct_server(child, cwd=cwd, env=env)
            direct_stopped = _stop_owned_tree(child, timeout=RUN_TIMEOUTS["server_stop"], require_running=True)
        else:
            # An exited CLI might have left descendants beyond the known listener.
            direct_stopped = False
        listener_gone = True
        if listener_identity is not None:
            pid, created = listener_identity
            current = _process_record(pid, cwd=cwd, env=env)
            listener_gone = current is None or current["created"] != created
        return direct_stopped and listener_gone and _port_is_free(port)
    except PreviewError:
        return False


def _fixture_changes(checkout: Path) -> dict[str, str]:
    staged = _git_paths(checkout, ["diff", "--cached", "--name-only", "-z", "--"])
    tracked = _git_paths(checkout, ["diff", "--name-only", "-z", "--"])
    untracked = _git_paths(checkout, ["ls-files", "--others", "--exclude-standard", "-z"])
    expected_tracked = {PATCHED_SIGN_IN.as_posix(), PREPARED_NEXT_ENV.as_posix()}
    if staged or tracked != expected_tracked or untracked != {TEST_SIGN_IN_HELPER.as_posix()}:
        raise PreviewError("fixture_scope_mismatch", "The fixture changed paths outside its three declared files")
    expected = expected_tracked | {TEST_SIGN_IN_HELPER.as_posix()}
    result: dict[str, str] = {}
    for rel in sorted(expected):
        path = checkout / Path(rel)
        if not path.is_file():
            raise PreviewError("fixture_missing", "A declared local fixture is missing")
        result[rel] = _sha256(path)
    return result


def _ensure_setup_state_absent(checkout: Path) -> None:
    state_file = checkout / SETUP_STATE
    if state_file.exists() or state_file.is_symlink():
        raise PreviewError(
            "setup_state_present",
            "Ignored local development-setup state already exists; preserve it and use a fresh prepared checkout",
        )


def _diagnostic_setup_state(checkout: Path, declared_hash: str) -> str:
    """Require the exact completed, ignored setup record without exposing its contents."""
    if not re.fullmatch(r"[0-9a-fA-F]{64}", declared_hash):
        raise PreviewError("invalid_setup_state_hash", "--setup-state-sha256 must be a SHA-256 digest")
    ignored = _git(checkout, ["check-ignore", "--quiet", "--", SETUP_STATE.as_posix()], capture=False)
    if not ignored.stopped:
        raise PreviewError("owned_process_stop_unconfirmed", "The setup-state Git ignore check left process cleanup uncertain")
    if ignored.timed_out or ignored.exit_code not in (0, 1):
        raise PreviewError("git_read_failed", "A read-only Git ignore check failed")
    if ignored.exit_code == 1:
        raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state must remain Git-ignored")
    path = checkout / SETUP_STATE
    try:
        if path.is_symlink() or not path.is_file() or not _inside(path.resolve(strict=True), checkout):
            raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state must be a regular in-checkout file")
        if path.stat().st_size > MAX_SETUP_STATE_BYTES:
            raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state exceeds its size limit")
        with path.open("rb") as source:
            raw = source.read(MAX_SETUP_STATE_BYTES + 1)
    except PreviewError:
        raise
    except OSError:
        raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state is unavailable") from None
    if len(raw) > MAX_SETUP_STATE_BYTES:
        raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state exceeds its size limit")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != declared_hash.lower():
        raise PreviewError("diagnostic_setup_state_mismatch", "Completed local setup state changed from its declared hash")
    try:
        document = json.loads(raw.decode("utf-8"))
        organization_id = document.get("organizationId") if isinstance(document, dict) else None
        if (
            not isinstance(document, dict)
            or document.get("setupCompleted") is not True
            or not isinstance(organization_id, str)
            or str(uuid.UUID(organization_id)) != organization_id.lower()
            or uuid.UUID(organization_id).int == 0
        ):
            raise ValueError
    except (UnicodeError, json.JSONDecodeError, ValueError, TypeError):
        raise PreviewError("diagnostic_setup_state_invalid", "Completed local setup state has an invalid schema") from None
    return digest


def _write_result(
    state_dir: Path, run_id: str, document: dict[str, Any], *, prefix: str = "local-preview"
) -> Path:
    target = state_dir / f"{prefix}-{run_id}.json"
    temporary = state_dir / f".{prefix}-{run_id}.tmp"
    encoded = (json.dumps(document, sort_keys=True, indent=2) + "\n").encode("utf-8")
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return target


def _acquire_lock(lock_dir: Path, run_id: str, checkout: Path, sha: str) -> tuple[Path, str]:
    lock = lock_dir / "local-preview.lock"
    token = secrets.token_hex(24)
    payload = {
        "token": token,
        "run_id": run_id,
        "pid": os.getpid(),
        "checkout": str(checkout),
        "head_sha": sha,
        "created_at": _utc_now(),
    }
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise PreviewError("preview_locked", "The shared local preview lock already exists; resolve it by owner evidence") from None
    except OSError:
        raise PreviewError("lock_failed", "Could not acquire the shared local preview lock") from None
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(json.dumps(payload, sort_keys=True) + "\n")
        output.flush()
        os.fsync(output.fileno())
    return lock, token


def _release_lock(lock: Path, token: str) -> bool:
    try:
        current = json.loads(lock.read_text(encoding="utf-8"))
        if current.get("token") != token:
            return False
        lock.unlink()
        return True
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False


def _browser_report(
    raw: bytes,
    sha: str,
    run_nonce: str,
    fixtures: dict[str, str],
    *,
    screenshot_target: Path | None = None,
    adapter_process_stopped: bool = True,
) -> tuple[dict[str, Any] | None, bool, str | None]:
    """Keep only verified identity, known diagnostics, checks, and cleanup attestation."""
    if len(raw) > MAX_CAPTURED_OUTPUT:
        return None, False, "browser_output_too_large"
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        return None, False, "browser_output_invalid"
    if not isinstance(result, dict) or result.get("schema") != "vortex.local-preview.browser.v1":
        return None, False, "browser_contract_invalid"

    head_matches = result.get("head_sha") == sha
    nonce_matches = result.get("run_nonce") == run_nonce
    fixtures_match = result.get("fixtures") == fixtures
    identity_matches = head_matches and nonce_matches and fixtures_match
    result_value = result.get("result")
    raw_checks = result.get("checks")
    checks = (
        {name: raw_checks[name] for name in REQUIRED_BROWSER_CHECKS if name in raw_checks and type(raw_checks[name]) is bool}
        if isinstance(raw_checks, dict)
        else {}
    )
    checks_valid = isinstance(raw_checks, dict) and set(raw_checks).issubset(REQUIRED_BROWSER_CHECKS) and all(
        type(value) is bool for value in raw_checks.values()
    )
    raw_theme_metrics = result.get("theme_metrics")
    theme_metrics_valid = (
        isinstance(raw_theme_metrics, dict)
        and set(raw_theme_metrics).issubset(THEME_METRIC_FIELDS)
        and all(
            type(value) in (int, float) and 0 <= value <= 256 and math.isfinite(value)
            for value in raw_theme_metrics.values()
        )
    )
    if theme_metrics_valid:
        assert isinstance(raw_theme_metrics, dict)
        theme_metrics_valid = all(
            not checks.get(check_name, False)
            or all(raw_theme_metrics.get(field, 0) > 0 for field in fields)
            for check_name, fields in THEME_METRIC_DEPENDENCIES.items()
        )
    if theme_metrics_valid and checks.get("large_radius") is True:
        assert isinstance(raw_theme_metrics, dict)
        theme_metrics_valid = (
            raw_theme_metrics["maia_base_radius_px"] > raw_theme_metrics["nova_base_radius_px"]
            and raw_theme_metrics["maia_menu_radius_px"] != raw_theme_metrics["nova_menu_radius_px"]
        )
    if theme_metrics_valid and result.get("result") == "PASS":
        assert isinstance(raw_theme_metrics, dict)
        theme_metrics_valid = (
            set(raw_theme_metrics) == set(THEME_METRIC_FIELDS)
            and all(checks.get(name) is True for name in REQUIRED_BROWSER_CHECKS)
            and all(raw_theme_metrics[field] > 0 for field in THEME_METRIC_FIELDS)
        )
    reason = result.get("reason")
    safe_reason = reason if isinstance(reason, str) and reason in SAFE_BROWSER_REASONS else None
    raw_stage = result.get("action_stage")
    safe_stage = raw_stage if isinstance(raw_stage, str) and raw_stage in SAFE_BROWSER_ACTION_STAGES else None
    result_valid = result_value in ("PASS", "FAIL")
    reason_valid = (result_value == "PASS" and reason is None) or (
        result_value == "FAIL" and safe_reason is not None
    )
    raw_cleanup = result.get("browser_cleanup")
    cleanup_valid = (
        isinstance(raw_cleanup, dict)
        and set(raw_cleanup) == {"confirmed"}
        and type(raw_cleanup["confirmed"]) is bool
    )
    cleanup_confirmed = bool(
        cleanup_valid and raw_cleanup["confirmed"] and identity_matches and checks_valid and result_valid and reason_valid
    )
    report_fields_valid = identity_matches and checks_valid and result_valid and reason_valid and cleanup_valid
    evidence: dict[str, Any] = {
        "schema": "vortex.local-preview.browser.v1",
        "result": result_value if result_value in ("PASS", "FAIL") else "INVALID",
        "head_sha_matches": head_matches,
        "run_nonce_matches": nonce_matches,
        "fixtures_match": fixtures_match,
        "checks": checks if identity_matches else {},
        "browser_cleanup": (
            {"adapter_claimed": raw_cleanup["confirmed"], "runner_confirmed": cleanup_confirmed}
            if cleanup_valid
            else None
        ),
    }
    if identity_matches:
        evidence.update({"head_sha": sha, "run_nonce": run_nonce, "fixtures": fixtures})
    if report_fields_valid:
        evidence["theme_metrics_valid"] = theme_metrics_valid
        if theme_metrics_valid:
            assert isinstance(raw_theme_metrics, dict)
            evidence["theme_metrics"] = {
                name: raw_theme_metrics[name] for name in THEME_METRIC_FIELDS if name in raw_theme_metrics
            }
    if safe_reason is not None and identity_matches:
        evidence["reason"] = safe_reason
    if identity_matches and "action_stage" in result:
        evidence["action_stage_valid"] = safe_stage is not None
        if safe_stage is not None:
            evidence["action_stage"] = safe_stage
    if report_fields_valid and (
        (result_value == "FAIL" and safe_stage == "maia_active_menu" and safe_reason == "theme_check_failed")
        or "maia_active_menu_failed_predicate" in result
    ):
        predicate = result.get("maia_active_menu_failed_predicate")
        predicate_valid = (
            result_value == "FAIL"
            and safe_stage == "maia_active_menu"
            and safe_reason == "theme_check_failed"
            and type(predicate) is str
            and predicate in SAFE_MAIA_MENU_FAILED_PREDICATES
        )
        evidence["maia_active_menu_failed_predicate_valid"] = predicate_valid
        if predicate_valid:
            evidence["maia_active_menu_failed_predicate"] = predicate
    if report_fields_valid:
        raw_foreground_probe = result.get("maia_foreground_probe")
        foreground_probe_valid = (
            isinstance(raw_foreground_probe, dict)
            and set(raw_foreground_probe) == set(MAIA_FOREGROUND_PROBE_FIELDS)
            and all(type(raw_foreground_probe[name]) is bool for name in MAIA_FOREGROUND_PROBE_FIELDS)
        )
        evidence["maia_foreground_probe_valid"] = foreground_probe_valid
        if foreground_probe_valid:
            evidence["maia_foreground_probe"] = {
                name: raw_foreground_probe[name] for name in MAIA_FOREGROUND_PROBE_FIELDS
            }
    if (
        identity_matches
        and result_value == "FAIL"
        and safe_stage == "customer_control"
        and checks_valid
        and reason_valid
        and cleanup_valid
    ):
        raw_probe = result.get("customer_control_probe")
        probe_valid = (
            isinstance(raw_probe, dict)
            and set(raw_probe) == set(CUSTOMER_PROBE_COUNT_FIELDS) | {"capped", "scope_valid"}
            and all(
                type(raw_probe[name]) is int and 0 <= raw_probe[name] <= 1024
                for name in CUSTOMER_PROBE_COUNT_FIELDS
            )
            and type(raw_probe["capped"]) is bool
            and type(raw_probe["scope_valid"]) is bool
        )
        if probe_valid:
            assert isinstance(raw_probe, dict)
            probe_valid = (
                raw_probe["scope_valid"] == (raw_probe["form_count"] == 1 and raw_probe["group_count"] == 1)
                and (raw_probe["form_count"] == 1 or raw_probe["group_count"] == 0)
                and (
                    raw_probe["scope_valid"]
                    or all(raw_probe[name] == 0 for name in CUSTOMER_PROBE_GROUP_FIELDS)
                )
                and raw_probe["visible_candidate_count"] <= raw_probe["checkbox_candidate_count"]
                and raw_probe["customer_name_match_count"] <= raw_probe["checkbox_candidate_count"]
                and raw_probe["visible_customer_match_count"] <= raw_probe["visible_candidate_count"]
                and raw_probe["visible_customer_match_count"] <= raw_probe["customer_name_match_count"]
                and raw_probe["disabled_customer_match_count"] <= raw_probe["visible_customer_match_count"]
            )
        evidence["customer_control_probe_valid"] = probe_valid
        if probe_valid:
            evidence["customer_control_probe"] = {
                **{name: raw_probe[name] for name in CUSTOMER_PROBE_COUNT_FIELDS},
                "capped": raw_probe["capped"],
                "scope_valid": raw_probe["scope_valid"],
            }
            if raw_probe["scope_valid"]:
                raw_visibility = result.get("customer_visibility_probe")
                visibility_valid = (
                    isinstance(raw_visibility, dict)
                    and set(raw_visibility)
                    == set(CUSTOMER_VISIBILITY_FLAGS) | {"semantic_root_count", "capped", "semantic_root_unique"}
                    and type(raw_visibility["semantic_root_count"]) is int
                    and 0 <= raw_visibility["semantic_root_count"] <= 1024
                    and type(raw_visibility["capped"]) is bool
                    and (not raw_visibility["capped"] or raw_visibility["semantic_root_count"] == 1024)
                    and type(raw_visibility["semantic_root_unique"]) is bool
                )
                if visibility_valid:
                    assert isinstance(raw_visibility, dict)
                    unique = raw_visibility["semantic_root_count"] == 1 and not raw_visibility["capped"]
                    visibility_valid = raw_visibility["semantic_root_unique"] is unique and all(
                        type(raw_visibility[name]) is bool if unique else raw_visibility[name] is None
                        for name in CUSTOMER_VISIBILITY_FLAGS
                    )
                evidence["customer_visibility_probe_valid"] = visibility_valid
                if visibility_valid:
                    evidence["customer_visibility_probe"] = {
                        "semantic_root_count": raw_visibility["semantic_root_count"],
                        "capped": raw_visibility["capped"],
                        "semantic_root_unique": raw_visibility["semantic_root_unique"],
                        **{name: raw_visibility[name] for name in CUSTOMER_VISIBILITY_FLAGS},
                    }

    if not identity_matches:
        return evidence, False, "browser_evidence_mismatch"
    if not checks_valid or not result_valid:
        return evidence, False, "browser_contract_invalid"
    if not reason_valid:
        return evidence, False, "browser_reason_invalid"
    if not cleanup_valid:
        return evidence, False, "browser_cleanup_attestation_missing"
    if not theme_metrics_valid:
        return evidence, cleanup_confirmed, "browser_theme_contract_invalid"
    if screenshot_target is None:
        if "screenshot" in result:
            return evidence, cleanup_confirmed, "browser_screenshot_unexpected"
    else:
        if result_value == "PASS" and safe_stage != "complete":
            return evidence, cleanup_confirmed, "browser_screenshot_invalid"
        failure_before_capture = (
            result_value == "FAIL"
            and safe_stage not in {"default_style_comparison", "complete"}
            and "screenshot" not in result
        )
        if failure_before_capture:
            # Preserve a failure from before capture completed; the diagnostic still fails without the artifact.
            pass
        else:
            if not adapter_process_stopped or not cleanup_confirmed:
                return evidence, cleanup_confirmed, "browser_screenshot_invalid"
            screenshot_valid_stage = safe_stage in {"companies_screenshot", "default_style_comparison", "complete"}
            if not screenshot_valid_stage or checks.get("save_company") is not True:
                return evidence, cleanup_confirmed, "browser_screenshot_invalid"
            screenshot_metadata = _verified_screenshot_metadata(
                screenshot_target.parent,
                screenshot_target,
                result.get("screenshot"),
            )
            if screenshot_metadata is None:
                return evidence, cleanup_confirmed, "browser_screenshot_invalid"
            evidence["screenshot"] = screenshot_metadata
    return evidence, cleanup_confirmed, None


def _final_identity_checks(
    checkout: Path,
    sha: str,
    fixtures: dict[str, str],
    adapter_path: str,
    adapter_hash: str,
    pair: tuple[str, int] | None,
) -> tuple[dict[str, Any], bool]:
    """Read final source identity after cleanup, even for an otherwise failed run."""
    checked: dict[str, Any] = {}
    uncertain_process = False
    try:
        checked["head_matches"] = _git_text(checkout, ["rev-parse", "HEAD"]).lower() == sha
    except PreviewError as error:
        checked["head_matches"] = None
        checked["head_error"] = error.code
        uncertain_process = uncertain_process or error.code == "owned_process_stop_unconfirmed"
    if fixtures:
        try:
            checked["fixtures_match"] = _fixture_changes(checkout) == fixtures
        except PreviewError as error:
            checked["fixtures_match"] = None
            checked["fixtures_error"] = error.code
            uncertain_process = uncertain_process or error.code == "owned_process_stop_unconfirmed"
    else:
        checked["fixtures_match"] = None
    try:
        adapter = _resolve_existing(adapter_path, "--browser-adapter")
        checked["adapter_matches"] = _sha256(adapter).lower() == adapter_hash.lower()
    except PreviewError as error:
        checked["adapter_matches"] = None
        checked["adapter_error"] = error.code
    if pair is not None:
        try:
            _validate_pr_remote(pair[0], pair[1], sha, checkout)
            checked["pr_matches"] = True
        except PreviewError as error:
            checked["pr_matches"] = None
            checked["pr_error"] = error.code
            uncertain_process = uncertain_process or error.code == "owned_process_stop_unconfirmed"
    return checked, uncertain_process


def _run(args: argparse.Namespace) -> int:
    checkout, sha, _ = _checkout_and_sha(args.checkout, args.sha)
    if _validate_sha(args.confirm_reset_sha) != sha:
        raise PreviewError("reset_confirmation_mismatch", "--confirm-reset-sha must repeat the full candidate SHA")
    preflight = _preflight(args)
    state_dir = _resolve_future(args.state_dir, "--state-dir")
    _outside_checkout(state_dir, checkout, "--state-dir")
    _outside_git_worktrees(state_dir, "--state-dir")
    lock_dir = (Path.home() / ".vortex-local-preview").resolve(strict=False)
    _outside_checkout(lock_dir, checkout, "preview lock directory")
    _outside_git_worktrees(lock_dir, "preview lock directory")
    if not _safe_email(args.owner_email):
        raise PreviewError("invalid_owner_email", "--owner-email is not a valid email address")
    if os.environ.get("VERCEL") or os.environ.get("CI", "").lower() == "true":
        raise PreviewError("noninteractive_environment", "Preview runner refuses Vercel or CI environments")
    pair = _pr_pair(args)
    node = shutil.which("node")
    if node is None:
        raise PreviewError("runtime_missing", "Node.js is unavailable")
    run_id = secrets.token_hex(12)
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        lock_dir.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(state_dir, 0o700)
            os.chmod(lock_dir, 0o700)
    except OSError:
        raise PreviewError("state_dir_failed", "Could not prepare the external result directory") from None
    lock, token = _acquire_lock(lock_dir, run_id, checkout, sha)
    log_path = state_dir / f"local-preview-{run_id}.jsonl"
    try:
        log_file = log_path.open("x", encoding="utf-8")
    except OSError:
        _release_lock(lock, token)
        raise PreviewError("log_create_failed", "Could not create the private structured run log") from None

    steps: list[dict[str, Any]] = []
    status = "FAIL"
    failure: dict[str, Any] | None = None
    fixtures: dict[str, str] = dict(preflight["fixtures"])
    browser_evidence: dict[str, Any] | None = None
    browser_invoked = False
    browser_cleanup_confirmed = False
    browser_reason: str | None = None
    browser_stage: str | None = None
    final_identity: dict[str, Any] | None = None
    server: subprocess.Popen[bytes] | None = None
    server_pid: int | None = None
    server_stopped: bool | None = None
    listener_identity: tuple[int, int] | None = None
    preserve_lock = False
    cli = checkout / "node_modules" / "supabase" / "dist" / "supabase.js"
    base_env = _base_env()
    local_values: dict[str, str] = {}
    try:
        _record(steps, log_file, step="run.started", run_id=run_id, checkout=str(checkout), head_sha=sha)
        if pair is not None:
            pr_info = _validate_pr_remote(pair[0], pair[1], sha, checkout)
            _record(steps, log_file, step="pr.head.before", pr=pr_info)

        if not _port_is_free(args.port):
            raise PreviewError("web_port_occupied", "The requested loopback web port is already occupied")
        _record(steps, log_file, step="web_port.available", port=args.port)

        _, local_values = _validate_env_file(args.web_env_file, checkout)
        fixtures = _fixture_changes(checkout)
        declared_fixtures = {
            PATCHED_SIGN_IN.as_posix(): args.fixture_page_sha256.lower(),
            TEST_SIGN_IN_HELPER.as_posix(): args.fixture_helper_sha256.lower(),
            PREPARED_NEXT_ENV.as_posix(): args.fixture_next_env_sha256.lower(),
        }
        if fixtures != declared_fixtures:
            raise PreviewError("fixture_fingerprint_mismatch", "Prepared fixture bytes changed after preflight")
        _record(steps, log_file, step="fixtures.verified", fixtures=fixtures)

        _command_step(
            "auth.prepare",
            [node, str(checkout / "tooling" / "supabase" / "ensure-local-signing-key.mjs")],
            cwd=checkout,
            env=base_env,
            timeout=RUN_TIMEOUTS["auth_prepare"],
            steps=steps,
            log_file=log_file,
        )
        api_url, pre_reset_key = _supabase_status(
            checkout, node, cli, base_env, steps, log_file, "supabase.status.before"
        )
        if api_url != _loopback_url(local_values["VORTEX_SUPABASE_URL"], "VORTEX_SUPABASE_URL", port=54321):
            raise PreviewError("supabase_url_mismatch", "The running local Supabase URL differs from the local app URL")
        pre_reset_key = ""
        _ensure_setup_state_absent(checkout)
        _command_step(
            "database.reset.local",
            [node, str(cli), "--yes", "db", "reset", "--local"],
            cwd=checkout,
            env=base_env,
            timeout=RUN_TIMEOUTS["database_reset"],
            steps=steps,
            log_file=log_file,
        )
        api_url, service_key = _supabase_status(
            checkout, node, cli, base_env, steps, log_file, "supabase.status.after_reset"
        )
        if api_url != _loopback_url(local_values["VORTEX_SUPABASE_URL"], "VORTEX_SUPABASE_URL", port=54321):
            raise PreviewError("supabase_url_mismatch", "The reset stack URL differs from the declared local app URL")
        test_password = secrets.token_urlsafe(36)
        try:
            owner_status, _owner_id = _create_local_owner(
                api_url, service_key, args.owner_email, test_password
            )
        finally:
            service_key = ""
        _record(steps, log_file, step="local_owner.create", http_status=owner_status, exit_code=0)

        setup_env = base_env.copy()
        setup_env.update(
            {
                "VORTEX_ENVIRONMENT": "local",
                "VORTEX_RUNTIME_DATABASE_URL": "postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres",
                "VORTEX_IDENTITY_AUTHORITY_ID": local_values["VORTEX_IDENTITY_AUTHORITY_ID"],
            }
        )
        _ensure_setup_state_absent(checkout)
        _command_step(
            "setup.local",
            [
                node,
                "--conditions=react-server",
                "--import",
                "tsx",
                str(checkout / "apps" / "web" / "scripts" / "development-setup" / "setup.ts"),
                "--local-development",
                "--first-owner-email",
                args.owner_email,
            ],
            cwd=checkout / "apps" / "web",
            env=setup_env,
            timeout=RUN_TIMEOUTS["setup_local"],
            steps=steps,
            log_file=log_file,
        )

        if not _port_is_free(args.port):
            raise PreviewError("web_port_occupied", "The requested loopback web port is already occupied")
        base_url = f"http://127.0.0.1:{args.port}"
        server_env = base_env.copy()
        server_env.update(
            {
                "NODE_ENV": "development",
                "VORTEX_ENVIRONMENT": "local",
                "VORTEX_SUPABASE_URL": api_url,
                "VORTEX_RUNTIME_DATABASE_URL": "postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres",
                "VORTEX_SITE_URL": base_url,
                "VORTEX_DEV_TEST_SIGN_IN": "enabled",
                "VORTEX_DEV_TEST_EMAIL": args.owner_email,
                "VORTEX_DEV_TEST_PASSWORD": test_password,
                "PORT": str(args.port),
                "NEXT_TELEMETRY_DISABLED": "1",
            }
        )
        test_password = ""
        _, next_local_values = _validate_env_file(args.web_env_file, checkout)
        if next_local_values != local_values:
            raise PreviewError("env_file_changed", "The local web environment changed before Next startup")
        # Recheck the local stack without passing its admin key to the Next child.
        _, server_key = _supabase_status(
            checkout, node, cli, base_env, steps, log_file, "supabase.status.browser"
        )
        next_entry = checkout / "apps" / "web" / "node_modules" / "next" / "dist" / "bin" / "next"
        try:
            server = subprocess.Popen(
                [node, str(next_entry), "dev", "--hostname", "127.0.0.1", "--port", str(args.port)],
                cwd=str(checkout / "apps" / "web"),
                env=server_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=(
                    getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    if os.name == "nt"
                    else 0
                ),
                start_new_session=os.name != "nt",
            )
        except OSError:
            raise PreviewError("server_start_failed", "Could not start the hidden local Next.js child process", step="server_start") from None
        finally:
            server_key = ""
            server_env["VORTEX_DEV_TEST_PASSWORD"] = ""
        server_pid = server.pid
        ready_elapsed, listener_identity = _await_server(
            server,
            base_url,
            args.port,
            cwd=checkout,
            env=base_env,
            timeout=RUN_TIMEOUTS["server_ready"],
        )
        _record(
            steps,
            log_file,
            step="server.ready",
            pid=server.pid,
            listener_pids=[listener_identity[0]],
            http_status=200,
            elapsed_seconds=round(ready_elapsed, 3),
            local_url=base_url,
        )

        adapter = Path(args.browser_adapter).resolve(strict=True)
        _checked_digest(_sha256(adapter), args.browser_adapter_sha256, "Browser adapter")
        owner_identity = _assert_owned_listener(server, args.port, cwd=checkout, env=base_env, expected=listener_identity)
        _record(steps, log_file, step="server.owner.before_browser", pid=server.pid, listener_pids=[owner_identity[0]])
        browser_env = base_env.copy()
        browser_env.update(
            {
                "VORTEX_PREVIEW_BASE_URL": base_url,
                "VORTEX_PREVIEW_HEAD_SHA": sha,
                "VORTEX_PREVIEW_RUN_NONCE": run_id,
                "VORTEX_PREVIEW_FIXTURE_FINGERPRINTS": json.dumps(fixtures, sort_keys=True),
            }
        )
        browser_invoked = True
        browser_command = _run_process(
            [node, str(adapter)],
            cwd=checkout,
            env=browser_env,
            timeout=RUN_TIMEOUTS["browser_smoke"],
            capture_stdout=True,
        )
        _record(
            steps,
            log_file,
            step="browser.smoke",
            exit_code=browser_command.exit_code,
            timed_out=browser_command.timed_out,
            elapsed_seconds=round(browser_command.elapsed_seconds, 3),
            owned_process_tree_stopped=browser_command.stopped,
        )
        browser_evidence, browser_cleanup_confirmed, contract_error = _browser_report(
            browser_command.stdout, sha, run_id, fixtures
        )
        browser_cleanup_confirmed = browser_cleanup_confirmed and browser_command.stopped and not browser_command.timed_out
        if browser_evidence is not None:
            if browser_evidence["browser_cleanup"] is not None:
                browser_evidence["browser_cleanup"]["runner_confirmed"] = browser_cleanup_confirmed
            browser_reason = browser_evidence.get("reason")
            browser_stage = browser_evidence.get("action_stage")
            _record(steps, log_file, step="browser.evidence", evidence=browser_evidence)
        if not browser_command.stopped:
            raise PreviewError("owned_process_stop_unconfirmed", "The browser adapter process tree did not stop", step="browser.smoke")
        if browser_command.timed_out:
            raise PreviewError("command_timeout", "The browser adapter exceeded its bounded timeout", step="browser.smoke")
        if contract_error is not None:
            raise PreviewError(contract_error, "The browser adapter returned invalid structured evidence", step="browser.smoke")
        if not browser_cleanup_confirmed:
            raise PreviewError("browser_cleanup_unconfirmed", "Owned browser cleanup was not confirmed", step="browser.smoke")
        if browser_command.exit_code != 0:
            raise PreviewError("browser_adapter_failed", "The browser adapter exited nonzero", step="browser.smoke")
        assert browser_evidence is not None
        if browser_evidence["result"] != "PASS":
            raise PreviewError("browser_result_failed", "The browser adapter did not declare PASS", step="browser.smoke")
        if any(browser_evidence["checks"].get(name) is not True for name in REQUIRED_BROWSER_CHECKS):
            raise PreviewError("browser_checks_failed", "Browser evidence lacks a required PASS", step="browser.smoke")
        owner_identity = _assert_owned_listener(server, args.port, cwd=checkout, env=base_env, expected=listener_identity)
        _record(steps, log_file, step="server.owner.after_browser", pid=server.pid, listener_pids=[owner_identity[0]])
        status = "PASS"
    except PreviewError as error:
        failure = {"code": error.code, "step": error.step}
        if browser_reason is not None:
            failure["adapter_reason"] = browser_reason
        if browser_stage is not None:
            failure["adapter_action_stage"] = browser_stage
        preserve_lock = preserve_lock or error.code == "owned_process_stop_unconfirmed"
    except Exception:
        failure = {"code": "unexpected_failure", "step": None}
        preserve_lock = True
    finally:
        if server is not None:
            server_stopped = _stop_owned_server(server, listener_identity, args.port, cwd=checkout, env=base_env)
            port_released = _port_is_free(args.port)
            _record(
                steps,
                log_file,
                step="server.stop_owned_tree",
                pid=server_pid,
                stopped=server_stopped,
                port_released=port_released,
            )
            if not server_stopped:
                status = "FAIL"
                failure = {"code": "owned_server_stop_unconfirmed", "step": "server.stop_owned_tree"}
                preserve_lock = True
        try:
            final_identity, final_process_uncertain = _final_identity_checks(
                checkout, sha, fixtures, args.browser_adapter, args.browser_adapter_sha256, pair
            )
            preserve_lock = preserve_lock or final_process_uncertain
        except Exception:
            final_identity = {"error": "unexpected_failure"}
            preserve_lock = True
        _record(steps, log_file, step="final.identity_checked", checks=final_identity)
        required_identity = ("head_matches", "fixtures_match", "adapter_matches")
        if pair is not None:
            required_identity += ("pr_matches",)
        if status == "PASS" and any(final_identity.get(key) is not True for key in required_identity):
            status = "FAIL"
            failure = {"code": "final_identity_unconfirmed", "step": "final.identity_checked"}
        if browser_invoked and not browser_cleanup_confirmed:
            preserve_lock = True
            if status == "PASS":
                status = "FAIL"
                failure = {"code": "browser_cleanup_unconfirmed", "step": "browser.smoke"}
        log_file.close()

    result = {
        "schema": "vortex.local-preview.result.v1",
        "run_id": run_id,
        "status": status,
        "started_at": steps[0]["at"] if steps else _utc_now(),
        "finished_at": _utc_now(),
        "checkout": str(checkout),
        "head_sha": sha,
        "optional_pr": None if pair is None else {"repo": pair[0], "number": pair[1]},
        "fixtures": fixtures,
        "browser_adapter": {
            "path": preflight["browser_adapter_path"],
            "sha256": preflight["browser_adapter_sha256"],
        },
        "browser_evidence": browser_evidence,
        "browser_invoked": browser_invoked,
        "browser_cleanup_confirmed": browser_cleanup_confirmed if browser_invoked else None,
        "final_identity": final_identity,
        "server": {"pid": server_pid, "stopped": server_stopped},
        "steps": steps,
        "failure": failure,
        "log_file": str(log_path),
        "lock_released": False,
    }
    result_path = _write_result(state_dir, run_id, result)
    if not preserve_lock:
        if _release_lock(lock, token):
            result["lock_released"] = True
        else:
            result["status"] = status = "FAIL"
            result["failure"] = failure = {"code": "lock_release_failed", "step": "lock.release"}
        _write_result(state_dir, run_id, result)
    print(json.dumps({"status": status, "result_file": str(result_path), "head_sha": sha, "failure": failure}, sort_keys=True))
    return 0 if status == "PASS" else 2


def _diagnose_existing(args: argparse.Namespace) -> int:
    """Inspect the completed local setup without reset, setup, or a product PASS claim."""
    owner_id = _diagnostic_uuid(args.owner_id, "--owner-id")
    if _diagnostic_uuid(args.confirm_rotate_owner_id, "--confirm-rotate-owner-id") != owner_id:
        raise PreviewError("diagnostic_rotation_confirmation_mismatch", "The rotation confirmation must repeat --owner-id")
    if os.environ.get("VERCEL") or os.environ.get("CI", "").lower() == "true":
        raise PreviewError("noninteractive_environment", "Diagnostic runner refuses Vercel or CI environments")
    screenshot_target: Path | None = None
    screenshot_state_dir: Path | None = None
    if args.screenshot_output is not None:
        checkout_hint, _, _ = _checkout_and_sha(args.checkout, args.sha)
        screenshot_paths = _prepare_screenshot_target(args, checkout_hint)
        assert screenshot_paths is not None
        screenshot_state_dir, screenshot_target = screenshot_paths
    preflight = _diagnostic_preflight(args)
    if preflight["owner_id"] != owner_id:
        raise PreviewError("diagnostic_owner_mismatch", "The pinned UUID differs from the unique disposable local user")
    checkout = Path(preflight["checkout"])
    sha = preflight["head_sha"]
    state_dir = screenshot_state_dir or _resolve_future(args.state_dir, "--state-dir")
    _outside_checkout(state_dir, checkout, "--state-dir")
    _outside_git_worktrees(state_dir, "--state-dir")
    if screenshot_target is not None:
        validated_paths = _prepare_screenshot_target(args, checkout)
        if validated_paths != (state_dir, screenshot_target):
            raise PreviewError("screenshot_path_invalid", "Screenshot destination changed during preflight")
    lock_dir = (Path.home() / ".vortex-local-preview").resolve(strict=False)
    _outside_checkout(lock_dir, checkout, "preview lock directory")
    _outside_git_worktrees(lock_dir, "preview lock directory")
    node = shutil.which("node")
    if node is None:
        raise PreviewError("runtime_missing", "Node.js is unavailable")
    run_id = secrets.token_hex(12)
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        lock_dir.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(state_dir, 0o700)
            os.chmod(lock_dir, 0o700)
    except OSError:
        raise PreviewError("state_dir_failed", "Could not prepare the external diagnostic result directory") from None
    lock, token = _acquire_lock(lock_dir, run_id, checkout, sha)
    log_path = state_dir / f"local-diagnostic-{run_id}.jsonl"
    try:
        log_file = log_path.open("x", encoding="utf-8")
    except OSError:
        _release_lock(lock, token)
        raise PreviewError("log_create_failed", "Could not create the private diagnostic step log") from None

    steps: list[dict[str, Any]] = []
    status = "FAIL"
    failure: dict[str, Any] | None = None
    fixtures: dict[str, str] = dict(preflight["fixtures"])
    browser_evidence: dict[str, Any] | None = None
    browser_invoked = False
    browser_cleanup_confirmed = False
    browser_reason: str | None = None
    browser_stage: str | None = None
    final_identity: dict[str, Any] | None = None
    rotation_attempted = False
    rotation_confirmed = False
    server: subprocess.Popen[bytes] | None = None
    server_pid: int | None = None
    server_stopped: bool | None = None
    listener_identity: tuple[int, int] | None = None
    preserve_lock = False
    base_env = _base_env()
    cli = checkout / "node_modules" / "supabase" / "dist" / "supabase.js"
    try:
        _record(steps, log_file, step="diagnostic.started", run_id=run_id, checkout=str(checkout), head_sha=sha)
        rechecked = _diagnostic_preflight(args, check_availability=False)
        if rechecked["owner_id"] != owner_id or rechecked["fixtures"] != fixtures:
            raise PreviewError("diagnostic_inputs_changed", "The pinned disposable user or prepared fixtures changed")
        _record(
            steps,
            log_file,
            step="diagnostic.inputs_verified",
            owner_id=owner_id,
            setup_state_sha256=preflight["setup_state_sha256"],
            fixtures=fixtures,
            browser_adapter_sha256=preflight["browser_adapter_sha256"],
        )
        if not _port_is_free(args.port):
            raise PreviewError("web_port_occupied", "The requested loopback web port is already occupied")
        _, local_values = _validate_env_file(args.web_env_file, checkout)
        api_url, service_key = _supabase_status(
            checkout, node, cli, base_env, steps, log_file, "supabase.status.diagnostic"
        )
        password = ""
        try:
            if api_url != _loopback_url(local_values["VORTEX_SUPABASE_URL"], "VORTEX_SUPABASE_URL", port=54321):
                raise PreviewError("supabase_url_mismatch", "The local stack and app Supabase URLs differ")
            current_owner = _find_diagnostic_owner(api_url, service_key)
            if current_owner != owner_id:
                raise PreviewError("diagnostic_owner_mismatch", "The disposable local Auth UUID changed")
            _record(steps, log_file, step="diagnostic.owner_verified", owner_id=owner_id)
            password = secrets.token_urlsafe(36)
            rotation_attempted = True
            _rotate_diagnostic_owner(api_url, service_key, owner_id, password)
            rotation_confirmed = True
            _record(steps, log_file, step="diagnostic.owner_password_rotated", owner_id=owner_id, exit_code=0)
        finally:
            service_key = ""

        base_url = f"http://127.0.0.1:{args.port}"
        server_env = base_env.copy()
        server_env.update(
            {
                "NODE_ENV": "development",
                "VORTEX_ENVIRONMENT": "local",
                "VORTEX_SUPABASE_URL": api_url,
                "VORTEX_RUNTIME_DATABASE_URL": "postgresql://vortex_runtime:vortex-runtime-local-only@127.0.0.1:54322/postgres",
                "VORTEX_SITE_URL": base_url,
                "VORTEX_DEV_TEST_SIGN_IN": "enabled",
                "VORTEX_DEV_TEST_EMAIL": DIAGNOSTIC_OWNER_EMAIL,
                "VORTEX_DEV_TEST_PASSWORD": password,
                "PORT": str(args.port),
                "NEXT_TELEMETRY_DISABLED": "1",
            }
        )
        _, next_local_values = _validate_env_file(args.web_env_file, checkout)
        if next_local_values != local_values:
            raise PreviewError("env_file_changed", "The local web environment changed before Next startup")
        next_entry = checkout / "apps" / "web" / "node_modules" / "next" / "dist" / "bin" / "next"
        try:
            server = subprocess.Popen(
                [node, str(next_entry), "dev", "--hostname", "127.0.0.1", "--port", str(args.port)],
                cwd=str(checkout / "apps" / "web"),
                env=server_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=(
                    getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    if os.name == "nt"
                    else 0
                ),
                start_new_session=os.name != "nt",
            )
        except OSError:
            raise PreviewError("server_start_failed", "Could not start the hidden local Next.js child", step="server_start") from None
        finally:
            password = ""
            server_env["VORTEX_DEV_TEST_PASSWORD"] = ""
        server_pid = server.pid
        ready_elapsed, listener_identity = _await_server(
            server, base_url, args.port, cwd=checkout, env=base_env, timeout=RUN_TIMEOUTS["server_ready"]
        )
        _record(
            steps,
            log_file,
            step="server.ready",
            pid=server.pid,
            listener_pids=[listener_identity[0]],
            http_status=200,
            elapsed_seconds=round(ready_elapsed, 3),
            local_url=base_url,
        )
        adapter = Path(args.browser_adapter).resolve(strict=True)
        _checked_digest(_sha256(adapter), args.browser_adapter_sha256, "Browser adapter")
        owner_identity = _assert_owned_listener(server, args.port, cwd=checkout, env=base_env, expected=listener_identity)
        _record(steps, log_file, step="server.owner.before_browser", pid=server.pid, listener_pids=[owner_identity[0]])
        browser_env = base_env.copy()
        browser_env.update(
            {
                "VORTEX_PREVIEW_BASE_URL": base_url,
                "VORTEX_PREVIEW_HEAD_SHA": sha,
                "VORTEX_PREVIEW_RUN_NONCE": run_id,
                "VORTEX_PREVIEW_FIXTURE_FINGERPRINTS": json.dumps(fixtures, sort_keys=True),
            }
        )
        if screenshot_target is not None:
            browser_env.update(
                {
                    "VORTEX_PREVIEW_SCREENSHOT_OUTPUT": str(screenshot_target),
                    "VORTEX_PREVIEW_SCREENSHOT_STATE_DIR": str(state_dir),
                }
            )
        browser_invoked = True
        browser_command = _run_process(
            [node, str(adapter)],
            cwd=checkout,
            env=browser_env,
            timeout=RUN_TIMEOUTS["browser_smoke"],
            capture_stdout=True,
        )
        _record(
            steps,
            log_file,
            step="browser.smoke",
            exit_code=browser_command.exit_code,
            timed_out=browser_command.timed_out,
            elapsed_seconds=round(browser_command.elapsed_seconds, 3),
            owned_process_tree_stopped=browser_command.stopped,
        )
        browser_evidence, browser_cleanup_confirmed, contract_error = _browser_report(
            browser_command.stdout,
            sha,
            run_id,
            fixtures,
            screenshot_target=screenshot_target,
            adapter_process_stopped=browser_command.stopped and not browser_command.timed_out,
        )
        browser_cleanup_confirmed = browser_cleanup_confirmed and browser_command.stopped and not browser_command.timed_out
        if browser_evidence is not None:
            if browser_evidence["browser_cleanup"] is not None:
                browser_evidence["browser_cleanup"]["runner_confirmed"] = browser_cleanup_confirmed
            browser_reason = browser_evidence.get("reason")
            browser_stage = browser_evidence.get("action_stage")
            _record(steps, log_file, step="browser.evidence", evidence=browser_evidence)
        if not browser_command.stopped:
            raise PreviewError("owned_process_stop_unconfirmed", "The browser adapter process tree did not stop", step="browser.smoke")
        if browser_command.timed_out:
            raise PreviewError("command_timeout", "The browser adapter exceeded its bounded timeout", step="browser.smoke")
        if contract_error is not None:
            raise PreviewError(contract_error, "The browser adapter returned invalid structured evidence", step="browser.smoke")
        if not browser_cleanup_confirmed:
            raise PreviewError("browser_cleanup_unconfirmed", "Owned browser cleanup was not confirmed", step="browser.smoke")
        if browser_command.exit_code != 0:
            raise PreviewError("browser_adapter_failed", "The browser adapter exited nonzero", step="browser.smoke")
        assert browser_evidence is not None
        if browser_evidence["result"] != "PASS":
            raise PreviewError("browser_result_failed", "The browser adapter did not declare PASS", step="browser.smoke")
        if any(browser_evidence["checks"].get(name) is not True for name in REQUIRED_BROWSER_CHECKS):
            raise PreviewError("browser_checks_failed", "Browser evidence lacks a required PASS", step="browser.smoke")
        owner_identity = _assert_owned_listener(server, args.port, cwd=checkout, env=base_env, expected=listener_identity)
        _record(steps, log_file, step="server.owner.after_browser", pid=server.pid, listener_pids=[owner_identity[0]])
        status = DIAGNOSTIC_STATUS
    except PreviewError as error:
        failure = {"code": error.code, "step": error.step}
        if browser_reason is not None:
            failure["adapter_reason"] = browser_reason
        if browser_stage is not None:
            failure["adapter_action_stage"] = browser_stage
        preserve_lock = error.code == "owned_process_stop_unconfirmed"
    except Exception:
        failure = {"code": "unexpected_failure", "step": None}
        preserve_lock = True
    finally:
        if server is not None:
            server_stopped = _stop_owned_server(server, listener_identity, args.port, cwd=checkout, env=base_env)
            port_released = _port_is_free(args.port)
            _record(
                steps,
                log_file,
                step="server.stop_owned_tree",
                pid=server_pid,
                stopped=server_stopped,
                port_released=port_released,
            )
            if not server_stopped:
                status = "FAIL"
                failure = {"code": "owned_server_stop_unconfirmed", "step": "server.stop_owned_tree"}
                preserve_lock = True
        try:
            final_identity, final_process_uncertain = _final_identity_checks(
                checkout, sha, fixtures, args.browser_adapter, args.browser_adapter_sha256, None
            )
            preserve_lock = preserve_lock or final_process_uncertain
        except Exception:
            final_identity = {"error": "unexpected_failure"}
            preserve_lock = True
        try:
            final_identity["setup_state_matches"] = (
                _diagnostic_setup_state(checkout, args.setup_state_sha256) == preflight["setup_state_sha256"]
            )
        except PreviewError as error:
            final_identity["setup_state_matches"] = None
            final_identity["setup_state_error"] = error.code
        if rotation_confirmed:
            try:
                final_api, final_key = _diagnostic_status(checkout, node, cli, base_env)
                try:
                    final_identity["owner_matches"] = (
                        final_api == api_url and _diagnostic_owner_still_matches(final_api, final_key, owner_id)
                    )
                finally:
                    final_key = ""
            except PreviewError as error:
                final_identity["owner_matches"] = None
                final_identity["owner_error"] = error.code
                preserve_lock = preserve_lock or error.code == "owned_process_stop_unconfirmed"
        else:
            final_identity["owner_matches"] = None
        _record(steps, log_file, step="final.identity_checked", checks=final_identity)
        required_identity = ("head_matches", "fixtures_match", "adapter_matches", "setup_state_matches", "owner_matches")
        if status == DIAGNOSTIC_STATUS and any(final_identity.get(key) is not True for key in required_identity):
            status = "FAIL"
            failure = {"code": "final_identity_unconfirmed", "step": "final.identity_checked"}
        if browser_invoked and not browser_cleanup_confirmed:
            preserve_lock = True
            if status == DIAGNOSTIC_STATUS:
                status = "FAIL"
                failure = {"code": "browser_cleanup_unconfirmed", "step": "browser.smoke"}
        if rotation_attempted and not rotation_confirmed:
            preserve_lock = True
        log_file.close()

    result = {
        "schema": "vortex.local-preview.diagnostic.v1",
        "scope": "browser-only-existing-setup",
        "run_id": run_id,
        "status": status,
        "product_preview_pass": False,
        "started_at": steps[0]["at"] if steps else _utc_now(),
        "finished_at": _utc_now(),
        "checkout": str(checkout),
        "head_sha": sha,
        "fixtures": fixtures,
        "setup_state_sha256": preflight["setup_state_sha256"],
        "owner_email": DIAGNOSTIC_OWNER_EMAIL,
        "owner_id": owner_id,
        "owner_password_rotation": {"attempted": rotation_attempted, "confirmed": rotation_confirmed},
        "browser_adapter": {
            "path": preflight["browser_adapter_path"],
            "sha256": preflight["browser_adapter_sha256"],
        },
        "browser_evidence": browser_evidence,
        "browser_invoked": browser_invoked,
        "browser_cleanup_confirmed": browser_cleanup_confirmed if browser_invoked else None,
        "final_identity": final_identity,
        "server": {"pid": server_pid, "stopped": server_stopped},
        "steps": steps,
        "failure": failure,
        "log_file": str(log_path),
        "lock_released": False,
    }
    result_path = _write_result(state_dir, run_id, result, prefix="local-diagnostic")
    if not preserve_lock:
        if _release_lock(lock, token):
            result["lock_released"] = True
        else:
            result["status"] = status = "FAIL"
            result["failure"] = failure = {"code": "lock_release_failed", "step": "lock.release"}
        _write_result(state_dir, run_id, result, prefix="local-diagnostic")
    print(json.dumps({"status": status, "result_file": str(result_path), "head_sha": sha, "failure": failure}, sort_keys=True))
    return 0 if status == DIAGNOSTIC_STATUS else 2


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        if args.mode == "plan":
            checkout, sha, _ = _checkout_and_sha(args.checkout, args.sha)
            plan = {
                "checkout": str(checkout),
                "head_sha": sha,
                "optional_pr": None if _pr_pair(args) is None else {"repo": args.pr_repo, "number": args.pr_number},
                "steps": [
                    "validate the exact candidate HEAD and only the three declared prepared fixture changes",
                    "verify optional PR head with one read-only query",
                    "verify the prepared sign-in page, helper, and Next.js type declaration by exact hashes",
                    "prepare local auth key",
                    "verify the already-running loopback Supabase stack",
                    "reset only the local database with --yes db reset --local",
                    "create a disposable first owner through the local Auth admin endpoint",
                    "run canonical local development setup",
                    "start one hidden owned Next.js child and require HTTP 200 readiness",
                    "run a pinned external browser adapter and require exact-SHA JSON evidence",
                    "stop only the owned server process tree and verify final head and fixtures",
                ],
                "side_effects": [],
            }
            print(json.dumps(plan, sort_keys=True, indent=2))
            return 0
        if args.mode == "preflight":
            result = _preflight(args)
            print(json.dumps(result, sort_keys=True, indent=2))
            return 0
        if args.mode == "diagnose-preflight":
            result = _diagnostic_preflight(args)
            print(json.dumps(result, sort_keys=True, indent=2))
            return 0
        if args.mode == "diagnose-existing":
            return _diagnose_existing(args)
        return _run(args)
    except PreviewError as error:
        print(json.dumps({"status": "BLOCKED", "code": error.code, "step": error.step, "message": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
