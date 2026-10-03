"""Settle one recorded Windows process using one birth-verified handle.

Importing this module does not open handles or control processes. The caller owns
the recorded identity and passes the same monotonic deadline to every cleanup in
its aggregate budget. Returned diagnostics contain no native exception messages.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import datetime
import math
import os
import re
import time


def _kernel32():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    return kernel


def _error_number(value):
    return value if type(value) is int and 0 < value <= 0xFFFFFFFF else None


def cleanup_exact(recorded: dict, cleanup_deadline: float) -> dict:
    """Return settlement and diagnostics; never retry or terminate by PID alone.

    Create cleanup_deadline once as time.monotonic() + 30 for the entire batch,
    not once per process. The caller must retain diagnostics, require settled is
    True for every identity, and independently verify complete owned absence.
    """
    pid = recorded.get("ProcessId") if isinstance(recorded, dict) else None
    birth = recorded.get("CreationTime") if isinstance(recorded, dict) else None
    result = {"outcome": "FAIL", "settled": False, "diagnostics": []}
    if (type(pid) is not int or not 0 < pid <= 0xFFFFFFFF or
            not isinstance(birth, str) or
            re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z", birth) is None or
            type(cleanup_deadline) is not float or not math.isfinite(cleanup_deadline)):
        result["outcome"] = "INVALID_INPUT"
        return result
    result.update(pid=pid, creationTime=birth)
    if os.name != "nt":
        result["outcome"] = "WINDOWS_REQUIRED"
        return result
    remaining = cleanup_deadline - time.monotonic()
    if remaining > 30:
        result["outcome"] = "INVALID_INPUT"
        return result
    if remaining <= 0:
        result["outcome"] = "BUDGET_EXHAUSTED"
        return result

    def diagnostic(stage, number=None, wait_result=None):
        value = {"stage": stage, "windowsError": _error_number(number)}
        if wait_result is not None:
            value["waitResult"] = int(wait_result)
        result["diagnostics"].append(value)

    def wait(kernel, handle, stage, milliseconds):
        value = int(kernel.WaitForSingleObject(handle, milliseconds))
        if value not in (0, 258):
            # GetLastError is meaningful only for WAIT_FAILED, not other values.
            number = ctypes.get_last_error() if value == 0xFFFFFFFF else None
            diagnostic(stage, number, value)
        return value

    handle = None
    kernel = None
    stage = "OPEN_PROCESS"
    try:
        kernel = _kernel32()
        handle = kernel.OpenProcess(0x0400 | 0x0001 | 0x00100000, False, pid)
        if not handle:
            number = ctypes.get_last_error()
            diagnostic(stage, number)
            if number == 87:
                result.update(outcome="ALREADY_ABSENT", settled=True)
        else:
            stage = "GET_PROCESS_TIMES"
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            system = wintypes.FILETIME()
            user = wintypes.FILETIME()
            if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                          ctypes.byref(system), ctypes.byref(user)):
                diagnostic(stage, ctypes.get_last_error())
            else:
                ticks = (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
                seconds, fraction = divmod(ticks, 10_000_000)
                date = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
                date += datetime.timedelta(seconds=seconds)
                actual = date.strftime("%Y-%m-%dT%H:%M:%S") + f".{fraction:07d}Z"
                if actual != birth:
                    result.update(outcome="IDENTITY_CHANGED_NO_ACTION", settled=True,
                                  actualCreationTime=actual)
                else:
                    stage = "WAIT_BEFORE_TERMINATE"
                    initial = wait(kernel, handle, stage, 0)
                    if initial == 0:
                        result.update(outcome="ALREADY_EXITED", settled=True)
                    elif initial == 258:
                        if cleanup_deadline <= time.monotonic():
                            result["outcome"] = "BUDGET_EXHAUSTED"
                        else:
                            stage = "TERMINATE_PROCESS"
                            terminated = bool(kernel.TerminateProcess(handle, 1))
                            number = None
                            if not terminated:
                                # Capture before the read-only settlement call changes last error.
                                number = ctypes.get_last_error()
                                diagnostic(stage, number)
                            stage = "WAIT_AFTER_TERMINATE" if terminated else "WAIT_AFTER_TERMINATE_FAILURE"
                            milliseconds = max(0, min(5000, int((cleanup_deadline - time.monotonic()) * 1000)))
                            observed = wait(kernel, handle, stage, milliseconds)
                            result["waitResult"] = observed
                            if observed == 0:
                                if terminated:
                                    result.update(outcome="EXACT_HANDLE_TERMINATED", settled=True)
                                elif number == 5:
                                    result.update(outcome="EXIT_VERIFIED_AFTER_TERMINATE_FAILURE", settled=True)
                                else:
                                    # Exit evidence does not erase an unknown or other native failure.
                                    result["outcome"] = "TERMINATE_FAILED_EXIT_VERIFIED"
                            elif observed == 258:
                                diagnostic(stage, wait_result=observed)
    except BaseException as failure:
        # Preserve the fixed stage and numeric native error, never exception text.
        diagnostic(stage, getattr(failure, "winerror", None))
        result.update(outcome="FAIL", settled=False)
    finally:
        if handle:
            try:
                if not kernel.CloseHandle(handle):
                    number = ctypes.get_last_error()
                    diagnostic("CLOSE_HANDLE", number)
                    result.update(outcome="FAIL", settled=False)
            except BaseException as failure:
                diagnostic("CLOSE_HANDLE", getattr(failure, "winerror", None))
                result.update(outcome="FAIL", settled=False)
    return result
