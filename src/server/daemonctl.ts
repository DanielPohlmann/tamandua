/**
 * Tamandua Dashboard Daemon Lifecycle Controller
 *
 * Manages the lifecycle of the tamandua dashboard daemon process.
 *
 * - PID file:    ~/.tamandua/tamandua.pid
 * - Port file:   ~/.tamandua/port
 * - Log file:    ~/.tamandua/dashboard.log
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "./mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "./control-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STARTUP_ERROR_TAIL_LINES = 20;
const START_LOCK_STALE_MS = 30_000;

// ── MCP file paths ─────────────────────────────────────────────────

function defaultTamanduaDir(): string {
  return path.join(process.env.HOME?.trim() || os.homedir(), ".tamandua");
}

export const MCP_PID_FILE = path.join(defaultTamanduaDir(), "mcp.pid");
export const MCP_PORT_FILE = path.join(defaultTamanduaDir(), "mcp-port");

// ── Control plane file paths ──────────────────────────────────────

export const CONTROL_PLANE_PID_FILE = path.join(defaultTamanduaDir(), "control-plane.pid");
export const CONTROL_PLANE_PORT_FILE = path.join(defaultTamanduaDir(), "control-plane-port");
export const CONTROL_PLANE_LOG_FILE = path.join(defaultTamanduaDir(), "control-plane.log");

export interface DaemonctlPathOptions {
  /**
   * When set, use this directory instead of ~/.tamandua for PID, port,
   * and log files. Tests should use this to avoid touching live state.
   */
  homeDir?: string;
}

// ── File path helpers ───────────────────────────────────────────────

function getTamanduaDir(opts?: DaemonctlPathOptions): string {
  return opts?.homeDir ? path.join(opts.homeDir, ".tamandua") : defaultTamanduaDir();
}

export function getPidFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "tamandua.pid");
}

export function getPortFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "port");
}

export function getLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "dashboard.log");
}

function getStartLockFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "daemon-start.lock");
}

export function getMcpPidFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "mcp.pid");
}

export function getMcpPortFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "mcp-port");
}

function getMcpLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "mcp.log");
}

export function getControlPlanePidFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "control-plane.pid");
}

export function getControlPlanePortFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "control-plane-port");
}

export function getControlPlaneLogFile(opts?: DaemonctlPathOptions): string {
  return path.join(getTamanduaDir(opts), "control-plane.log");
}

function readLogTail(logPath: string = getLogFile(), lines = STARTUP_ERROR_TAIL_LINES): string {
  try {
    if (!fs.existsSync(logPath)) return "";
    const content = fs.readFileSync(logPath, "utf-8").trim();
    if (!content) return "";
    return content.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ── Port management ─────────────────────────────────────────────────

export function readPort(opts?: DaemonctlPathOptions): number {
  try {
    const raw = fs.readFileSync(getPortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return 3334; // default
}

export function writePort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getPortFile(opts), String(port), "utf-8");
}

// ── Process status ──────────────────────────────────────────────────

/**
 * Check if a process is running by reading its PID file and testing
 * with kill(0). Cleans up stale PID files on mismatch.
 */
function checkPidFile(pidFile: string): { running: true; pid: number } | { running: false } {
  if (!fs.existsSync(pidFile)) return { running: false };

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
  } catch {
    return { running: false };
  }

  try {
    // kill(pid, 0) doesn't send a signal — it just checks if the process exists
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process doesn't exist — clean up stale PID file
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Best effort
    }
    return { running: false };
  }
}

