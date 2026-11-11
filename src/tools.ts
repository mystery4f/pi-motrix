/**
 * @author mystery4f
 * Pi tools exposing the local Motrix download manager over MDXP:
 * motrix_download, motrix_tasks, motrix_task, motrix_stats.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineTool, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { mdxpCall, sleep } from "./client.js";
import { discoverMotrixEndpoint, type MotrixEndpoint } from "./discovery.js";
import { MotrixError } from "./errors.js";
import { formatEngineStatus, formatStats, taskBlock, taskLine } from "./format.js";
import {
  TERMINAL_STATUSES,
  type MdxpEngineStatus,
  type MdxpStats,
  type MdxpTask,
  type TaskGetResult,
  type TaskListResult,
  type TaskOkResult,
} from "./types.js";

const DEFAULT_SAVE_DIR = join(homedir(), "Downloads");
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_WAIT_TIMEOUT_SEC = 300;
const SAFE_DOWNLOAD_URL = /^(https?|ftps?|sftp):\/\//i;

const saveDirSchema = Type.Optional(
  Type.String({ description: `Directory to save the download into. Defaults to ${DEFAULT_SAVE_DIR}` }),
);
const selectedFilesSchema = Type.Optional(
  Type.Array(Type.Integer({ minimum: 0 }), {
    description: "File indices to select in the torrent/magnet (0-based, omit for all files)",
  }),
);
const idempotencyKeySchema = Type.Optional(
  Type.String({ description: "Optional idempotency key: submitting the same key twice reuses the existing task instead of duplicating it" }),
);
const taskIdSchema = Type.String({ description: "Task id from motrix_download or motrix_tasks" });
const waitTimeoutSchema = Type.Optional(
  Type.Integer({ minimum: 5, maximum: 3600, description: `Max seconds to block before returning (default ${DEFAULT_WAIT_TIMEOUT_SEC}); on timeout the task keeps running` }),
);

const downloadParams = Type.Object({
  urls: Type.Optional(Type.Array(Type.String(), { description: 'HTTP(S)/FTP(S)/SFTP URLs to download, joined into one task; e.g. ["https://example.com/file.zip"]. Exactly one of urls / magnet / torrentPath is required' })),
  magnet: Type.Optional(Type.String({ description: "Magnet URI (magnet:?xt=...) to download via BitTorrent" })),
  torrentPath: Type.Optional(Type.String({ description: "Path to a local .torrent file" })),
  saveDir: saveDirSchema,
  filename: Type.Optional(Type.String({ description: "Override the saved file name (URL downloads only)" })),
  connections: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Max connections per server (default: Motrix preference, typically 64 for multi-connection speed)" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Extra HTTP headers, e.g. {"referer": "https://example.com", "user-agent": "..."} (URL downloads only)' })),
  proxy: Type.Optional(Type.String({ description: 'Route this download through a proxy, e.g. "http://127.0.0.1:7890" — use it for geo-restricted, slow or proxy-only sources (URL downloads only)' })),
  selectedFiles: selectedFilesSchema,
  displayName: Type.Optional(Type.String({ description: "Display name for torrent downloads" })),
  mode: Type.Optional(Type.Union([Type.Literal("async"), Type.Literal("sync")], { description: '"async" (default): submit and return the task id immediately so the download runs in Motrix while you keep working; "sync": block until the download reaches a terminal status (progress streams to the client), then report the outcome' })),
  wait: Type.Optional(Type.Boolean({ description: "Deprecated alias for mode: wait=true means mode=\"sync\", wait=false means mode=\"async\"; mode wins when both are given" })),
  waitTimeoutSec: waitTimeoutSchema,
  idempotencyKey: idempotencyKeySchema,
});

type DownloadParams = Static<typeof downloadParams>;

function requireEndpoint(): MotrixEndpoint {
  return discoverMotrixEndpoint();
}

function countSources(params: DownloadParams): number {
  return (params.urls ? 1 : 0) + (params.magnet ? 1 : 0) + (params.torrentPath ? 1 : 0);
}

/** Resolve the sync/async choice: explicit mode wins, wait is the deprecated alias, default async. */
function isSyncMode(params: DownloadParams): boolean {
  if (params.mode !== undefined) return params.mode === "sync";
  return params.wait === true;
}

