import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open as openFile, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const SCHEMA = "vortex.local-preview.browser.v1";
const EDGE_EXECUTABLE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const POWERSHELL_EXECUTABLE = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const APP_PATH = "/abzum/abzum/vortex.app.crm";
const SERVICE_DESK_PATH = "/abzum/abzum/vortex.app.service_desk/service_desk_overview";
const TOTAL_TIMEOUT_MS = 300_000;
const SCREENSHOT_TOTAL_TIMEOUT_MS = 360_000;
const STARTUP_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 300;
const PROFILE_PREFIX = "vortex-preview-edge-";
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_FIXTURE_BYTES = 128 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 8192;
const SCREENSHOT_BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const THEME_CHECK_NAMES = [
  "maia_root",
  "maia_active_menu",
  "maia_table",
  "secondary_button",
  "customer_dimensions",
  "primary_rest",
  "primary_hover",
  "large_radius",
  "default_style_distinct",
];
const THEME_METRIC_NAMES = [
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
];
const MAX_THEME_METRIC_PX = 256;
const MAIA_ACTIVE_MENU_FAILURE_PREDICATES = new Set([
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
]);

const result = {
  schema: SCHEMA,
  result: "FAIL",
  head_sha: "",
  run_nonce: "",
  fixtures: {},
  checks: Object.fromEntries(THEME_CHECK_NAMES.map((name) => [name, false])),
  theme_metrics: {},
  action_stage: "not_started",
  browser_cleanup: { confirmed: false },
};

class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new SafeFailure(code);
};

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const accessibleNameHelpers = `
const normalizeName = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
const textForName = (node) => {
  if (node?.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node?.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node;
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return "";
  return [...element.childNodes].map(textForName).join(" ");
};
const accessibleName = (element) => {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    if (referenced.length) return normalizeName(referenced.map(textForName).join(" "));
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalizeName(ariaLabel);
  let labels = element.labels ? [...element.labels] : [];
  if (labels.length === 0 && element.id) {
    labels = [...document.querySelectorAll("label[for]")].filter((label) => label.htmlFor === element.id);
  }
  if (labels.length) return normalizeName(labels.map(textForName).join(" "));
  if (element.tagName === "BUTTON" || element.getAttribute("role") === "button" || element.getAttribute("role") === "checkbox")
    return normalizeName(textForName(element));
  return "";
};
const visible = (element) => {
  for (let node = element; node instanceof Element; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
};
const companyForms = () => [...document.querySelectorAll("form")].filter((form) => {
  if (!visible(form)) return false;
  const names = [...form.querySelectorAll('input[type="text"],input:not([type]),textarea,[role="textbox"]')]
    .filter((control) => visible(control) && accessibleName(control) === "Company name");
  const types = [...form.querySelectorAll('[role="group"]')]
    .filter((group) => visible(group) && accessibleName(group) === "Company type");
  return names.length === 1 && types.length === 1;
});
`;

function safeReason(error, fallback = "internal_error") {
  if (error instanceof SafeFailure) return error.code;
  return fallback;
}

function parseInputs() {
  const rawOrigin = process.env.VORTEX_PREVIEW_BASE_URL ?? "";
  const originMatch = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(rawOrigin);
  if (!originMatch) fail("invalid_origin");
  const explicitPort = Number(originMatch[2]);
  if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535) fail("invalid_origin");
  let parsedOrigin;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch {
    fail("invalid_origin");
  }
  if (
    parsedOrigin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsedOrigin.hostname) ||
    parsedOrigin.username !== "" ||
    parsedOrigin.password !== "" ||
    parsedOrigin.search !== "" ||
    parsedOrigin.hash !== ""
  )
    fail("invalid_origin");

  const rawHeadSha = process.env.VORTEX_PREVIEW_HEAD_SHA ?? "";
  if (!/^[0-9a-f]{40}$/i.test(rawHeadSha)) fail("invalid_head_sha");

  const rawNonce = process.env.VORTEX_PREVIEW_RUN_NONCE ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawNonce)) fail("invalid_run_nonce");

  const rawFixtures = process.env.VORTEX_PREVIEW_FIXTURE_FINGERPRINTS ?? "";
  if (rawFixtures.length > 32_768) fail("invalid_fixture_fingerprints");
  let fixtureMap;
  try {
    fixtureMap = JSON.parse(rawFixtures);
  } catch {
    fail("invalid_fixture_fingerprints");
  }
  if (
    fixtureMap === null ||
    typeof fixtureMap !== "object" ||
    Array.isArray(fixtureMap) ||
    Object.getPrototypeOf(fixtureMap) !== Object.prototype
  )
    fail("invalid_fixture_fingerprints");
  const fixtureEntries = Object.entries(fixtureMap);
  if (fixtureEntries.length > 64) fail("invalid_fixture_fingerprints");
  for (const [path, fingerprint] of fixtureEntries) {
    const segments = path.split(/[\\/]/);
    if (
      path.length === 0 ||
      path.length > 512 ||
      /[\u0000-\u001f]/.test(path) ||
      /^[a-z]:/i.test(path) ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      segments.some((segment) => [".git", "node_modules"].includes(segment.toLowerCase())) ||
      typeof fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/i.test(fingerprint)
    )
      fail("invalid_fixture_fingerprints");
  }

  const screenshotOutput = process.env.VORTEX_PREVIEW_SCREENSHOT_OUTPUT;
  const screenshotStateDir = process.env.VORTEX_PREVIEW_SCREENSHOT_STATE_DIR;
  let screenshotTarget = null;
  if (screenshotOutput !== undefined || screenshotStateDir !== undefined) {
    if (
      typeof screenshotOutput !== "string" || screenshotOutput.length === 0 || screenshotOutput.length > 4096 ||
      typeof screenshotStateDir !== "string" || screenshotStateDir.length === 0 || screenshotStateDir.length > 4096 ||
      !isAbsolute(screenshotOutput) || !isAbsolute(screenshotStateDir) ||
      [screenshotOutput, screenshotStateDir].some((path) => path.split(/[\\/]/).some((segment) => segment === "." || segment === ".."))
    )
      fail("screenshot_artifact_failed");
    const outputPath = resolve(screenshotOutput);
    const statePath = resolve(screenshotStateDir);
    const samePath = process.platform === "win32"
      ? outputPath.toLowerCase() === resolve(statePath, basename(outputPath)).toLowerCase()
      : dirname(outputPath) === statePath;
    const base = basename(outputPath);
    const reserved = new Set([
      "CON", "PRN", "AUX", "NUL",
      ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    ]);
    if (
      !samePath || !SCREENSHOT_BASENAME_PATTERN.test(base) ||
      reserved.has(base.slice(0, -4).toUpperCase())
    )
      fail("screenshot_artifact_failed");
    screenshotTarget = { outputPath, statePath };
  }

  result.head_sha = rawHeadSha;
  result.run_nonce = rawNonce;
  return { origin: parsedOrigin.origin, headSha: rawHeadSha, fixtureMap, screenshotTarget };
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function assertRegularPathWithoutReparse(pathname, { directory = false } = {}) {
  const absolute = resolve(pathname);
  const root = parse(absolute).root;
  let cursor = root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  if (parts.length === 0) fail("screenshot_artifact_failed");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      fail("screenshot_artifact_failed");
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
      fail("screenshot_artifact_failed");
    let actual;
    try {
      actual = await realpath(cursor);
    } catch {
      fail("screenshot_artifact_failed");
    }
    if (!samePath(actual, cursor)) fail("screenshot_artifact_failed");
    if (index === parts.length - 1 && directory && !info.isDirectory())
      fail("screenshot_artifact_failed");
  }
  return absolute;
}

async function verifyScreenshotTarget(target) {
  if (!target) return;
  const statePath = await assertRegularPathWithoutReparse(target.statePath, { directory: true });
  const outputPath = resolve(target.outputPath);
  if (!samePath(dirname(outputPath), statePath)) fail("screenshot_artifact_failed");
  try {
    await lstat(outputPath);
    fail("screenshot_artifact_failed");
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    if (error?.code !== "ENOENT") fail("screenshot_artifact_failed");
  }
}

function verifyCandidateHead(headSha) {
  const git = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 4_096,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (git.error || git.status !== 0 || !/^[0-9a-f]{40}$/i.test(git.stdout.trim()))
    fail("candidate_head_unavailable");
  if (git.stdout.trim().toLowerCase() !== headSha.toLowerCase()) fail("candidate_head_mismatch");
}

async function verifyFixtureContents(fixtureMap) {
  const candidateRoot = await realpath(process.cwd()).catch(() => fail("candidate_checkout_unavailable"));
  let totalBytes = 0;
  for (const [fixturePath, expectedFingerprint] of Object.entries(fixtureMap)) {
    if (Date.now() >= runDeadline) fail("run_timeout");
    const segments = fixturePath.split(/[\\/]/);
    const candidatePath = resolve(candidateRoot, ...segments);
    const unresolvedPath = relative(candidateRoot, candidatePath);
    if (
      unresolvedPath === "" ||
      unresolvedPath === ".." ||
      unresolvedPath.startsWith(`..${sep}`) ||
      isAbsolute(unresolvedPath)
    )
      fail("invalid_fixture_fingerprints");

    let fixtureRealPath;
    let fixtureInfo;
    try {
      fixtureRealPath = await realpath(candidatePath);
      fixtureInfo = await lstat(candidatePath);
    } catch {
      fail("fixture_mismatch");
    }
    const resolvedPath = relative(candidateRoot, fixtureRealPath);
    if (
      fixtureInfo.isSymbolicLink() ||
      !fixtureInfo.isFile() ||
      resolvedPath === "" ||
      resolvedPath === ".." ||
      resolvedPath.startsWith(`..${sep}`) ||
      isAbsolute(resolvedPath)
    )
      fail("invalid_fixture_fingerprints");
    if (fixtureInfo.size > MAX_FIXTURE_BYTES || totalBytes + fixtureInfo.size > MAX_TOTAL_FIXTURE_BYTES)
      fail("fixture_size_limit");
    totalBytes += fixtureInfo.size;

    const hash = createHash("sha256");
    let bytesRead = 0;
    try {
      for await (const chunk of createReadStream(fixtureRealPath, { highWaterMark: 64 * 1024 })) {
        bytesRead += chunk.length;
        if (Date.now() >= runDeadline) fail("run_timeout");
        if (bytesRead > MAX_FIXTURE_BYTES) fail("fixture_size_limit");
        hash.update(chunk);
      }
    } catch (error) {
      if (error instanceof SafeFailure) throw error;
      fail("fixture_mismatch");
    }
    if (
      bytesRead !== fixtureInfo.size ||
      hash.digest("hex").toLowerCase() !== expectedFingerprint.toLowerCase()
    )
      fail("fixture_mismatch");
  }
}

