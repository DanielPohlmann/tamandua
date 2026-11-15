import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSourcePath, resolvePiStateDir } from "../installer/paths.js";
import { logger } from "./logger.js";

export interface VersionStatus {
  updateAvailable: boolean;
  currentHead: string;
  remoteHead: string;
  checkedAt: string;
}

function getVersionStatusPath(): string {
  return path.join(resolvePiStateDir(), "version-status.json");
}

function execFileAsync(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30_000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}

export async function runVersionCheck(): Promise<void> {
  const sourcePath = resolveSourcePath();
  const statusPath = getVersionStatusPath();

  try {
    // Fetch latest from origin
    await execFileAsync("git", ["fetch", "origin"], sourcePath);

    // Get current HEAD hash
    const currentHead = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      sourcePath,
    );

    // Get origin/main HEAD hash
    let remoteHead = "";
    try {
      remoteHead = await execFileAsync(
        "git",
        ["rev-parse", "origin/main"],
        sourcePath,
      );
    } catch {
      // origin/main ref might not exist (e.g. no remote, different default branch)
      remoteHead = "";
    }

    // Count commits ahead/behind: left = local ahead, right = remote ahead
    const revList = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
      sourcePath,
    );
    const [ahead, behind] = revList.split("\t").map(Number);

    // remote ahead (right side > 0) = update available
    const updateAvailable = behind > 0;

    const status: VersionStatus = {
      updateAvailable,
      currentHead,
      remoteHead,
      checkedAt: new Date().toISOString(),
    };

    fs.mkdirSync(resolvePiStateDir(), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");

    logger.info("Version check completed", { updateAvailable, behind });
  } catch (err) {
    logger.warn("Version check failed", { error: String(err) });

    // Write a safe default so consumers don't see stale data
    try {
      fs.mkdirSync(resolvePiStateDir(), { recursive: true });
      fs.writeFileSync(
        statusPath,
        JSON.stringify(
          {
            updateAvailable: false,
            currentHead: "",
            remoteHead: "",
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
    } catch {
      // Cannot even write the file — nothing more we can do
    }
  }
}

export function readVersionStatus(): VersionStatus {
  const defaultStatus: VersionStatus = {
    updateAvailable: false,
    currentHead: "",
    remoteHead: "",
    checkedAt: "",
  };

  try {
    const statusPath = getVersionStatusPath();
    if (!fs.existsSync(statusPath)) return defaultStatus;

    const raw = fs.readFileSync(statusPath, "utf-8");
    const parsed = JSON.parse(raw);

    return {
      updateAvailable: Boolean(parsed.updateAvailable),
      currentHead: String(parsed.currentHead || ""),
      remoteHead: String(parsed.remoteHead || ""),
      checkedAt: String(parsed.checkedAt || ""),
    };
  } catch {
    return defaultStatus;
  }
}