/** Build the discriminated-union payload for download/add. */
async function buildAddParams(params: DownloadParams): Promise<Record<string, unknown>> {
  const saveDir = params.saveDir ?? DEFAULT_SAVE_DIR;
  if (params.urls) {
    const bad = params.urls.filter((u) => !SAFE_DOWNLOAD_URL.test(u.trim()));
    if (bad.length > 0) {
      throw new MotrixError("RPC", `unsupported URL scheme in: ${bad.join(", ")}`, undefined, "only http(s), ftp(s) and sftp URLs are supported");
    }
    const headers = params.headers
      ? Object.entries(params.headers).map(([name, value]) => ({ name, value }))
      : undefined;
    return {
      kind: "url",
      saveDir,
      uris: params.urls.map((u) => u.trim()),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(headers ? { headers } : {}),
      ...(params.connections ? { connections: params.connections } : {}),
      ...(params.proxy ? { proxy: params.proxy } : {}),
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    };
  }
  if (params.magnet !== undefined) {
    if (!params.magnet.trim().startsWith("magnet:?")) {
      throw new MotrixError("RPC", "magnet must be a magnet: URI", undefined, "example: magnet:?xt=urn:btih:...");
    }
    return {
      kind: "magnet",
      saveDir,
      uri: params.magnet.trim(),
      ...(params.selectedFiles ? { selectedFiles: params.selectedFiles } : {}),
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    };
  }
  if (params.torrentPath !== undefined) {
    const base64 = await readFile(params.torrentPath, { encoding: "base64" });
    return {
      kind: "torrent",
      saveDir,
      base64,
      ...(params.selectedFiles ? { selectedFiles: params.selectedFiles } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    };
  }
  throw new MotrixError("RPC", "exactly one of urls, magnet or torrentPath must be provided", undefined, "pass either urls (array), a magnet URI, or a local .torrent path");
}

/** Submit to download/add, retrying once on transport failure (idempotency key makes it safe). */
async function addDownload(
  endpoint: MotrixEndpoint,
  built: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<MdxpTask> {
  try {
    return await mdxpCall<MdxpTask>(endpoint, "download/add", built, { signal });
  } catch (error) {
    if (error instanceof MotrixError && error.code === "NETWORK") {
      return await mdxpCall<MdxpTask>(endpoint, "download/add", built, { signal });
    }
    throw error;
  }
}

interface WaitOutcome {
  task: MdxpTask | null;
  timedOut: boolean;
  aborted: boolean;
}
/** Poll task/get until a terminal status, the deadline, or cancellation. */
async function waitForTask(endpoint: MotrixEndpoint, taskId: string, waitTimeoutSec: number, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<MdxpTask> | undefined): Promise<WaitOutcome> {
  const deadline = Date.now() + waitTimeoutSec * 1000;
  let last = await mdxpCall<TaskGetResult>(endpoint, "task/get", { taskId }, { signal });
  for (;;) {
    const task = last.task;
    if (!task) return { task, timedOut: false, aborted: false };
    if (TERMINAL_STATUSES.has(task.status)) return { task, timedOut: false, aborted: false };
    if (signal?.aborted) return { task, timedOut: false, aborted: true };
    if (Date.now() >= deadline) return { task, timedOut: true, aborted: false };
    const aborted = await sleep(POLL_INTERVAL_MS, signal);
    if (aborted) {
      const refreshed = await mdxpCall<TaskGetResult>(endpoint, "task/get", { taskId }, { signal }).catch(() => last);
      return { task: refreshed.task ?? task, timedOut: false, aborted: true };
    }
    last = await mdxpCall<TaskGetResult>(endpoint, "task/get", { taskId }, { signal });
    if (last.task) onUpdate?.({ content: [{ type: "text", text: taskLine(last.task) }], details: last.task });
  }
}

const motrixDownload = defineTool({
  name: "motrix_download",
  label: "Motrix: Download",
  description:
    "Download any resource to local disk through the local Motrix download manager (aria2 engine): parallel multi-connection, resumable, and it keeps running after this process exits. " +
    "The default tool for anything that must end up as a file on disk — models, datasets, videos, audio, archives, installers, disk images, torrents — and for large, slow or flaky fetches. " +
    "Use web_fetch / fetch_content instead only when the fetched content must be read in context rather than saved. " +
    "Needs the Motrix desktop app; if it is not running the call fails with an explicit instruction to start it, so try it directly instead of pre-checking.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  promptGuidelines: [
    "Default to motrix_download whenever a resource must be downloaded or saved to disk (files, videos, audio, models, datasets, archives, torrents, magnet links) — never fall back to curl, wget or a plain fetch for that.",
    "For proxy-only or geo-restricted sources, prefer motrix_download with its proxy (and headers) parameters over a shell curl: routing is per download, and the transfer still resumes and parallelizes.",
    "Prefer it for slow or blocked sources: parallel multi-connection download, resume, and per-download proxy/headers make it far more reliable than a single-connection shell command here.",
    "Pick the mode: leave the default async when the file is not needed right away (hand the task id back and use motrix_wait later); use mode=\"sync\" when the very next step needs the file on disk.",
    "When the user asks for progress or the result of a download, use motrix_wait or motrix_tasks instead of re-submitting it.",
  ],
  parameters: downloadParams,
  async execute(_toolCallId, params, signal, onUpdate) {
    const endpoint = requireEndpoint();
    const sources = countSources(params);
    if (sources !== 1) {
      throw new MotrixError("RPC", `exactly one of urls, magnet or torrentPath must be provided (got ${sources})`);
    }
    const built = await buildAddParams(params);
    const task = await addDownload(endpoint, built, signal);

    if (isSyncMode(params)) {
      const outcome = await waitForTask(
        endpoint,
        task.id,
        params.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC,
        signal,
        onUpdate,
      );
      const t = outcome.task;
      if (!t) {
        return {
          content: [{ type: "text", text: `Task ${task.id} disappeared from Motrix while waiting.` }],
          details: null,
        };
      }
      if (t.status === "error") {
        return {
          content: [{ type: "text", text: `Download failed.\n${taskBlock(t)}` }],
          details: t,
          isError: true,
        };
      }
      if (t.status === "completed" || t.status === "seeding") {
        const seededNote = t.status === "seeding" ? "\nAll data is downloaded; the torrent is now seeding in Motrix." : "";
        return {
          content: [{ type: "text", text: `Download completed.\n${taskBlock(t)}${seededNote}` }],
          details: t,
        };
      }
      const reason = outcome.aborted ? "wait was cancelled" : `wait timed out after ${params.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC}s`;
      return {
        content: [{
          type: "text",
          text: `${reason}; the task keeps running in Motrix.\n${taskBlock(t)}\nUse motrix_task (get) to check progress later.`,
        }],
        details: t,
      };
    }

    return {
      content: [{
        type: "text",
        text: `Download submitted (async; the transfer keeps running in Motrix in the background).\n${taskBlock(task)}\nTrack it with motrix_wait or motrix_task (action: get, taskId: ${task.id}), or pass mode="sync" next time to block until done.`,
      }],
      details: task,
    };
  },
});

const waitParams = Type.Object({
  taskId: taskIdSchema,
  waitTimeoutSec: waitTimeoutSchema,
});

const motrixWait = defineTool({
  name: "motrix_wait",
  label: "Motrix: Wait For Task",
  description:
    "Wait for an existing Motrix task to reach a terminal status, streaming live progress. " +
    "Use it after an async motrix_download, or for tasks already queued in Motrix; when a fresh download is needed right away, prefer motrix_download with mode=\"sync\".",
  annotations: { readOnlyHint: true },
  parameters: waitParams,
  async execute(_toolCallId, params, signal, onUpdate) {
    const endpoint = requireEndpoint();
    const outcome = await waitForTask(
      endpoint,
      params.taskId,
      params.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC,
      signal,
      onUpdate,
    );
    const t = outcome.task;
    if (!t) {
      return { content: [{ type: "text", text: `Task ${params.taskId} not found.` }], details: null };
    }
    if (t.status === "error") {
      return { content: [{ type: "text", text: `Download failed.\n${taskBlock(t)}` }], details: t, isError: true };
    }
    if (t.status === "completed" || t.status === "seeding") {
      const seededNote = t.status === "seeding" ? "\nAll data is downloaded; the torrent is now seeding in Motrix." : "";
      return { content: [{ type: "text", text: `Download completed.\n${taskBlock(t)}${seededNote}` }], details: t };
    }
    const reason = outcome.aborted ? "wait was cancelled" : `wait timed out after ${params.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC}s`;
    return {
      content: [{
        type: "text",
        text: `${reason}; the task keeps running in Motrix.\n${taskBlock(t)}\nCall motrix_wait again to keep waiting.`,
      }],
      details: t,
    };
  },
});

const tasksParams = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("queued"),
    Type.Literal("fetching_metadata"),
    Type.Literal("downloading"),
    Type.Literal("paused"),
    Type.Literal("seeding"),
    Type.Literal("finalizing"),
    Type.Literal("completed"),
    Type.Literal("error"),
  ], { description: "Filter by task status (omit for all)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max tasks to return (default 20)" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Offset for paging" })),
});