function processHomeMatches(pid: number, homeDir: string): boolean {
  try {
    const environ = fs.readFileSync(`/proc/${pid}/environ`);
    for (const entry of environ.toString("utf-8").split("\0")) {
      if (entry === `HOME=${homeDir}`) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function canSignalPid(pid: number, opts?: DaemonctlPathOptions): boolean {
  return !opts?.homeDir || processHomeMatches(pid, opts.homeDir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireStartLock(lockFile: string): number | null {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    return fs.openSync(lockFile, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;

    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > START_LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        return fs.openSync(lockFile, "wx", 0o600);
      }
    } catch {
      try {
        return fs.openSync(lockFile, "wx", 0o600);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function releaseStartLock(fd: number | null, lockFile: string): void {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

async function waitForDaemonPid(
  pidFile: string,
  portFile: string,
  requestedPort: number,
  timeoutMs = 10_000,
): Promise<{ pid: number; port: number } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = checkPidFile(pidFile);
    if (status.running) {
      let existingPort = requestedPort;
      try {
        const raw = fs.readFileSync(portFile, "utf-8").trim();
        const p = parseInt(raw, 10);
        if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
      } catch {
        // Use requested port.
      }
      return { pid: status.pid, port: existingPort };
    }
    await sleep(100);
  }
  return null;
}

/**
 * Check if the daemon process is running.
 * Uses PID file and kill(0) for existence check.
 */
export function isRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  return checkPidFile(getPidFile(opts));
}

/**
 * Get daemon status (dashboard only — MCP is independently managed).
 */
export function getDaemonStatus(opts?: DaemonctlPathOptions): { running: false; pid: null; port: number } | { running: true; pid: number; port: number } {
  const status = isRunning(opts);
  if (!status.running) {
    return { running: false, pid: null, port: readPort(opts) };
  }

  return {
    running: true,
    pid: status.pid,
    port: readPort(opts),
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Options for startDaemon / startMcp. */
export interface StartOptions extends DaemonctlPathOptions {
  /**
   * When true, skips child.unref() and includes the ChildProcess handle
   * in the return value. Callers can use child.kill() for direct cleanup.
   * Default: false (production detached/unref behavior).
   */
  keepHandle?: boolean;
  /**
   * When set, also passed as HOME to the spawned child process.
   */
}

export type StartControlPlaneResult = {
  pid: number;
  port: number;
  alreadyRunning?: boolean;
};

/**
 * Start the dashboard daemon.
 *
 * Spawns a detached node process running dist/server/daemon.js.
 * Writes the port to ~/.tamandua/port before spawning.
 *
 * If the daemon is already running, returns its info without restarting.
 *
 * @param port  Dashboard port (default 3334).
 * @param opts  When keepHandle is true, returns the ChildProcess handle.
 */
export async function startDaemon(port?: number): Promise<{ pid: number; port: number }>;
export async function startDaemon(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startDaemon(port = 3334, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const pidFile = getPidFile(opts);
  const portFile = getPortFile(opts);
  const logFile = getLogFile(opts);
  const lockFile = getStartLockFile(opts);

  const status = checkPidFile(pidFile);
  if (status.running) {
    let existingPort = port;
    try {
      const raw = fs.readFileSync(portFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use the requested port
    }
    return { pid: status.pid, port: existingPort };
  }

  fs.mkdirSync(tamanduaDir, { recursive: true });
  const lockFd = acquireStartLock(lockFile);
  if (lockFd === null) {
    const existing = await waitForDaemonPid(pidFile, portFile, port);
    if (existing) return existing;
    throw new Error("Timed out waiting for another daemon start attempt to finish.");
  }

  try {
    const recheck = checkPidFile(pidFile);
    if (recheck.running) {
      let existingPort = port;
      try {
        const raw = fs.readFileSync(portFile, "utf-8").trim();
        const p = parseInt(raw, 10);
        if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
      } catch {
        // Use requested port.
      }
      return { pid: recheck.pid, port: existingPort };
    }

    fs.writeFileSync(portFile, String(port), "utf-8");

    const out = fs.openSync(logFile, "a");
    const errFd = fs.openSync(logFile, "a");

    const daemonScript = path.resolve(__dirname, "daemon.js");
    const spawnOpts: Parameters<typeof spawn>[2] = {
      windowsHide: true,
      detached: true,
      stdio: ["ignore", out, errFd],
    };
    if (opts?.homeDir) {
      spawnOpts.env = { ...process.env, HOME: opts.homeDir };
    }
    const child = spawn("node", ["--disable-warning=ExperimentalWarning", daemonScript, String(port)], spawnOpts);

    if (opts?.keepHandle) {
      // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
      // Don't unref — the handle keeps the event loop alive, which is fine
      // because the caller is responsible for killing the child.
    } else {
      child.unref();
    }

    // Wait for the daemon to start and write its PID file. Poll instead of a
    // single fixed sleep: under heavy load node startup can exceed a second.
    const daemonDeadline = Date.now() + 10_000;
    let check = checkPidFile(pidFile);
    while (!check.running && Date.now() < daemonDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      check = checkPidFile(pidFile);
    }
    if (!check.running) {
      const logTail = readLogTail(logFile);
      if (logTail) {
        throw new Error(`Daemon failed to start. Recent daemon log:\n${logTail}`);
      }

      throw new Error("Daemon failed to start. Check " + logFile);
    }

    if (opts?.keepHandle) {
      return { pid: check.pid, port, child };
    }

    return { pid: check.pid, port };
  } finally {
    releaseStartLock(lockFd, lockFile);
  }
}

/**
 * Stop the dashboard daemon.
 *
 * Sends SIGTERM to the daemon process and cleans up the PID file.
 * Returns true if a daemon was stopped, false if none was running.
 */
export function stopDaemon(opts?: DaemonctlPathOptions): boolean {
  const status = isRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the daemon also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getPidFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════
// MCP standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the mcp-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "mcp-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

/**
 * Read the MCP port from the MCP port file.
 * Returns DEFAULT_MCP_PORT (3338) when no port file exists.
 */
export function readMcpPort(opts?: DaemonctlPathOptions): number {
  try {
    const raw = fs.readFileSync(getMcpPortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return DEFAULT_MCP_PORT;
}

/**
 * Write the MCP port to the MCP port file.
 */
export function writeMcpPort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getMcpPortFile(opts), String(port), "utf-8");
}

/**
 * Check if the standalone MCP server is running.
 * Uses the MCP PID file and kill(0) for existence check.
 */
export function isMcpRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  return checkPidFile(getMcpPidFile(opts));
}

/**
 * Get full MCP status.
 */
export function getMcpStatus(opts?: DaemonctlPathOptions): {
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
} {
  const status = isMcpRunning(opts);
  const port = readMcpPort(opts);
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
    endpoint: MCP_ENDPOINT_PATH,
  };
}

/**
 * Start the standalone MCP server.
 *
 * Spawns a detached node process running dist/server/mcp-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health.
 *
 * If the MCP server is already running, returns its info without restarting.
 */
export async function startMcp(port?: number): Promise<{ pid: number; port: number }>;
export async function startMcp(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startMcp(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const mcpPidFile = getMcpPidFile(opts);
  const mcpPortFile = getMcpPortFile(opts);
  const mcpLogFile = getMcpLogFile(opts);

  const status = checkPidFile(mcpPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_MCP_PORT;
    try {
      const raw = fs.readFileSync(mcpPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort };
  }

  const mcpPort = port ?? DEFAULT_MCP_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(mcpPortFile, String(mcpPort), "utf-8");

  const out = fs.openSync(mcpLogFile, "a");
  const errFd = fs.openSync(mcpLogFile, "a");

  const standaloneScript = resolveStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn("node", ["--disable-warning=ExperimentalWarning", standaloneScript, String(mcpPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait for the MCP server to start and write its PID file. Poll instead
  // of a single fixed sleep: under heavy load (e.g. the parallel test suite)
  // node startup can take well over a second.
  const deadline = Date.now() + 10_000;
  let check = checkPidFile(mcpPidFile);
  while (!check.running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    check = checkPidFile(mcpPidFile);
  }
  if (!check.running) {
    const logTail = readLogTail(mcpLogFile);
    if (logTail) {
      throw new Error(`MCP server failed to start. Recent MCP log:\n${logTail}`);
    }
    throw new Error("MCP server failed to start. Check " + mcpLogFile);
  }

  if (opts?.keepHandle) {
    return { pid: check.pid, port: mcpPort, child };
  }

  return { pid: check.pid, port: mcpPort };
}

/**
 * Stop the standalone MCP server.
 *
 * Sends SIGTERM to the MCP process and cleans up the PID file.
 * Returns true if an MCP server was stopped, false if none was running.
 */
export function stopMcp(opts?: DaemonctlPathOptions): boolean {
  const status = isMcpRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the MCP process also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getMcpPidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getMcpPortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Control plane standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

const CONTROL_PLANE_HEALTH_ENDPOINT = "/control/health";

/**
 * Resolve the control-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveControlStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "control-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

async function waitForHealthEndpoint(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not reachable yet
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for health endpoint: ${url}`);
}

async function isTcpPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function fetchControlPlaneHealth(port: number): Promise<{ healthy: true; pid: number | null } | { healthy: false; status?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL_PLANE_HEALTH_ENDPOINT}`, {
      signal: controller.signal,
    });
    if (!res.ok) return { healthy: false, status: res.status };
    let pid: number | null = null;
    try {
      const body = await res.json() as { pid?: unknown };
      if (typeof body.pid === "number" && Number.isFinite(body.pid) && body.pid > 0) {
        pid = body.pid;
      }
    } catch {
      // Treat a 2xx health response as healthy even if the body is malformed.
    }
    return { healthy: true, pid };
  } catch {
    return { healthy: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function detectExistingControlPlane(
  port: number,
  pidFile: string,
  portFile: string,
  opts?: DaemonctlPathOptions,
): Promise<StartControlPlaneResult | null> {
  const health = await fetchControlPlaneHealth(port);
  if (health.healthy) {
    if (health.pid !== null && !canSignalPid(health.pid, opts)) {
      throw new Error(
        `Port ${port} is already used by a Tamandua control plane outside the requested HOME. ` +
        `Stop the other process or choose a different port.`,
      );
    }
    if (health.pid !== null) {
      try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, String(health.pid), "utf-8");
        fs.writeFileSync(portFile, String(port), "utf-8");
      } catch {
        // Best effort; returning existing info is still better than spawning.
      }
    }
    return { pid: health.pid ?? 0, port, alreadyRunning: true };
  }

  if (await isTcpPortOpen(port)) {
    const suffix = health.status ? `; health endpoint returned HTTP ${health.status}` : "";
    throw new Error(
      `Port ${port} is already in use, but it is not a healthy Tamandua control plane${suffix}. ` +
      `Stop the other process or choose a different port.`,
    );
  }

  return null;
}

/**
 * Read the control plane port from the control plane port file.
 * Returns DEFAULT_CONTROL_PORT (3339) when no port file exists.
 */
export function readControlPlanePort(opts?: DaemonctlPathOptions): number {
  try {
    const raw = fs.readFileSync(getControlPlanePortFile(opts), "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return DEFAULT_CONTROL_PORT;
}

/**
 * Write the control plane port to the control plane port file.
 */
export function writeControlPlanePort(port: number, opts?: DaemonctlPathOptions): void {
  const tamanduaDir = getTamanduaDir(opts);
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(getControlPlanePortFile(opts), String(port), "utf-8");
}

/**
 * Check if the standalone control plane server is running.
 * Uses the control plane PID file and kill(0) for existence check.
 */
export function isControlPlaneRunning(opts?: DaemonctlPathOptions): { running: true; pid: number } | { running: false } {
  return checkPidFile(getControlPlanePidFile(opts));
}

/**
 * Get full control plane status.
 */
export function getControlPlaneStatus(opts?: DaemonctlPathOptions): {
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
} {
  const status = isControlPlaneRunning(opts);
  const port = readControlPlanePort(opts);
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
    endpoint: CONTROL_PLANE_HEALTH_ENDPOINT,
  };
}

/**
 * Start the standalone control plane server.
 *
 * Spawns a detached node process running dist/server/control-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health endpoint.
 *
 * If the control plane server is already running, returns its info without restarting.
 */
export async function startControlPlane(port?: number): Promise<StartControlPlaneResult>;
export async function startControlPlane(port: number, opts: StartOptions & { keepHandle: true }): Promise<StartControlPlaneResult & { child: ChildProcess }>;
export async function startControlPlane(port?: number, opts?: StartOptions): Promise<StartControlPlaneResult | (StartControlPlaneResult & { child: ChildProcess })> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = getTamanduaDir(opts);
  const cpPidFile = getControlPlanePidFile(opts);
  const cpPortFile = getControlPlanePortFile(opts);
  const cpLogFile = getControlPlaneLogFile(opts);

  const status = checkPidFile(cpPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_CONTROL_PORT;
    try {
      const raw = fs.readFileSync(cpPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort, alreadyRunning: true };
  }

  const cpPort = port ?? DEFAULT_CONTROL_PORT;

  const existing = await detectExistingControlPlane(cpPort, cpPidFile, cpPortFile, opts);
  if (existing) return existing;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(cpPortFile, String(cpPort), "utf-8");

  const out = fs.openSync(cpLogFile, "a");
  const errFd = fs.openSync(cpLogFile, "a");

  const standaloneScript = resolveControlStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn("node", ["--disable-warning=ExperimentalWarning", standaloneScript, String(cpPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait for the control plane to start and write its PID file. Poll instead
  // of a single fixed sleep: under heavy load node startup can exceed a second.
  const cpDeadline = Date.now() + 10_000;
  let check = checkPidFile(cpPidFile);
  while (!check.running && Date.now() < cpDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    check = checkPidFile(cpPidFile);
  }
  if (!check.running) {
    const existingAfterSpawn = await detectExistingControlPlane(cpPort, cpPidFile, cpPortFile, opts);
    if (existingAfterSpawn) return existingAfterSpawn;
    const logTail = readLogTail(cpLogFile);
    if (logTail) {
      throw new Error(`Control plane failed to start. Recent control plane log:\n${logTail}`);
    }
    throw new Error("Control plane failed to start. Check " + cpLogFile);
  }

  // Wait for health endpoint to be reachable
  await waitForHealthEndpoint(`http://127.0.0.1:${cpPort}${CONTROL_PLANE_HEALTH_ENDPOINT}`);

  if (opts?.keepHandle) {
    return { pid: check.pid, port: cpPort, child };
  }

  return { pid: check.pid, port: cpPort };
}

/**
 * Stop the standalone control plane server.
 *
 * Sends SIGTERM to the control plane process and cleans up the PID file.
 * Returns true if a control plane was stopped, false if none was running.
 */
export function stopControlPlane(opts?: DaemonctlPathOptions): boolean {
  const status = isControlPlaneRunning(opts);
  if (!status.running) return false;
  if (!canSignalPid(status.pid, opts)) return false;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the control plane also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(getControlPlanePidFile(opts));
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(getControlPlanePortFile(opts));
  } catch {
    // Best effort
  }

  return true;
}