function parseActivePort(contents) {
  const [rawPort, browserPath] = contents.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(browserPath ?? "")
  )
    fail("devtools_unavailable");
  return { port, browserPath };
}

// CIM inspects command lines locally but emits only sanitized process identity facts.
// The private profile path travels on stdin, never in the probe's command line.
const PROCESS_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
$profilePattern = '(?i)(?:^|\s)"?--user-data-dir="?' + [regex]::Escape([string]$spec.profile) + '(?="|\s|$)'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  $created = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }
  $commandLine = [string]$_.CommandLine
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parent_pid = [int]$_.ParentProcessId
    name = [string]$_.Name
    created_utc = $created
    profile_match = [regex]::IsMatch($commandLine, $profilePattern)
    executable_match = [string]::Equals([string]$_.ExecutablePath, [string]$spec.executable, [StringComparison]::OrdinalIgnoreCase)
  }
})
@{ rows = $rows } | ConvertTo-Json -Depth 4 -Compress
`;

function browserProcessSnapshot() {
  const probeEnvironment = {};
  for (const key of [
    "SystemRoot", "WINDIR", "PATH", "Path", "PSModulePath", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec",
  ])
    if (process.env[key] !== undefined) probeEnvironment[key] = process.env[key];
  const probe = spawnSync(
    POWERSHELL_EXECUTABLE,
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SNAPSHOT_SCRIPT],
    {
      input: JSON.stringify({ profile: profilePath, executable: EDGE_EXECUTABLE.replaceAll("/", "\\") }),
      encoding: "utf8",
      env: probeEnvironment,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (probe.error || probe.status !== 0) fail("browser_exit_unconfirmed");
  let value;
  try {
    value = JSON.parse(probe.stdout.trim());
  } catch {
    fail("browser_exit_unconfirmed");
  }
  if (!Array.isArray(value?.rows)) fail("browser_exit_unconfirmed");
  return value.rows.map((row) => {
    if (
      !Number.isInteger(row?.pid) || row.pid < 0 ||
      !Number.isInteger(row.parent_pid) || row.parent_pid < 0 ||
      typeof row.name !== "string" ||
      typeof row.profile_match !== "boolean" ||
      typeof row.executable_match !== "boolean" ||
      (row.created_utc !== null && typeof row.created_utc !== "string")
    )
      fail("browser_exit_unconfirmed");
    const createdAt = row.created_utc === null ? null : Date.parse(row.created_utc);
    if (createdAt !== null && !Number.isFinite(createdAt)) fail("browser_exit_unconfirmed");
    if (row.pid === 0) {
      // Windows reports this one OS pseudo-process in Win32_Process. It cannot
      // own Edge or a profile; every other PID-zero shape remains an error.
      if (
        row.parent_pid !== 0 || row.name !== "System Idle Process" ||
        row.profile_match || row.executable_match
      )
        fail("browser_exit_unconfirmed");
      return null;
    }
    return {
      pid: row.pid,
      parentPid: row.parent_pid,
      name: row.name,
      createdAt,
      profileMatch: row.profile_match,
      executableMatch: row.executable_match,
    };
  }).filter((row) => row !== null);
}

function includeOwnedDescendants(rows, owned) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parentCreatedAt = owned.get(row.parentPid);
      if (
        parentCreatedAt === undefined || owned.has(row.pid) ||
        row.createdAt === null || row.createdAt < parentCreatedAt
      )
        continue;
      owned.set(row.pid, row.createdAt);
      changed = true;
    }
  }
}

async function waitForOwnedBrowserRoot(deadline) {
  while (Date.now() < deadline) {
    const rows = browserProcessSnapshot();
    const candidates = rows.filter((row) =>
      row.name.toLowerCase() === "msedge.exe" && row.executableMatch && row.profileMatch &&
      row.createdAt !== null && row.createdAt >= browserSpawnStartedAt - 2_000 &&
      (row.parentPid === process.pid || row.parentPid === edgeProcess?.pid)
    );
    const covering = [];
    for (const candidate of candidates) {
      const owned = new Map([[candidate.pid, candidate.createdAt]]);
      includeOwnedDescendants(rows, owned);
      if (rows.every((row) => !row.profileMatch || owned.get(row.pid) === row.createdAt)) {
        covering.push({ candidate, owned });
      }
    }
    rootCandidateCount = candidates.length;
    coveringCandidateCount = covering.length;
    launcherCandidatePresent = candidates.some((row) => row.pid === edgeProcess?.pid);
    if (covering.length === 1) {
      ownedProcessIdentities = covering[0].owned;
      return covering[0].candidate;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("browser_start_failed");
}

async function waitForOwnedDevTools(profilePath, spawnFailed, deadline) {
  const activePortPath = join(profilePath, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (spawnFailed()) fail("browser_start_failed");
    try {
      return parseActivePort(await readFile(activePortPath, "utf8"));
    } catch {
      // The profile file can appear during Edge startup before both lines are flushed.
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("browser_start_timeout");
}

function ownedDevToolsSocket(rawSocketUrl, port, expectedPath, code) {
  let socketUrl;
  try {
    socketUrl = new URL(rawSocketUrl);
  } catch {
    fail(code);
  }
  if (
    socketUrl.protocol !== "ws:" ||
    !["127.0.0.1", "localhost"].includes(socketUrl.hostname) ||
    socketUrl.port !== String(port) ||
    socketUrl.pathname !== expectedPath ||
    socketUrl.search !== "" ||
    socketUrl.hash !== ""
  )
    fail(code);
  // Never follow a DevTools-supplied hostname. The private profile names the local port and path.
  return `ws://127.0.0.1:${port}${expectedPath}`;
}

async function waitForPageTarget(port, browserPath, deadline) {
  const base = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    try {
      const versionResponse = await fetch(`${base}/json/version`, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      });
      if (versionResponse.ok) {
        const version = await versionResponse.json();
        ownedDevToolsSocket(
          version?.webSocketDebuggerUrl,
          port,
          browserPath,
          "devtools_instance_mismatch",
        );
        const response = await fetch(`${base}/json/list`, {
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok) {
          const targets = await response.json();
          if (!Array.isArray(targets)) fail("devtools_unavailable");
          const pages = targets.filter((target) => target?.type === "page" && target.url === "about:blank");
          if (pages.length > 1) fail("devtools_target_ambiguous");
          if (pages.length === 1) {
            const pagePath = new URL(pages[0].webSocketDebuggerUrl).pathname;
            if (!/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(pagePath)) fail("devtools_unavailable");
            return ownedDevToolsSocket(
              pages[0].webSocketDebuggerUrl,
              port,
              pagePath,
              "devtools_unavailable",
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof SafeFailure) throw error;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("devtools_unavailable");
}

class DevToolsClient {
  constructor(socket, origin) {
    this.socket = socket;
    this.origin = origin;
    this.sequence = 0;
    this.pending = new Map();
    this.remoteOriginDetected = false;
    this.protocolInvalid = false;
    this.closed = false;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());
    socket.addEventListener("error", () => this.onClose());
  }

  async waitUntilOpen(deadline) {
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.socket.readyState !== WebSocket.CONNECTING) fail("browser_connect_failed");
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new SafeFailure("browser_connect_timeout")), Math.max(1, deadline - Date.now()));
      const opened = () => {
        clearTimeout(timeout);
        resolveOpen();
      };
      const failed = () => {
        clearTimeout(timeout);
        rejectOpen(new SafeFailure("browser_connect_failed"));
      };
      this.socket.addEventListener("open", opened, { once: true });
      this.socket.addEventListener("error", failed, { once: true });
      this.socket.addEventListener("close", failed, { once: true });
    });
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.invalidateProtocol();
      return;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      (message.id === undefined && typeof message.method !== "string")
    ) {
      this.invalidateProtocol();
      return;
    }
    if (message.id !== undefined) {
      if (!Number.isInteger(message.id)) {
        this.invalidateProtocol();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new SafeFailure("cdp_command_failed"));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Network.requestWillBeSent" || message.method === "Network.webSocketCreated") {
      const requestUrl = message.method === "Network.requestWillBeSent"
        ? message.params?.request?.url
        : message.params?.url;
      if (!this.allowedBrowserRequest(requestUrl)) {
        this.remoteOriginDetected = true;
        result.reason ??= "unexpected_origin";
      }
    }
    if (message.method === "Page.frameNavigated" && message.params?.frame?.parentId === undefined) {
      const frameUrl = message.params?.frame?.url;
      if (typeof frameUrl !== "string") {
        this.invalidateProtocol();
        return;
      }
      if (frameUrl !== "about:blank") {
        try {
          if (new URL(frameUrl).origin !== this.origin) {
            this.remoteOriginDetected = true;
            result.reason ??= "unexpected_origin";
          }
        } catch {
          this.remoteOriginDetected = true;
          result.reason ??= "unexpected_origin";
        }
      }
    }
  }

  invalidateProtocol() {
    this.protocolInvalid = true;
    result.reason ??= "browser_protocol_invalid";
    this.rejectPending("browser_protocol_invalid");
  }

  allowedBrowserRequest(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.href === "about:blank" || url.protocol === "data:") return true;
      if (url.protocol === "blob:") return url.origin === this.origin;
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
      // The sign-in fixture calls local Supabase on another port. A request outside
      // loopback fails the evidence; the main frame remains origin-pinned.
      return ["127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
      return false;
    }
  }

  rejectPending(code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SafeFailure(code));
    }
    this.pending.clear();
  }

  onClose() {
    this.closed = true;
    this.rejectPending("browser_disconnected");
  }

  send(method, params = {}, timeoutLimit = COMMAND_TIMEOUT_MS) {
    if (this.protocolInvalid) return Promise.reject(new SafeFailure("browser_protocol_invalid"));
    if (this.socket.readyState !== WebSocket.OPEN || this.closed) return Promise.reject(new SafeFailure("browser_disconnected"));
    const id = ++this.sequence;
    const timeoutMs = Math.max(1, Math.min(timeoutLimit, remainingRunTime()));
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new SafeFailure("command_timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCommand(new SafeFailure("browser_disconnected"));
      }
    });
  }

  async mainFrameUrl(allowBlank = false) {
    if (this.protocolInvalid) fail("browser_protocol_invalid");
    if (this.remoteOriginDetected) fail("unexpected_origin");
    const tree = await this.send("Page.getFrameTree");
    const frameUrl = tree.frameTree?.frame?.url;
    if (typeof frameUrl !== "string") fail("page_unavailable");
    if (frameUrl === "about:blank" && allowBlank) return frameUrl;
    let current;
    try {
      current = new URL(frameUrl);
    } catch {
      fail("unexpected_origin");
    }
    if (current.origin !== this.origin) fail("unexpected_origin");
    return frameUrl;
  }

  async evaluate(expression) {
    await this.mainFrameUrl();
    const guarded = `(() => { if (location.origin !== ${JSON.stringify(this.origin)}) return { __remoteOrigin: true }; return (${expression}); })()`;
    const response = await this.send("Runtime.evaluate", {
      expression: guarded,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (response.exceptionDetails || !response.result || !("value" in response.result)) fail("page_state_unavailable");
    if (response.result.value?.__remoteOrigin === true) fail("unexpected_origin");
    return response.result.value;
  }

  closeSocket() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      try {
        this.socket.close();
      } catch {
        this.closed = true;
      }
    }
  }
}

