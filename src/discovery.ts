/**
 * @author mystery4f
 * Locate the running Motrix desktop app via its bridge endpoint file,
 * mirroring the official `motrix` CLI discovery logic.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MotrixError } from "./errors.js";

export interface MotrixEndpoint {
  baseUrl: string;
  token: string;
}

interface BridgeEndpointFile {
  port: number;
  pid: number;
  localToken: string;
}

/** Per-platform Motrix user-data directory (same layout as the motrix CLI). */
function userDataDir(): string {
  switch (process.platform) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Motrix");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Motrix");
    default:
      return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config", "Motrix");
  }
}

/** Best-effort liveness probe: signal 0 succeeds or EPERM means the pid exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read `%APPDATA%/Motrix/bridge/endpoint.json` (platform equivalent) and return
 * the MDXP bridge base URL plus bearer token.
 *
 * Throws MotrixError("NOT_RUNNING") when Motrix is not running or the endpoint
 * file is stale/corrupt — callers should surface the "start Motrix" hint.
 */
export function discoverMotrixEndpoint(): MotrixEndpoint {
  const file = join(userDataDir(), "bridge", "endpoint.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new MotrixError(
      "NOT_RUNNING",
      `Motrix bridge endpoint file not found at ${file}`,
      undefined,
      "start the Motrix desktop app first (it writes the endpoint file on launch)",
    );
  }

  let parsed: BridgeEndpointFile;
  try {
    parsed = JSON.parse(raw) as BridgeEndpointFile;
  } catch {
    throw new MotrixError(
      "NOT_RUNNING",
      `Motrix bridge endpoint file at ${file} is corrupt`,
      undefined,
      "restart the Motrix desktop app",
    );
  }

  const { port, pid, localToken } = parsed;
  if (
    typeof port !== "number" ||
    typeof pid !== "number" ||
    typeof localToken !== "string" ||
    localToken.length === 0
  ) {
    throw new MotrixError(
      "NOT_RUNNING",
      `Motrix bridge endpoint file at ${file} is missing required fields`,
      undefined,
      "restart the Motrix desktop app",
    );
  }

  if (!pidAlive(pid)) {
    throw new MotrixError(
      "NOT_RUNNING",
      `Motrix bridge endpoint is stale (pid ${pid} is gone)`,
      undefined,
      "start the Motrix desktop app",
    );
  }

  return { baseUrl: `http://127.0.0.1:${port}`, token: localToken };
}
