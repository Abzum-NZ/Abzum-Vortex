import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SCHEMA = "vortex.local-preview.browser.v1";
const EDGE_EXECUTABLE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const POWERSHELL_EXECUTABLE = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const APP_PATH = "/abzum/abzum/vortex.app.crm";
const TOTAL_TIMEOUT_MS = 240_000;
const STARTUP_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 300;
const PROFILE_PREFIX = "vortex-preview-edge-";
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_FIXTURE_BYTES = 128 * 1024 * 1024;

const result = {
  schema: SCHEMA,
  result: "FAIL",
  head_sha: "",
  run_nonce: "",
  fixtures: {},
  checks: {},
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

  result.head_sha = rawHeadSha;
  result.run_nonce = rawNonce;
  return { origin: parsedOrigin.origin, headSha: rawHeadSha, fixtureMap };
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
    const roots = rows.filter((row) =>
      row.name.toLowerCase() === "msedge.exe" && row.executableMatch && row.profileMatch &&
      row.createdAt !== null && row.createdAt >= browserSpawnStartedAt - 2_000 &&
      (row.parentPid === process.pid || row.parentPid === edgeProcess?.pid)
    );
    if (roots.length === 1) {
      const owned = new Map([[roots[0].pid, roots[0].createdAt]]);
      includeOwnedDescendants(rows, owned);
      if (rows.every((row) => !row.profileMatch || owned.get(row.pid) === row.createdAt)) {
        ownedProcessIdentities = owned;
        return roots[0];
      }
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
        result.reason = "unexpected_origin";
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
            result.reason = "unexpected_origin";
          }
        } catch {
          this.remoteOriginDetected = true;
          result.reason = "unexpected_origin";
        }
      }
    }
  }

  invalidateProtocol() {
    this.protocolInvalid = true;
    result.reason = "browser_protocol_invalid";
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
  const deadline = Math.min(Date.now() + NAVIGATION_TIMEOUT_MS, runDeadline);
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

let currentOrigin = "";

async function startBrowser(origin) {
  let executable;
  try {
    executable = await stat(EDGE_EXECUTABLE);
  } catch {
    fail("edge_not_found");
  }
  if (!executable.isFile()) fail("edge_not_found");

  profilePath = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  browserSpawnStartedAt = Date.now();
  try {
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
  await waitForOwnedBrowserRoot(startupDeadline);
  const port = activePort.port;
  const socketUrl = await waitForPageTarget(port, activePort.browserPath, startupDeadline);
  browserEndpoint = `ws://127.0.0.1:${port}${activePort.browserPath}`;
  let socket;
  try {
    socket = new WebSocket(socketUrl);
  } catch {
    fail("browser_connect_failed");
  }
  devtools = new DevToolsClient(socket, origin);
  await devtools.waitUntilOpen(startupDeadline);
  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  await devtools.send("Network.enable");
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
  currentOrigin = inputs.origin;
  verifyCandidateHead(inputs.headSha);
  runDeadline = Date.now() + TOTAL_TIMEOUT_MS;
  await verifyFixtureContents(inputs.fixtureMap);
  result.fixtures = inputs.fixtureMap;
  await startBrowser(currentOrigin);

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

  const companiesPath = `${APP_PATH}/crm_companies`;
  await navigateTo(companiesPath, companiesPath);
  await waitForUniqueControl(signInButton, "New company", "document", 60_000);
  result.checks.companies_list = true;

  await clickUniqueControl(signInButton, "New company");
  await waitForUniqueControl('input[type="text"],input:not([type]),textarea,[role="textbox"]', "Company name", "company-form", 30_000);
  await waitForUniqueControl('input[type="checkbox"],[role="checkbox"]', "Customer", "company-type", 30_000);
  result.checks.new_company = true;

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

  const customerSelector = 'input[type="checkbox"],[role="checkbox"]';
  const customerState = await devtools.evaluate(locatorExpression(customerSelector, "Customer", "company-type"));
  if (customerState.scopeCount > 1 || customerState.count > 1) fail("ambiguous_control");
  if (customerState.scopeCount !== 1 || customerState.count !== 1 || customerState.disabled) fail("company_type_unavailable");
  if (!customerState.checked) {
    await clickUniqueControl(customerSelector, "Customer", "company-type");
    const checked = locatorExpression(customerSelector, "Customer", "company-type");
    await waitFor(`(${checked}).checked === true`, 5_000, "company_type_unavailable");
  }

  await waitForUniqueControl('button[type="submit"],[role="button"]', "Save", "company-form", 15_000);
  await clickUniqueControl('button[type="submit"],[role="button"]', "Save", "company-form");
  const nameLiteral = JSON.stringify(name);
  await waitFor(
    `location.pathname.includes("crm_company_detail") && (document.body?.innerText ?? "").includes(${nameLiteral})`,
    90_000,
    "company_save_unconfirmed",
  );
  result.checks.save_company = true;
}

async function writeResult() {
  const passed =
    result.checks.sign_in === true &&
    result.checks.companies_list === true &&
    result.checks.new_company === true &&
    result.checks.save_company === true &&
    result.browser_cleanup.confirmed === true &&
    !result.reason;
  result.result = passed ? "PASS" : "FAIL";
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

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(
    "Usage: node tooling/fleet/local-preview-browser.mjs\n" +
      "Reads VORTEX_PREVIEW_BASE_URL, VORTEX_PREVIEW_HEAD_SHA, VORTEX_PREVIEW_RUN_NONCE, and VORTEX_PREVIEW_FIXTURE_FINGERPRINTS.\n" +
      "--help does not launch Edge or emit browser evidence.\n",
  );
  process.exitCode = 0;
} else {
  if (args.length !== 0) failureCode = "invalid_arguments";
  else {
    try {
      await runBrowserCheck();
    } catch (error) {
      failureCode = safeReason(error);
      result.reason = failureCode;
    }
  }
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