let runDeadline = 0;

function remainingRunTime() {
  return Math.max(1, runDeadline - Date.now());
}

function locatorExpression(selector, name, scope = "document", action = "inspect", value = "") {
  let setup;
  if (scope === "company-form") {
    setup = "const forms = companyForms(); const scopeCount = forms.length; const root = scopeCount === 1 ? forms[0] : document;";
  } else if (scope === "company-type") {
    setup = `const forms = companyForms(); const groups = forms.length === 1 ? [...forms[0].querySelectorAll('[role="group"]')].filter((group) => visible(group) && accessibleName(group) === "Company type") : []; const scopeCount = groups.length; const root = scopeCount === 1 ? groups[0] : document;`;
  } else {
    setup = "const scopeCount = 1; const root = document;";
  }
  let actionResult = "return { scopeCount, count, disabled, checked };";
  if (action === "click") {
    actionResult = `if (scopeCount !== 1 || count !== 1 || disabled) return { scopeCount, count, disabled, checked, clicked: false }; matches[0].click(); return { scopeCount, count, disabled, checked, clicked: true };`;
  } else if (action === "set-text") {
    actionResult = `if (scopeCount !== 1 || count !== 1 || disabled || matches[0].readOnly) return { scopeCount, count, disabled, set: false }; const element = matches[0]; const textValue = ${JSON.stringify(value)}; const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null; if (!prototype) return { scopeCount, count, disabled, set: false }; const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set; if (!setter) return { scopeCount, count, disabled, set: false }; setter.call(element, textValue); element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); return { scopeCount, count, disabled, set: element.value === textValue };`;
  }
  return `(() => { ${accessibleNameHelpers} ${setup} const matches = [...root.querySelectorAll(${JSON.stringify(selector)})].filter((element) => visible(element) && accessibleName(element) === ${JSON.stringify(name)}); const count = matches.length; const disabled = count === 1 && (matches[0].disabled === true || matches[0].getAttribute("aria-disabled") === "true"); const checked = count === 1 && (matches[0].checked === true || matches[0].getAttribute("aria-checked") === "true"); ${actionResult} })()`;
}

function customerControlProbeExpression() {
  return `(() => { ${accessibleNameHelpers}
    const maximum = 1024;
    const forms = companyForms();
    const groups = forms.length === 1
      ? [...forms[0].querySelectorAll('[role="group"]')]
          .filter((group) => visible(group) && accessibleName(group) === "Company type")
      : [];
    const scopeValid = forms.length === 1 && groups.length === 1;
    const candidates = scopeValid
      ? [...groups[0].querySelectorAll('input[type="checkbox"],[role="checkbox"]')]
      : [];
    const visibleCandidates = candidates.filter(visible);
    const namedCandidates = candidates.filter((element) => accessibleName(element) === "Customer");
    const visibleNamed = namedCandidates.filter(visible);
    const disabledNamed = visibleNamed.filter((element) =>
      element.disabled === true || element.getAttribute("aria-disabled") === "true");
    const labels = scopeValid
      ? [...groups[0].querySelectorAll("label")]
          .filter((label) => visible(label) && normalizeName(textForName(label)) === "Customer")
      : [];
    const counts = {
      form_count: forms.length,
      group_count: groups.length,
      checkbox_candidate_count: candidates.length,
      visible_candidate_count: visibleCandidates.length,
      customer_name_match_count: namedCandidates.length,
      visible_customer_match_count: visibleNamed.length,
      disabled_customer_match_count: disabledNamed.length,
      visible_customer_label_count: labels.length,
    };
    const capped = Object.values(counts).some((count) => count > maximum);
    return {
      ...Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, Math.min(count, maximum)])),
      capped,
      scope_valid: scopeValid,
    };
  })()`;
}

const customerVisibilityFlags = [
  "self_hidden", "self_aria_hidden", "ancestor_hidden", "ancestor_aria_hidden",
  "self_display_none", "ancestor_display_none", "self_visibility_hidden", "ancestor_visibility_hidden",
  "self_opacity_zero", "ancestor_opacity_zero", "no_client_rect", "zero_rect_width",
  "zero_rect_height", "computed_display_inline", "has_checkbox_class", "has_inline_style",
];

function customerVisibilityProbeExpression() {
  return `(() => { ${accessibleNameHelpers}
    const maximum = 1024;
    const flags = ${JSON.stringify(customerVisibilityFlags)};
    const forms = companyForms();
    const groups = forms.length === 1
      ? [...forms[0].querySelectorAll('[role="group"]')]
          .filter((group) => visible(group) && accessibleName(group) === "Company type")
      : [];
    const roots = groups.length === 1
      ? [...groups[0].querySelectorAll('[role="checkbox"][data-slot="checkbox"]')]
          .filter((root) => {
            if (accessibleName(root) !== "Customer") return false;
            const field = root.closest('[data-slot="field"][role="group"]');
            if (!field || !groups[0].contains(field)) return false;
            if (field.querySelectorAll('[role="checkbox"][data-slot="checkbox"]').length !== 1) return false;
            return [...field.querySelectorAll("label")].some((label) =>
              visible(label) && normalizeName(textForName(label)) === "Customer" &&
              label.htmlFor !== "" &&
              [...field.querySelectorAll('input[type="checkbox"]')].some((input) => input.id === label.htmlFor));
          })
      : [];
    const count = roots.length;
    const unique = count === 1;
    const probe = {
      semantic_root_count: Math.min(count, maximum), capped: count > maximum,
      semantic_root_unique: unique,
      ...Object.fromEntries(flags.map((name) => [name, null])),
    };
    if (!unique) return probe;
    const root = roots[0];
    const ancestors = [];
    for (let node = root.parentElement; node instanceof Element; node = node.parentElement) ancestors.push(node);
    const rootStyle = getComputedStyle(root);
    const ancestorStyles = ancestors.map((node) => getComputedStyle(node));
    const rect = root.getBoundingClientRect();
    return {
      ...probe,
      self_hidden: root.hidden,
      self_aria_hidden: root.getAttribute("aria-hidden") === "true",
      ancestor_hidden: ancestors.some((node) => node.hidden),
      ancestor_aria_hidden: ancestors.some((node) => node.getAttribute("aria-hidden") === "true"),
      self_display_none: rootStyle.display === "none",
      ancestor_display_none: ancestorStyles.some((style) => style.display === "none"),
      self_visibility_hidden: rootStyle.visibility === "hidden",
      ancestor_visibility_hidden: ancestorStyles.some((style) => style.visibility === "hidden"),
      self_opacity_zero: rootStyle.opacity === "0",
      ancestor_opacity_zero: ancestorStyles.some((style) => style.opacity === "0"),
      no_client_rect: root.getClientRects().length === 0,
      zero_rect_width: rect.width <= 0,
      zero_rect_height: rect.height <= 0,
      computed_display_inline: rootStyle.display === "inline",
      has_checkbox_class: root.classList.contains("cn-checkbox"),
      has_inline_style: root.hasAttribute("style"),
    };
  })()`;
}

async function captureCustomerControlProbe() {
  if (result.action_stage !== "customer_control" || !devtools) return;
  try {
    const probe = await devtools.evaluate(customerControlProbeExpression());
    const names = [
      "form_count", "group_count", "checkbox_candidate_count", "visible_candidate_count",
      "customer_name_match_count", "visible_customer_match_count",
      "disabled_customer_match_count", "visible_customer_label_count",
    ];
    if (
      !probe || typeof probe !== "object" ||
      typeof probe.capped !== "boolean" || typeof probe.scope_valid !== "boolean" ||
      names.some((name) => !Number.isInteger(probe[name]) || probe[name] < 0 || probe[name] > 1024) ||
      probe.scope_valid !== (probe.form_count === 1 && probe.group_count === 1) ||
      (!probe.scope_valid && names.slice(2).some((name) => probe[name] !== 0))
    ) return;
    result.customer_control_probe = Object.fromEntries([
      ...names.map((name) => [name, probe[name]]),
      ["capped", probe.capped], ["scope_valid", probe.scope_valid],
    ]);
    if (!probe.scope_valid) return;
    try {
      const visibility = await devtools.evaluate(customerVisibilityProbeExpression());
      if (
        !visibility || typeof visibility !== "object" ||
        !Number.isInteger(visibility.semantic_root_count) ||
        visibility.semantic_root_count < 0 || visibility.semantic_root_count > 1024 ||
        typeof visibility.capped !== "boolean" ||
        (visibility.capped && visibility.semantic_root_count !== 1024) ||
        typeof visibility.semantic_root_unique !== "boolean" ||
        visibility.semantic_root_unique !== (visibility.semantic_root_count === 1 && !visibility.capped) ||
        customerVisibilityFlags.some((name) =>
          visibility.semantic_root_unique
            ? typeof visibility[name] !== "boolean"
            : visibility[name] !== null)
      ) return;
      result.customer_visibility_probe = Object.fromEntries([
        ["semantic_root_count", visibility.semantic_root_count],
        ["capped", visibility.capped],
        ["semantic_root_unique", visibility.semantic_root_unique],
        ...customerVisibilityFlags.map((name) => [name, visibility[name]]),
      ]);
    } catch {
      // Failure-only visibility evidence must not replace the original failure.
    }
  } catch {
    // A failed diagnostic read cannot replace the original browser failure.
  }
}

