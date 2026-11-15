import os from "node:os";

/**
 * The user's home directory, honoring `HOME` on every platform.
 *
 * `os.homedir()` reads `USERPROFILE` on Windows and ignores `HOME`, while
 * tests (and the daemon launcher) isolate state by setting `HOME`. Resolving
 * every `~/.tamandua` path through this keeps the CLI, the daemons it spawns
 * and the tests looking at the same directory. On POSIX this is the same as
 * `os.homedir()`.
 */
export function homeDir(): string {
  return process.env.HOME?.trim() || os.homedir();
}
