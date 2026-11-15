import fs from "node:fs";
import path from "node:path";
import { resolveTamanduaCli, resolvePiStateDir } from "./paths.js";
import { homeDir } from "../lib/home-dir.js";

/**
 * Ensure the tamandua CLI is symlinked into a directory on the user's PATH.
 *
 * Strategy (in priority order):
 * 1. ~/.local/bin — common user-local bin directory (most Linux/Mac)
 * 2. If TAMANDUA_BIN_DIR is set, use that directory
 *
 * If the symlink already exists and points to the right target, it's a no-op.
 * If it exists but points elsewhere (e.g., an older install), it's replaced.
 *
 * Returns the symlink path.
 */
export function ensureCliSymlink(): string {
  const cliPath = resolveTamanduaCli();
  const binDir = resolveBinDir();

  // Ensure the bin directory exists
  fs.mkdirSync(binDir, { recursive: true });

  const linkPath = path.join(binDir, "tamandua");

  // Check if the symlink already exists and is correct
  try {
    const existingTarget = fs.readlinkSync(linkPath);
    if (existingTarget === cliPath) {
      return linkPath; // already correct — no-op
    }
    // Wrong target — remove and recreate
    fs.unlinkSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EINVAL") {
      // Exists but is a regular file — remove it
      fs.unlinkSync(linkPath);
    }
    // ENOENT is fine — we'll create it
  }

  // Check that the CLI binary exists
  try {
    fs.accessSync(cliPath, fs.constants.R_OK);
  } catch {
    throw new Error(
      `Tamandua CLI not found at ${cliPath}. Build the project first with 'npm run build'.`,
    );
  }

  // Create the symlink
  fs.symlinkSync(cliPath, linkPath);

  return linkPath;
}

/**
 * Resolve the bin directory to use for the symlink.
 *
 * Priority:
 * 1. TAMANDUA_BIN_DIR environment variable
 * 2. ~/.local/bin (if it exists or can be created)
 * 3. Fall back to ~/.tamandua/bin
 */
function resolveBinDir(): string {
  const envDir = process.env.TAMANDUA_BIN_DIR?.trim();
  if (envDir) return envDir;

  const localBin = path.join(homeDir(), ".local", "bin");
  // Prefer ~/.local/bin if it exists, otherwise use it anyway (we'll create it)
  try {
    fs.accessSync(localBin, fs.constants.W_OK);
    return localBin;
  } catch {
    // Try to create it
    try {
      fs.mkdirSync(localBin, { recursive: true });
      return localBin;
    } catch {
      // Fall back to tamandua's own bin dir
      return path.join(resolvePiStateDir(), "bin");
    }
  }
}

/**
 * Check whether the tamandua CLI symlink is in place and correct.
 */
export function isCliSymlinked(): boolean {
  const cliPath = resolveTamanduaCli();
  const binDir = resolveBinDir();
  const linkPath = path.join(binDir, "tamandua");

  try {
    const target = fs.readlinkSync(linkPath);
    return target === cliPath;
  } catch {
    return false;
  }
}

/**
 * Remove the tamandua CLI symlink if it exists.
 */
export function removeCliSymlink(): void {
  const binDir = resolveBinDir();
  const linkPath = path.join(binDir, "tamandua");

  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return; // already gone
    throw err;
  }
}