async function waitFor(expression, timeoutMs, timeoutCode = "step_timeout") {
  const deadline = Math.min(Date.now() + timeoutMs, runDeadline);
  while (Date.now() < deadline) {
    if (result.checks.sign_in || result.checks.companies_list || result.checks.new_company)
      await devtools.mainFrameUrl();
    if (await devtools.evaluate(expression)) return;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail(timeoutCode);
}

let devtools;

async function waitForUniqueControl(selector, name, scope, timeoutMs) {
  const deadline = Math.min(Date.now() + timeoutMs, runDeadline);
  while (Date.now() < deadline) {
    await devtools.mainFrameUrl();
    const found = await devtools.evaluate(locatorExpression(selector, name, scope));
    if (found.scopeCount > 1 || found.count > 1) fail("ambiguous_control");
    if (found.scopeCount === 1 && found.count === 1 && !found.disabled) return;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("required_control_unavailable");
}

async function clickUniqueControl(selector, name, scope = "document") {
  const clicked = await devtools.evaluate(locatorExpression(selector, name, scope, "click"));
  if (clicked.scopeCount > 1 || clicked.count > 1) fail("ambiguous_control");
  if (clicked.scopeCount !== 1 || clicked.count !== 1 || clicked.disabled || !clicked.clicked)
    fail("required_control_unavailable");
}

async function navigateTo(pathname, expectedPath) {
  const target = new URL(pathname, currentOrigin).href;
  const response = await devtools.send("Page.navigate", { url: target });
  if (response.errorText) fail("navigation_failed");
  await waitForPathname(expectedPath, NAVIGATION_TIMEOUT_MS);
}

async function waitForPathname(expectedPath, timeoutMs) {
  const deadline = Math.min(Date.now() + timeoutMs, runDeadline);
  while (Date.now() < deadline) {
    const frameUrl = await devtools.mainFrameUrl(true);
    if (frameUrl !== "about:blank") {
      const current = new URL(frameUrl);
      if (current.pathname === expectedPath) {
        await waitFor('document.readyState === "complete"', Math.min(20_000, deadline - Date.now()));
        return;
      }
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("navigation_timeout");
}

const themeStyleHelpers = `
const metricPx = (value) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 && number <= ${MAX_THEME_METRIC_PX} ? number : null;
};
const visibleColor = (value) => {
  const color = String(value ?? "").trim().toLowerCase();
  if (!color || color === "transparent") return false;
  if (color.startsWith("rgba(")) {
    const channels = color.slice(5, -1).split(",");
    if (channels.length === 4) {
      const alpha = Number.parseFloat(channels[3]);
      return Number.isFinite(alpha) && alpha > 0;
    }
  }
  const slash = color.lastIndexOf("/");
  if (slash >= 0) {
    const alphaToken = color.slice(slash + 1).split(")")[0].trim();
    const alpha = Number.parseFloat(alphaToken);
    return Number.isFinite(alpha) && alpha > 0;
  }
  return true;
};
const makeSentinel = (parent, declarations) => {
  const sentinel = document.createElement("span");
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.style.setProperty("all", "initial", "important");
  for (const [property, value] of Object.entries({
    position: "fixed",
    left: "-10000px",
    top: "-10000px",
    display: "block",
    visibility: "hidden",
    pointerEvents: "none",
    width: "1px",
    height: "1px",
    ...declarations,
  })) sentinel.style.setProperty(property, value, "important");
  parent.appendChild(sentinel);
  return sentinel;
};
const readSentinel = (parent, property, value, computedProperty) => {
  const sentinel = makeSentinel(parent, { [property]: value });
  try {
    return getComputedStyle(sentinel).getPropertyValue(computedProperty).trim();
  } finally {
    sentinel.remove();
  }
};
const activeNavigationLink = (root, expectedPath, expectedName) => {
  const candidates = root.querySelectorAll('[data-slot="sidebar"]');
  if (candidates.length > 64) return { failed_predicate: "sidebar_scope" };
  const visibleSidebars = [...candidates].filter(visible);
  if (visibleSidebars.length !== 1) return { failed_predicate: "sidebar_scope" };
  const sidebar = visibleSidebars[0];
  const anchors = sidebar.querySelectorAll('a[data-slot="sidebar-menu-button"]');
  if (anchors.length === 0 || anchors.length > 128) return { failed_predicate: "nav_item_count" };
  const expectedHref = new URL(expectedPath, location.origin).href;
  const matches = [...anchors].filter((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href || accessibleName(anchor) !== expectedName || anchor.getAttribute("aria-current") !== "page")
      return false;
    try {
      return new URL(href, location.href).href === expectedHref;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return { failed_predicate: "current_link_count" };
  const link = matches[0];
  if (!visible(link)) return { failed_predicate: "link_not_visible" };
  if (!link.hasAttribute("data-active") || link.getAttribute("data-active") === "false")
    return { failed_predicate: "inactive_link" };
  return { link, sidebar };
};
const isMaiaRoot = (root) => root.getAttribute("data-vortex-style") === "maia" &&
  root.getAttribute("data-vortex-menu") === "default" &&
  root.getAttribute("data-vortex-menu-accent") === "bold" &&
  root.matches("[data-vortex-theme]");
const isNovaRoot = (root) => root.getAttribute("data-vortex-style") === "nova" &&
  root.getAttribute("data-vortex-menu") === "default" &&
  root.getAttribute("data-vortex-menu-accent") === "subtle" &&
  root.matches("[data-vortex-theme]");
const themeCompanyForms = (root) => {
  const forms = root.querySelectorAll("form");
  if (forms.length > 64) return null;
  return [...forms].filter((form) => {
    if (!visible(form)) return false;
    const names = [...form.querySelectorAll('input[type="text"],input:not([type]),textarea,[role="textbox"]')]
      .filter((control) => visible(control) && accessibleName(control) === "Company name");
    const types = [...form.querySelectorAll('[role="group"]')]
      .filter((group) => visible(group) && accessibleName(group) === "Company type");
    return names.length === 1 && types.length === 1;
  });
};
`;

function themePageExpression(expectedPath, body) {
  return `(() => {
    ${accessibleNameHelpers}
    ${themeStyleHelpers}
    if (location.pathname !== ${JSON.stringify(expectedPath)}) return { valid: false };
    const roots = document.querySelectorAll('[data-vortex-style-root][data-vortex-style]');
    if (roots.length !== 1) return { valid: false };
    const root = roots[0];
    ${body}
  })()`;
}

function companiesScreenshotRowExpression(expectedPath, generatedName) {
  return themePageExpression(expectedPath, `
    if (!isMaiaRoot(root)) return { retryable: false };
    const tables = root.querySelectorAll('[data-vortex-display="table"] table[data-slot="table"].cn-table');
    if (tables.length === 0) return { retryable: true };
    if (tables.length !== 1) return { retryable: false };
    const table = tables[0];
    if (!visible(table)) return { retryable: true };
    const headRows = table.querySelectorAll('thead[data-slot="table-header"] tr');
    if (headRows.length !== 1) return { retryable: headRows.length === 0 };
    const headers = headRows[0].querySelectorAll('th[data-slot="table-head"]');
    if (headers.length === 0 || headers.length > 128) return { retryable: headers.length === 0 };
    const companyHeaders = [...headers].filter((header) =>
      visible(header) && normalizeName(textForName(header)) === "Company name");
    if (companyHeaders.length === 0) return { retryable: true };
    if (companyHeaders.length !== 1) return { retryable: false };
    const header = companyHeaders[0];
    const headerIndex = header.cellIndex;
    if (!Number.isInteger(headerIndex) || headerIndex < 0 || headerIndex >= 128)
      return { retryable: false };
    const bodies = table.querySelectorAll('tbody[data-slot="table-body"]');
    if (bodies.length !== 1) return { retryable: bodies.length === 0 };
    const rows = bodies[0].querySelectorAll('tr[data-slot="table-row"]');
    if (rows.length > 128) return { retryable: false };
    if (rows.length === 0) return { retryable: true };
    const matches = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('td[data-slot="table-cell"]');
      if (cells.length > 128) return { retryable: false };
      const corresponding = [...cells].filter((cell) => cell.cellIndex === headerIndex);
      if (corresponding.length > 1) return { retryable: false };
      if (corresponding.length === 1 && String(textForName(corresponding[0]) ?? "").trim() === ${JSON.stringify(generatedName)})
        matches.push(row);
    }
    if (matches.length > 1) return { retryable: false };
    if (matches.length === 0) return { retryable: true };
    const row = matches[0];
    row.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    const rect = row.getBoundingClientRect();
    const finite = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite);
    const onScreen = finite && rect.width > 0 && rect.height > 0 &&
      rect.width <= 8192 && rect.height <= 8192 && rect.right > 0 && rect.bottom > 0 &&
      rect.left < innerWidth && rect.top < innerHeight;
    return { valid: visible(row) && onScreen };
  `);
}

async function assertCompaniesScreenshotContext(pathname) {
  const frameUrl = await devtools.mainFrameUrl();
  let current;
  try {
    current = new URL(frameUrl);
  } catch {
    fail("companies_row_unavailable");
  }
  if (current.origin !== currentOrigin) fail("unexpected_origin");
  if (current.pathname !== pathname) fail("companies_row_unavailable");
  const observation = await devtools.evaluate(themePageExpression(pathname, `
    return { valid: isMaiaRoot(root) };
  `));
  if (observation?.valid !== true) fail("companies_row_unavailable");
}

async function waitForCompaniesScreenshotRow(pathname, generatedName) {
  const deadline = Math.min(Date.now() + 30_000, runDeadline);
  const expression = companiesScreenshotRowExpression(pathname, generatedName);
  while (Date.now() < deadline) {
    const observation = await devtools.evaluate(expression);
    if (observation?.valid === true) return;
    if (observation?.retryable !== true) fail("companies_row_unavailable");
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  fail("companies_row_unavailable");
}

function validatePngBytes(bytes) {
  if (
    !Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > MAX_SCREENSHOT_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    fail("screenshot_artifact_failed");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION)
    fail("screenshot_artifact_failed");
}

async function captureCompaniesScreenshot(pathname, generatedName, target) {
  await assertCompaniesScreenshotContext(pathname);
  await waitForCompaniesScreenshotRow(pathname, generatedName);
  await assertCompaniesScreenshotContext(pathname);
  const response = await devtools.send(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false },
    Math.min(30_000, remainingRunTime()),
  );
  await assertCompaniesScreenshotContext(pathname);
  const encoded = response?.data;
  const maxEncodedLength = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
  if (
    typeof encoded !== "string" || encoded.length < 44 || encoded.length > maxEncodedLength ||
    encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    fail("screenshot_artifact_failed");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) fail("screenshot_artifact_failed");
  validatePngBytes(bytes);

  await verifyScreenshotTarget(target);
  let handle;
  try {
    handle = await openFile(target.outputPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    const fileInfo = await lstat(target.outputPath);
    const stateReal = await realpath(target.statePath);
    const fileReal = await realpath(target.outputPath);
    if (
      !opened.isFile() || fileInfo.isSymbolicLink() || !fileInfo.isFile() ||
      opened.size !== bytes.length || fileInfo.size !== bytes.length ||
      !samePath(stateReal, target.statePath) || !samePath(fileReal, target.outputPath) ||
      !samePath(dirname(fileReal), stateReal)
    )
      fail("screenshot_artifact_failed");
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    fail("screenshot_artifact_failed");
  } finally {
    try {
      await handle?.close();
    } catch {
      // The runner independently validates the artifact after this process exits.
    }
  }
  result.screenshot = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function recordThemeMetrics(measurement, names) {
  if (!measurement || typeof measurement !== "object") fail("theme_check_failed");
  for (const name of names) {
    const value = measurement[name];
    if (!Number.isFinite(value) || value <= 0 || value > MAX_THEME_METRIC_PX)
      fail("theme_check_failed");
    result.theme_metrics[name] = value;
  }
}

function requireThemeCheck(name, condition) {
  if (!THEME_CHECK_NAMES.includes(name) || condition !== true) fail("theme_check_failed");
  result.checks[name] = true;
}

async function inspectMaiaRoot(pathname) {
  const expression = themePageExpression(pathname, `
    return { valid: isMaiaRoot(root) };
  `);
  const observation = await devtools.evaluate(expression);
  requireThemeCheck("maia_root", observation?.valid);
}

async function inspectMaiaActiveMenu(pathname, comparisonKey) {
  const expression = `(() => {
    ${accessibleNameHelpers}
    ${themeStyleHelpers}
    if (location.pathname !== ${JSON.stringify(pathname)})
      return { valid: false, failed_predicate: "wrong_route" };
    const roots = document.querySelectorAll('[data-vortex-style-root][data-vortex-style]');
    if (roots.length !== 1) return { valid: false, failed_predicate: "root_count" };
    const root = roots[0];
    if (!isMaiaRoot(root)) return { valid: false, failed_predicate: "root_theme" };
    const navigation = activeNavigationLink(root, ${JSON.stringify(pathname)}, "Companies");
    if (!navigation.link) return { valid: false, failed_predicate: navigation.failed_predicate };
    const { link, sidebar } = navigation;
    const activeStyle = getComputedStyle(link);
    const menuColor = activeStyle.backgroundColor;
    const menuRadius = metricPx(activeStyle.borderTopLeftRadius);
    let accentColor = "";
    let baseRadius = null;
    try {
      accentColor = readSentinel(sidebar, "background-color", "var(--sidebar-accent)", "background-color");
      baseRadius = metricPx(readSentinel(root, "border-radius", "var(--radius)", "border-top-left-radius"));
    } catch {
      return { valid: false, failed_predicate: "sentinel_resolution" };
    }
    const colorsMatch = visibleColor(menuColor) && menuColor === accentColor;
    let persisted = false;
    try {
      if (sessionStorage.getItem(${JSON.stringify(comparisonKey)}) === null) {
        sessionStorage.setItem(${JSON.stringify(comparisonKey)}, JSON.stringify({ menuBackground: menuColor }));
        persisted = true;
      }
    } catch {
      persisted = false;
    }
    const failedPredicate = !colorsMatch
      ? (accentColor ? "menu_background" : "sentinel_resolution")
      : !persisted
        ? "comparison_state"
        : menuRadius === null || menuRadius <= 0
          ? "menu_radius"
          : baseRadius === null || baseRadius <= 0
            ? "base_radius"
            : null;
    let foregroundProbe = null;
    const foregroundSentinels = [];
    try {
      const addForegroundSentinel = (parent, declarations) => {
        const sentinel = makeSentinel(parent, { "color-scheme": "inherit", ...declarations });
        foregroundSentinels.push(sentinel);
        return sentinel;
      };
      const rootPrimaryForeground = getComputedStyle(root)
        .getPropertyValue("--sidebar-primary-foreground").trim();
      const sidebarStyle = getComputedStyle(sidebar);
      const sidebarPrimaryForeground = sidebarStyle.getPropertyValue("--sidebar-primary-foreground").trim();
      const sidebarAccentForeground = sidebarStyle.getPropertyValue("--sidebar-accent-foreground").trim();
      const anchorStyle = getComputedStyle(link);
      const anchorAccentForeground = anchorStyle.getPropertyValue("--sidebar-accent-foreground").trim();
      const accentForegroundColor = getComputedStyle(addForegroundSentinel(sidebar, {
        color: "var(--sidebar-accent-foreground)",
      })).color;
      const primaryForegroundColor = getComputedStyle(addForegroundSentinel(sidebar, {
        color: "var(--sidebar-primary-foreground)",
      })).color;
      const darkSchemeColor = getComputedStyle(addForegroundSentinel(sidebar, {
        color: "rgb(4, 5, 6)",
      })).color;
      const lightSchemeColor = getComputedStyle(addForegroundSentinel(sidebar, {
        color: "rgb(1, 2, 3)",
      })).color;
      const inheritedSchemeColor = getComputedStyle(addForegroundSentinel(sidebar, {
        color: "light-dark(rgb(1, 2, 3), rgb(4, 5, 6))",
      })).color;
      const labels = link.querySelectorAll(":scope > span");
      if (labels.length === 1 && visible(labels[0])) {
        const labelColor = getComputedStyle(labels[0]).color;
        foregroundProbe = {
          root_primary_foreground_present: rootPrimaryForeground !== "",
          sidebar_primary_foreground_present: sidebarPrimaryForeground !== "",
          sidebar_accent_foreground_present: sidebarAccentForeground !== "",
          anchor_accent_foreground_present: anchorAccentForeground !== "",
          anchor_matches_accent_foreground: sidebarAccentForeground !== "" &&
            anchorAccentForeground !== "" && accentForegroundColor !== "" &&
            anchorStyle.color === accentForegroundColor,
          label_matches_anchor: anchorStyle.color !== "" && labelColor === anchorStyle.color,
          accent_matches_primary_foreground: sidebarAccentForeground !== "" &&
            sidebarPrimaryForeground !== "" && accentForegroundColor !== "" &&
            primaryForegroundColor !== "" && accentForegroundColor === primaryForegroundColor,
          sidebar_dark_scheme_resolved: darkSchemeColor !== lightSchemeColor &&
            inheritedSchemeColor === darkSchemeColor,
        };
      }
    } catch {
      foregroundProbe = null;
    } finally {
      for (const sentinel of foregroundSentinels) {
        try {
          sentinel.remove();
        } catch {}
      }
    }
    return {
      valid: failedPredicate === null,
      ...(failedPredicate === null ? {} : { failed_predicate: failedPredicate }),
      maia_menu_radius_px: menuRadius,
      maia_base_radius_px: baseRadius,
      ...(foregroundProbe ? { maia_foreground_probe: foregroundProbe } : {}),
    };
  })()`;
  const observation = await devtools.evaluate(expression);
  if (observation?.maia_foreground_probe && typeof observation.maia_foreground_probe === "object")
    result.maia_foreground_probe = observation.maia_foreground_probe;
  if (observation?.valid === false && MAIA_ACTIVE_MENU_FAILURE_PREDICATES.has(observation.failed_predicate))
    result.maia_active_menu_failed_predicate = observation.failed_predicate;
  recordThemeMetrics(observation, ["maia_menu_radius_px", "maia_base_radius_px"]);
  requireThemeCheck("maia_active_menu", observation?.valid === true);
}

async function inspectMaiaTable(pathname) {
  const expression = themePageExpression(pathname, `
    if (!isMaiaRoot(root)) return { valid: false };
    const tableContainers = root.querySelectorAll('[data-vortex-display="table"] table[data-slot="table"].cn-table');
    if (tableContainers.length !== 1) return { valid: false };
    const table = tableContainers[0];
    const tableRect = table.getBoundingClientRect();
    if (!visible(table) || !Number.isFinite(tableRect.width) || !Number.isFinite(tableRect.height) ||
      tableRect.width <= 0 || tableRect.height <= 0 || tableRect.width > 8192 || tableRect.height > 8192)
      return { valid: false };
    const headers = table.querySelectorAll('thead[data-slot="table-header"] th[data-slot="table-head"]');
    if (headers.length === 0 || headers.length > 128) return { valid: false };
    const header = [...headers].find((candidate) => visible(candidate) && !candidate.querySelector('input[type="checkbox"],[role="checkbox"]'));
    const row = header?.closest("tr");
    if (!header || !row) return { valid: false };
    const headerStyle = getComputedStyle(header);
    const rowStyle = getComputedStyle(row);
    const inlineStart = metricPx(headerStyle.paddingInlineStart);
    const inlineEnd = metricPx(headerStyle.paddingInlineEnd);
    const expectedPadding = metricPx(readSentinel(root, "padding-inline", "calc(var(--spacing, 0.25rem) * 3)", "padding-inline-start"));
    const headerPadding = inlineStart !== null && inlineEnd !== null ? (inlineStart + inlineEnd) / 2 : null;
    const borderWidth = metricPx(rowStyle.borderBottomWidth);
    const paddingMatches = expectedPadding !== null && inlineStart !== null && inlineEnd !== null &&
      Math.abs(inlineStart - expectedPadding) <= 0.75 && Math.abs(inlineEnd - expectedPadding) <= 0.75;
    return {
      valid: paddingMatches && rowStyle.borderBottomStyle === "solid" && borderWidth !== null && borderWidth > 0,
      maia_table_header_padding_px: headerPadding,
      maia_table_border_px: borderWidth,
    };
  `);
  const observation = await devtools.evaluate(expression);
  recordThemeMetrics(observation, ["maia_table_header_padding_px", "maia_table_border_px"]);
  requireThemeCheck("maia_table", observation?.valid);
}

async function inspectSecondaryButton(pathname) {
  const expression = themePageExpression(pathname, `
    if (!isMaiaRoot(root)) return { valid: false };
    const buttons = root.querySelectorAll('button,[role="button"]');
    if (buttons.length > 128) return { valid: false };
    const matches = [...buttons].filter((button) => visible(button) && accessibleName(button) === "New company");
    if (matches.length !== 1) return { valid: false };
    const button = matches[0];
    const style = getComputedStyle(button);
    let expectedBackground = "";
    try {
      expectedBackground = readSentinel(root, "background-color", "var(--vortex-secondary)", "background-color");
    } catch {
      return { valid: false };
    }
    return {
      valid: button.getAttribute("data-vortex-variant") === "secondary" &&
        !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
        visibleColor(style.backgroundColor) && style.backgroundColor === expectedBackground,
    };
  `);
  const observation = await devtools.evaluate(expression);
  requireThemeCheck("secondary_button", observation?.valid);
}

async function inspectCustomerDimensions(pathname) {
  const expression = themePageExpression(pathname, `
    if (!isMaiaRoot(root)) return { valid: false };
    const forms = themeCompanyForms(root);
    if (!forms || forms.length !== 1) return { valid: false };
    const groups = forms[0].querySelectorAll('[role="group"]');
    if (groups.length > 64) return { valid: false };
    const typeGroups = [...groups].filter((group) => visible(group) && accessibleName(group) === "Company type");
    if (typeGroups.length !== 1) return { valid: false };
    const group = typeGroups[0];
    const checkboxRoots = group.querySelectorAll('[role="checkbox"][data-slot="checkbox"]');
    if (checkboxRoots.length > 64) return { valid: false };
    const customerRoots = [...checkboxRoots].filter((candidate) => accessibleName(candidate) === "Customer");
    if (customerRoots.length !== 1) return { valid: false };
    const checkbox = customerRoots[0];
    const field = checkbox.closest('[data-slot="field"][role="group"]');
    if (!field || !group.contains(field) || field.querySelectorAll('[role="checkbox"][data-slot="checkbox"]').length !== 1)
      return { valid: false };
    const labels = field.querySelectorAll("label");
    if (labels.length > 64) return { valid: false };
    const associated = [...labels].some((label) => visible(label) && normalizeName(textForName(label)) === "Customer" &&
      label.htmlFor !== "" && [...field.querySelectorAll('input[type="checkbox"]')].some((input) => input.id === label.htmlFor));
    if (!associated || !visible(checkbox)) return { valid: false };
    const style = getComputedStyle(checkbox);
    const rect = checkbox.getBoundingClientRect();
    const computedWidth = metricPx(style.width);
    const computedHeight = metricPx(style.height);
    const rectWidth = metricPx(rect.width);
    const rectHeight = metricPx(rect.height);
    return {
      valid: computedWidth !== null && computedWidth > 0 && computedHeight !== null && computedHeight > 0 &&
        rectWidth !== null && rectWidth > 0 && rectHeight !== null && rectHeight > 0,
      customer_computed_width_px: computedWidth,
      customer_computed_height_px: computedHeight,
      customer_rect_width_px: rectWidth,
      customer_rect_height_px: rectHeight,
    };
  `);
  const observation = await devtools.evaluate(expression);
  recordThemeMetrics(observation, [
    "customer_computed_width_px",
    "customer_computed_height_px",
    "customer_rect_width_px",
    "customer_rect_height_px",
  ]);
  requireThemeCheck("customer_dimensions", observation?.valid);
}

function saveRestExpression(pathname, comparisonKey, saveStateKey, positionOnly = false) {
  return themePageExpression(pathname, `
    if (!isMaiaRoot(root)) return { valid: false };
    const forms = themeCompanyForms(root);
    if (!forms || forms.length !== 1) return { valid: false };
    const candidates = forms[0].querySelectorAll('button[type="submit"],[role="button"]');
    if (candidates.length > 128) return { valid: false };
    const matches = [...candidates].filter((button) => visible(button) && accessibleName(button) === "Save");
    if (matches.length !== 1) return { valid: false };
    const button = matches[0];
    if (button.disabled || button.getAttribute("aria-disabled") === "true" ||
      button.getAttribute("data-vortex-variant") !== "primary" || Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(saveStateKey)}))
      return { valid: false };
    if (${positionOnly}) {
      button.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      return { valid: true };
    }
    if (button.matches(":hover")) return { valid: false };
    const style = getComputedStyle(button);
    let expectedBackground = "";
    try {
      expectedBackground = readSentinel(root, "background-color", "var(--vortex-primary)", "background-color");
    } catch {
      return { valid: false };
    }
    const borderWidth = metricPx(style.borderTopWidth);
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    let persisted = false;
    try {
      const prior = JSON.parse(sessionStorage.getItem(${JSON.stringify(comparisonKey)}) || "null");
      if (prior && typeof prior.menuBackground === "string" && !prior.primaryBackground) {
        sessionStorage.setItem(${JSON.stringify(comparisonKey)}, JSON.stringify({
          menuBackground: prior.menuBackground,
          primaryBackground: expectedBackground,
        }));
        persisted = true;
      }
    } catch {
      persisted = false;
    }
    const valid = inViewport && persisted && visibleColor(style.backgroundColor) &&
      style.backgroundColor === expectedBackground && visibleColor(style.color) && visibleColor(style.borderTopColor) &&
      borderWidth !== null && borderWidth > 0;
    if (valid) Object.defineProperty(window, ${JSON.stringify(saveStateKey)}, {
      value: { button, root, restBoxShadow: style.boxShadow }, configurable: true,
    });
    return { valid, x, y };
  `);
}

function saveHoverExpression(pathname, saveStateKey) {
  return themePageExpression(pathname, `
    const state = window[${JSON.stringify(saveStateKey)}];
    if (!isMaiaRoot(root) || !state || !state.button || state.root !== root ||
      !state.button.isConnected || !state.root.contains(state.button) || state.button.disabled ||
      state.button.getAttribute("data-vortex-variant") !== "primary" || !visible(state.button))
      return { valid: false, hovered: false, inset: false, changed: false, background_matches: false };
    const style = getComputedStyle(state.button);
    let expectedBackground = "";
    try {
      expectedBackground = readSentinel(state.root, "background-color", "var(--vortex-primary)", "background-color");
    } catch {
      return { valid: false, hovered: false, inset: false, changed: false, background_matches: false };
    }
    return {
      valid: true,
      hovered: state.button.matches(":hover"),
      inset: style.boxShadow.toLowerCase().includes("inset"),
      changed: style.boxShadow !== state.restBoxShadow,
      background_matches: visibleColor(style.backgroundColor) && style.backgroundColor === expectedBackground,
    };
  `);
}

async function waitForPrimaryHover(pathname, saveStateKey) {
  const deadline = Math.min(Date.now() + 2_000, runDeadline);
  while (Date.now() < deadline) {
    const observation = await devtools.evaluate(saveHoverExpression(pathname, saveStateKey));
    if (!observation?.valid) fail("theme_check_failed");
    if (observation.hovered === true && observation.inset === true && observation.changed === true &&
      observation.background_matches === true) return;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  fail("theme_check_failed");
}

function savePointerAwayExpression(pathname, saveStateKey) {
  return themePageExpression(pathname, `
    const state = window[${JSON.stringify(saveStateKey)}];
    return {
      valid: Boolean(isMaiaRoot(root) && state?.root === root && state.button?.isConnected &&
        state.root.contains(state.button) && !state.button.disabled &&
        state.button.getAttribute("data-vortex-variant") === "primary" && visible(state.button)),
      hovered: Boolean(state?.button?.matches(":hover")),
    };
  `);
}

function clearSaveStateExpression(pathname, saveStateKey) {
  return themePageExpression(pathname, `
    try {
      const state = window[${JSON.stringify(saveStateKey)}];
      if (state?.button?.isConnected && state.root?.contains(state.button)) delete state.button;
      delete window[${JSON.stringify(saveStateKey)}];
      return { valid: true };
    } catch {
      return { valid: false };
    }
  `);
}

async function inspectNovaAndCompare(pathname, comparisonKey) {
  const expression = themePageExpression(pathname, `
    if (!isNovaRoot(root)) {
      try { sessionStorage.removeItem(${JSON.stringify(comparisonKey)}); } catch {}
      return { valid: false };
    }
    const navigation = activeNavigationLink(root, ${JSON.stringify(pathname)}, "Overview");
    if (!navigation.link) {
      try { sessionStorage.removeItem(${JSON.stringify(comparisonKey)}); } catch {}
      return { valid: false };
    }
    const { link, sidebar } = navigation;
    const menuStyle = getComputedStyle(link);
    const menuColor = menuStyle.backgroundColor;
    const menuRadius = metricPx(menuStyle.borderTopLeftRadius);
    let accentColor = "";
    let primaryColor = "";
    let baseRadius = null;
    let prior = null;
    try {
      accentColor = readSentinel(sidebar, "background-color", "var(--sidebar-accent)", "background-color");
      primaryColor = readSentinel(root, "background-color", "var(--vortex-primary)", "background-color");
      baseRadius = metricPx(readSentinel(root, "border-radius", "var(--radius)", "border-top-left-radius"));
      prior = JSON.parse(sessionStorage.getItem(${JSON.stringify(comparisonKey)}) || "null");
    } catch {
      prior = null;
    } finally {
      try { sessionStorage.removeItem(${JSON.stringify(comparisonKey)}); } catch {}
    }
    const menuMatches = visibleColor(menuColor) && menuColor === accentColor && menuRadius !== null && menuRadius > 0;
    const primaryDiffers = typeof prior?.primaryBackground === "string" && visibleColor(primaryColor) &&
      prior.primaryBackground !== primaryColor;
    const menuDiffers = typeof prior?.menuBackground === "string" && visibleColor(menuColor) &&
      prior.menuBackground !== menuColor;
    return {
      valid: menuMatches && baseRadius !== null && baseRadius > 0 && primaryDiffers && menuDiffers,
      default_style_distinct: primaryDiffers && menuDiffers,
      large_radius: baseRadius !== null && baseRadius > 0 &&
        Number.isFinite(${JSON.stringify(result.theme_metrics.maia_base_radius_px ?? null)}) &&
        ${JSON.stringify(result.theme_metrics.maia_base_radius_px ?? null)} > baseRadius &&
        Math.abs(${JSON.stringify(result.theme_metrics.maia_menu_radius_px ?? null)} - menuRadius) > 0.25,
      nova_base_radius_px: baseRadius,
      nova_menu_radius_px: menuRadius,
    };
  `);
  const observation = await devtools.evaluate(expression);
  recordThemeMetrics(observation, ["nova_base_radius_px", "nova_menu_radius_px"]);
  requireThemeCheck("default_style_distinct", observation?.valid === true && observation?.default_style_distinct === true);
  requireThemeCheck("large_radius", observation?.valid === true && observation?.large_radius === true);
}

let currentOrigin = "";
let transientThemeKeys;

async function clearTransientThemeState() {
  if (!devtools || !transientThemeKeys) return;
  try {
    await devtools.evaluate(`(() => {
      try { sessionStorage.removeItem(${JSON.stringify(transientThemeKeys.comparisonKey)}); } catch {}
      try { delete window[${JSON.stringify(transientThemeKeys.saveStateKey)}]; } catch {}
      return true;
    })()`);
  } catch {
    // Owned profile removal is the final boundary if the page cannot be inspected.
  }
}

async function startBrowser(origin) {
  let executable;
  try {
    executable = await stat(EDGE_EXECUTABLE);
  } catch {
    fail("edge_not_found");
  }
  if (!executable.isFile()) fail("edge_not_found");

  profilePath = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  browserStartupPhase = "profile_created";
  browserSpawnStartedAt = Date.now();
  try {
    browserLaunchRequested = true;
    browserStartupPhase = "launch_requested";
    edgeProcess = spawn(
      EDGE_EXECUTABLE,
      [
        "--headless=new",
        "--edge-skip-compat-layer-relaunch",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profilePath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {
    spawnFailed = true;
    fail("browser_start_failed");
  }
  edgeProcess.once("spawn", () => {
    browserSpawned = true;
  });
  edgeProcess.once("error", () => {
    spawnFailed = true;
  });

  const startupDeadline = Math.min(Date.now() + STARTUP_TIMEOUT_MS, runDeadline);
  const activePort = await waitForOwnedDevTools(profilePath, () => spawnFailed, startupDeadline);
  browserStartupPhase = "devtools_port_ready";
  await waitForOwnedBrowserRoot(startupDeadline);
  browserStartupPhase = "owner_identified";
  const port = activePort.port;
  const socketUrl = await waitForPageTarget(port, activePort.browserPath, startupDeadline);
  browserStartupPhase = "page_target_ready";
  browserEndpoint = `ws://127.0.0.1:${port}${activePort.browserPath}`;
  let socket;
  try {
    socket = new WebSocket(socketUrl);
  } catch {
    fail("browser_connect_failed");
  }
  devtools = new DevToolsClient(socket, origin);
  await devtools.waitUntilOpen(startupDeadline);
  browserStartupPhase = "devtools_connected";
  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  await devtools.send("Network.enable");
  browserStartupPhase = "ready";
}

async function waitForOwnedTreeExit(deadline) {
  let clearSnapshots = 0;
  while (Date.now() < deadline) {
    const rows = browserProcessSnapshot();
    includeOwnedDescendants(rows, ownedProcessIdentities);
    const ownedStillLive = rows.some((row) => ownedProcessIdentities.get(row.pid) === row.createdAt);
    const profileStillUsed = rows.some((row) => row.profileMatch);
    const launcherStillLive = edgeProcess?.exitCode === null && edgeProcess?.signalCode === null;
    clearSnapshots = ownedStillLive || profileStillUsed || launcherStillLive ? 0 : clearSnapshots + 1;
    if (clearSnapshots >= 2) return true;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return false;
}

async function removeOwnedProfile() {
  if (!profilePath) return;
  let temporaryRoot;
  let profileRealPath;
  let profileInfo;
  try {
    temporaryRoot = await realpath(tmpdir());
    profileRealPath = await realpath(profilePath);
    profileInfo = await lstat(profilePath);
  } catch {
    fail("profile_cleanup_failed");
  }
  const relativePath = relative(temporaryRoot, profileRealPath);
  const insideTemp = relativePath !== "" && !relativePath.startsWith("..") && !relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`);
  if (
    !profileInfo.isDirectory() ||
    profileInfo.isSymbolicLink() ||
    !insideTemp ||
    dirname(profileRealPath).toLowerCase() !== temporaryRoot.toLowerCase() ||
    !basename(profileRealPath).startsWith(PROFILE_PREFIX)
  )
    fail("profile_cleanup_failed");
  try {
    await rm(profileRealPath, { recursive: true, force: false, maxRetries: 0 });
  } catch {
    fail("profile_cleanup_failed");
  }
  try {
    await lstat(profilePath);
    fail("profile_cleanup_failed");
  } catch (error) {
    if (error instanceof SafeFailure || error?.code !== "ENOENT") fail("profile_cleanup_failed");
  }
}

async function verifiedCleanupEndpoint() {
  if (!browserEndpoint) return false;
  const endpoint = new URL(browserEndpoint);
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const version = await response.json();
    ownedDevToolsSocket(
      version?.webSocketDebuggerUrl,
      Number(endpoint.port),
      endpoint.pathname,
      "devtools_instance_mismatch",
    );
    return true;
  } catch {
    return false;
  }
}

async function closeOwnedBrowser() {
  if (!profilePath) {
    result.browser_cleanup.confirmed = true;
    return;
  }
  if (!browserSpawned && (spawnFailed || !edgeProcess)) {
    await removeOwnedProfile();
    result.browser_cleanup.confirmed = true;
    return;
  }
  if (!ownedProcessIdentities) {
    devtools?.closeSocket();
    edgeProcess?.unref();
    result.reason ??= "browser_exit_unconfirmed";
    return;
  }
  const beforeClose = browserProcessSnapshot();
  includeOwnedDescendants(beforeClose, ownedProcessIdentities);
  if (beforeClose.some((row) => row.profileMatch && ownedProcessIdentities.get(row.pid) !== row.createdAt)) {
    devtools?.closeSocket();
    edgeProcess?.unref();
    result.reason ??= "browser_exit_unconfirmed";
    return;
  }
  const browserRootPid = ownedProcessIdentities.keys().next().value;
  const browserRootLive = beforeClose.some((row) =>
    row.pid === browserRootPid && ownedProcessIdentities.get(row.pid) === row.createdAt && row.profileMatch
  );
  if (browserRootLive && await verifiedCleanupEndpoint()) {
    let cleanupClient;
    try {
      const cleanupSocket = new WebSocket(browserEndpoint);
      cleanupClient = new DevToolsClient(cleanupSocket, currentOrigin);
      await cleanupClient.waitUntilOpen(Date.now() + 3_000);
      await cleanupClient.send("Browser.close", {}, 3_000);
    } catch {
      // A failed close request is not exit proof; inspect the owned process tree below.
    } finally {
      cleanupClient?.closeSocket();
    }
  }
  devtools?.closeSocket();
  if (!(await waitForOwnedTreeExit(Date.now() + 20_000))) {
    edgeProcess?.unref();
    result.reason ??= "browser_exit_unconfirmed";
    return;
  }
  await removeOwnedProfile();
  result.browser_cleanup.confirmed = true;
}

async function runBrowserCheck() {
  const inputs = parseInputs();
  const comparisonKey = `__vortex_preview_theme_${result.run_nonce}`;
  const saveStateKey = `__vortex_preview_save_${result.run_nonce}`;
  transientThemeKeys = { comparisonKey, saveStateKey };
  currentOrigin = inputs.origin;
  verifyCandidateHead(inputs.headSha);
  runDeadline = Date.now() + (inputs.screenshotTarget ? SCREENSHOT_TOTAL_TIMEOUT_MS : TOTAL_TIMEOUT_MS);
  await verifyFixtureContents(inputs.fixtureMap);
  result.fixtures = inputs.fixtureMap;
  await verifyScreenshotTarget(inputs.screenshotTarget);
  await startBrowser(currentOrigin);

  result.action_stage = "sign_in";
  const signInPath = "/auth/sign-in";
  await navigateTo(signInPath, signInPath);
  const signInButton = 'button,[role="button"]';
  await waitForUniqueControl(signInButton, "Local test sign-in (development only)", "document", 60_000);
  await clickUniqueControl(signInButton, "Local test sign-in (development only)");
  await waitFor(
    `!location.pathname.startsWith("/auth")`,
    60_000,
    "sign_in_timeout",
  );
  result.checks.sign_in = true;

  result.action_stage = "companies_list";
  const companiesPath = `${APP_PATH}/crm_companies`;
  await navigateTo(companiesPath, companiesPath);
  await waitForUniqueControl(signInButton, "New company", "document", 60_000);
  result.checks.companies_list = true;

  result.action_stage = "maia_root";
  await inspectMaiaRoot(companiesPath);
  result.action_stage = "maia_active_menu";
  await inspectMaiaActiveMenu(companiesPath, comparisonKey);
  result.action_stage = "secondary_button";
  await inspectSecondaryButton(companiesPath);

  result.action_stage = "new_company_click";
  await clickUniqueControl(signInButton, "New company");
  result.action_stage = "company_create_route";
  const createPath = `${APP_PATH}/crm_company_create`;
  await waitForPathname(createPath, 30_000);
  result.action_stage = "company_name_control";
  await waitForUniqueControl('input[type="text"],input:not([type]),textarea,[role="textbox"]', "Company name", "company-form", 30_000);
  result.action_stage = "customer_control";
  await waitForUniqueControl('input[type="checkbox"],[role="checkbox"]', "Customer", "company-type", 30_000);
  result.checks.new_company = true;
  result.action_stage = "customer_dimensions";
  await inspectCustomerDimensions(createPath);

  result.action_stage = "company_name_value";
  const name = `Codex preview ${result.run_nonce.slice(0, 20)} ${randomUUID()}`;
  const setName = await devtools.evaluate(
    locatorExpression(
      'input[type="text"],input:not([type]),textarea,[role="textbox"]',
      "Company name",
      "company-form",
      "set-text",
      name,
    ),
  );
  if (setName.scopeCount > 1 || setName.count > 1) fail("ambiguous_control");
  if (setName.scopeCount !== 1 || setName.count !== 1 || !setName.set) fail("company_name_unavailable");

  result.action_stage = "customer_value";
  const customerSelector = 'input[type="checkbox"],[role="checkbox"]';
  const customerState = await devtools.evaluate(locatorExpression(customerSelector, "Customer", "company-type"));
  if (customerState.scopeCount > 1 || customerState.count > 1) fail("ambiguous_control");
  if (customerState.scopeCount !== 1 || customerState.count !== 1 || customerState.disabled) fail("company_type_unavailable");
  if (!customerState.checked) {
    await clickUniqueControl(customerSelector, "Customer", "company-type");
    const checked = locatorExpression(customerSelector, "Customer", "company-type");
    await waitFor(`(${checked}).checked === true`, 5_000, "company_type_unavailable");
  }

  result.action_stage = "save_control";
  await waitForUniqueControl('button[type="submit"],[role="button"]', "Save", "company-form", 15_000);
  result.action_stage = "primary_rest";
  const positioned = await devtools.evaluate(saveRestExpression(createPath, comparisonKey, saveStateKey, true));
  if (positioned?.valid !== true) fail("theme_check_failed");
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 0,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  const rest = await devtools.evaluate(saveRestExpression(createPath, comparisonKey, saveStateKey));
  if (
    rest?.valid !== true || !Number.isFinite(rest.x) || !Number.isFinite(rest.y) ||
    rest.x < 0 || rest.y < 0 || rest.x > 8192 || rest.y > 8192
  )
    fail("theme_check_failed");
  requireThemeCheck("primary_rest", true);

  result.action_stage = "primary_hover";
  let pointerMayBeOverSave = false;
  let saveStateCleared = false;
  try {
    pointerMayBeOverSave = true;
    await devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rest.x,
      y: rest.y,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    await waitForPrimaryHover(createPath, saveStateKey);
    await devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 0,
      y: 0,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    const pointerAway = await devtools.evaluate(savePointerAwayExpression(createPath, saveStateKey));
    if (pointerAway?.valid !== true || pointerAway.hovered !== false) fail("theme_check_failed");
    pointerMayBeOverSave = false;
    requireThemeCheck("primary_hover", true);
  } finally {
    if (pointerMayBeOverSave) {
      try {
        await devtools.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 0,
          y: 0,
          button: "none",
          buttons: 0,
          pointerType: "mouse",
        });
      } catch {
        // The owned browser is closed by the outer lifecycle even when pointer recovery fails.
      }
    }
    try {
      const cleared = await devtools.evaluate(clearSaveStateExpression(createPath, saveStateKey));
      saveStateCleared = cleared?.valid === true;
    } catch {
      // Transient page state is not evidence and cannot replace the original failure.
    }
  }
  if (!saveStateCleared) fail("theme_check_failed");

  result.action_stage = "save_control";
  await waitForUniqueControl('button[type="submit"],[role="button"]', "Save", "company-form", 15_000);
  await clickUniqueControl('button[type="submit"],[role="button"]', "Save", "company-form");
  result.action_stage = "save_confirmation";
  const nameLiteral = JSON.stringify(name);
  await waitFor(
    `location.pathname.includes("crm_company_detail") && (document.body?.innerText ?? "").includes(${nameLiteral})`,
    90_000,
    "company_save_unconfirmed",
  );
  result.checks.save_company = true;

  result.action_stage = "maia_table";
  await navigateTo(companiesPath, companiesPath);
  await waitForCompaniesScreenshotRow(companiesPath, name);
  await inspectMaiaTable(companiesPath);

  if (inputs.screenshotTarget) {
    result.action_stage = "companies_screenshot";
    await captureCompaniesScreenshot(companiesPath, name, inputs.screenshotTarget);
  }

  result.action_stage = "default_style_comparison";
  await navigateTo(SERVICE_DESK_PATH, SERVICE_DESK_PATH);
  await inspectNovaAndCompare(SERVICE_DESK_PATH, comparisonKey);
}

async function writeResult() {
  const passed =
    result.checks.sign_in === true &&
    result.checks.companies_list === true &&
    result.checks.new_company === true &&
    result.checks.save_company === true &&
    THEME_CHECK_NAMES.every((name) => result.checks[name] === true) &&
    THEME_METRIC_NAMES.every((name) => {
      const value = result.theme_metrics[name];
      return Number.isFinite(value) && value > 0 && value <= MAX_THEME_METRIC_PX;
    }) &&
    result.browser_cleanup.confirmed === true &&
    !result.reason;
  result.result = passed ? "PASS" : "FAIL";
  if (passed) result.action_stage = "complete";
  if (!passed && !result.reason) result.reason = failureCode;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = passed ? 0 : 1;
}

let edgeProcess;
let profilePath;
let browserEndpoint = "";
let browserSpawned = false;
let spawnFailed = false;
let browserSpawnStartedAt = 0;
let ownedProcessIdentities;
let failureCode = "internal_error";
let browserLaunchRequested = false;
let browserStartupPhase = "not_started";
let rootCandidateCount = 0;
let coveringCandidateCount = 0;
let launcherCandidatePresent = false;

async function runBrowserLifecycleProbe() {
  // No application origin is contacted: Edge remains on its unique about:blank page.
  currentOrigin = "http://127.0.0.1";
  runDeadline = Date.now() + STARTUP_TIMEOUT_MS + 30_000;
  try {
    await startBrowser(currentOrigin);
  } catch (error) {
    result.reason ??= safeReason(error);
  }
  try {
    await closeOwnedBrowser();
  } catch (error) {
    result.reason ??= safeReason(error, "profile_cleanup_failed");
    devtools?.closeSocket();
    edgeProcess?.unref();
  }
  const confirmed =
    browserStartupPhase === "ready" &&
    result.browser_cleanup.confirmed === true &&
    !result.reason;
  const probeResult = {
    schema: "vortex.local-preview.browser-lifecycle.v1",
    result: confirmed ? "LIFECYCLE_CONFIRMED" : "FAIL",
    startup_phase: browserStartupPhase,
    launch_requested: browserLaunchRequested,
    launcher_spawned: browserSpawned,
    ownership_confirmed: ownedProcessIdentities !== undefined,
    root_candidate_count: rootCandidateCount,
    covering_candidate_count: coveringCandidateCount,
    launcher_candidate_present: launcherCandidatePresent,
    browser_cleanup: { confirmed: result.browser_cleanup.confirmed },
    ...(result.reason ? { reason: result.reason } : {}),
  };
  process.stdout.write(`${JSON.stringify(probeResult)}\n`);
  process.exitCode = confirmed ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(
    "Usage: node tooling/fleet/local-preview-browser.mjs [--browser-lifecycle-probe]\n" +
      "Reads VORTEX_PREVIEW_BASE_URL, VORTEX_PREVIEW_HEAD_SHA, VORTEX_PREVIEW_RUN_NONCE, and VORTEX_PREVIEW_FIXTURE_FINGERPRINTS.\n" +
      "Screenshot capture is opt-in through VORTEX_PREVIEW_SCREENSHOT_OUTPUT and VORTEX_PREVIEW_SCREENSHOT_STATE_DIR.\n" +
      "--browser-lifecycle-probe launches only about:blank and emits separate lifecycle evidence.\n" +
      "--help does not launch Edge or emit browser evidence.\n",
  );
  process.exitCode = 0;
} else if (args.length === 1 && args[0] === "--browser-lifecycle-probe") {
  await runBrowserLifecycleProbe();
} else {
  if (args.length !== 0) failureCode = "invalid_arguments";
  else {
    try {
      await runBrowserCheck();
    } catch (error) {
      failureCode = safeReason(error);
      result.reason ??= failureCode;
      await captureCustomerControlProbe();
    }
  }
  await clearTransientThemeState();
  try {
    await closeOwnedBrowser();
  } catch (error) {
    failureCode = safeReason(error, "profile_cleanup_failed");
    result.result = "FAIL";
    result.reason ??= failureCode;
    devtools?.closeSocket();
    edgeProcess?.unref();
  }
  await writeResult();
}