const motrixTasks = defineTool({
  name: "motrix_tasks",
  label: "Motrix: List Tasks",
  description: "List download tasks in the local Motrix download manager, newest first, with live progress. Read-only.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  parameters: tasksParams,
  async execute(_toolCallId, params, signal) {
    const endpoint = requireEndpoint();
    const result = await mdxpCall<TaskListResult>(
      endpoint,
      "task/list",
      { ...(params.status ? { status: params.status } : {}), limit: params.limit ?? 20, offset: params.offset ?? 0 },
      { signal },
    );
    const text = result.tasks.length === 0
      ? "No Motrix download tasks found."
      : [`${result.tasks.length} of ${result.total} task(s):`, ...result.tasks.map(taskLine)].join("\n");
    return { content: [{ type: "text", text }], details: result };
  },
});

type TaskControlDetails = TaskGetResult | { removed: string; deleteFiles: boolean };
const taskParams = Type.Object({
  taskId: taskIdSchema,
  action: Type.Union([Type.Literal("get"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("remove")], { description: "get: snapshot; pause/resume: control the task; remove: delete it from the list" }),
  deleteFiles: Type.Optional(Type.Boolean({ description: "With action=remove: also delete downloaded files from disk (default false)" })),
});

const motrixTask = defineTool({
  name: "motrix_task",
  label: "Motrix: Task Control",
  description: "Control one existing Motrix task (pause, resume, remove) or read its current snapshot without waiting.",
  annotations: { readOnlyHint: false, destructiveHint: true },
  parameters: taskParams,
  async execute(_toolCallId, params, signal): Promise<AgentToolResult<TaskControlDetails>> {
    const endpoint = requireEndpoint();
    if (params.action === "get") {
      const result = await mdxpCall<TaskGetResult>(endpoint, "task/get", { taskId: params.taskId }, { signal });
      if (!result.task) {
        return { content: [{ type: "text", text: `Task ${params.taskId} not found.` }], details: result };
      }
      return { content: [{ type: "text", text: taskBlock(result.task) }], details: result };
    }
    if (params.action === "pause" || params.action === "resume") {
      await mdxpCall<TaskOkResult>(endpoint, `task/${params.action}`, { taskId: params.taskId }, { signal });
      const refreshed = await mdxpCall<TaskGetResult>(endpoint, "task/get", { taskId: params.taskId }, { signal });
      const state = refreshed.task ? taskBlock(refreshed.task) : "task removed in the meantime";
      return { content: [{ type: "text", text: `Task ${params.action}d.\n${state}` }], details: refreshed };
    }
    await mdxpCall<TaskOkResult>(endpoint, "task/remove", { taskId: params.taskId, ...(params.deleteFiles ? { deleteFiles: true } : {}) }, { signal });
    return {
      content: [{ type: "text", text: `Task ${params.taskId} removed${params.deleteFiles ? " and its files deleted" : " (downloaded files kept on disk)"}.` }],
      details: { removed: params.taskId, deleteFiles: params.deleteFiles === true },
    };
  },
});

const motrixStats = defineTool({
  name: "motrix_stats",
  label: "Motrix: Stats",
  description: "Show live Motrix engine stats: total download/upload speed and active/waiting/stopped task counts. Read-only; also confirms Motrix is running.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, signal) {
    const endpoint = requireEndpoint();
    const [stats, engine] = await Promise.all([
      mdxpCall<MdxpStats>(endpoint, "stats/get", {}, { signal }),
      mdxpCall<MdxpEngineStatus>(endpoint, "engine/status", {}, { signal }),
    ]);
    return {
      content: [{ type: "text", text: `${formatStats(stats)}\n${formatEngineStatus(engine)}` }],
      details: { stats, engine },
    };
  },
});

export function registerMotrixTools(pi: ExtensionAPI): void {
  pi.registerTool(motrixDownload);
  pi.registerTool(motrixWait);
  pi.registerTool(motrixTasks);
  pi.registerTool(motrixTask);
  pi.registerTool(motrixStats);
}

