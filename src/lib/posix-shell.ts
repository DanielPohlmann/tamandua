import fs from "node:fs";
import path from "node:path";

let cachedBash: string | null | undefined;

/**
 * Git for Windows' bash.exe, or null if none is found. Skips the WSL launcher
 * in System32 and the WindowsApps alias, which run commands inside a Linux VM
 * with different paths.
 */
export function findWindowsBash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env === process.env && cachedBash !== undefined) return cachedBash;
  const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").toLowerCase();
  const candidates = [
    env.TAMANDUA_BASH?.trim(),
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).map((dir) => dir && path.join(dir, "bash.exe")),
    path.join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
  ];
  let found: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.startsWith(systemRoot) || lower.includes("\\windowsapps\\")) continue;
    try {
      if (fs.statSync(candidate).isFile()) { found = candidate; break; }
    } catch {
      // keep looking
    }
  }
  if (env === process.env) cachedBash = found;
  return found;
}

const SH_SCRIPT = /^\s*(?:"([^"]+\.sh)"|([^\s"]+\.sh))(\s.*)?$/is;

/**
 * Makes a `shell: true` command runnable on Windows when it is a `.sh` script
 * (optionally followed by arguments). cmd.exe cannot run `.sh` files and
 * falls back to the "How do you want to open this file?" dialog, so the
 * script is handed to Git Bash instead. Other commands, and every command on
 * POSIX, are returned unchanged.
 */
export function windowsShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  bash: string | null = platform === "win32" ? findWindowsBash() : null,
): string {
  if (platform !== "win32") return command;
  const match = SH_SCRIPT.exec(command);
  if (!match) return command;
  const script = (match[1] ?? match[2]).replace(/\\/g, "/");
  const rest = match[3] ?? "";
  // Without Git Bash, "bash" fails with "not recognized" instead of a dialog.
  const shell = bash ? `"${bash}"` : "bash";
  return `${shell} "${script}"${rest}`;
}
