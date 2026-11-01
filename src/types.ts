/**
 * @author mystery4f
 * Shared MDXP data shapes (subset used by the tools).
 */

export interface MdxpTask {
  id: string;
  type: "http" | "ftp" | "bt" | "magnet" | "metalink";
  name: string;
  status:
    | "queued"
    | "fetching_metadata"
    | "downloading"
    | "paused"
    | "seeding"
    | "finalizing"
    | "completed"
    | "error";
  progress: number;
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number | null;
  etaSec: number | null;
  saveDir: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  finalPath: string | null;
  infoHash?: string;
  bt?: { peeds?: number; seeds?: number; ratio?: number; trackers?: number };
  errorCode?: string;
}

export interface TaskListResult {
  tasks: MdxpTask[];
  total: number;
}

export interface TaskGetResult {
  task: MdxpTask | null;
}

export interface TaskOkResult {
  ok: true;
}

export interface MdxpStats {
  totalDownloadSpeed: number;
  totalUploadSpeed: number;
  activeTasks: number;
  waitingTasks: number;
  stoppedTasks: number;
}

export interface MdxpEngineStatus {
  state: string;
  featureReport?: {
    version?: string;
    features?: string[];
    hasSqlitePersistence?: boolean;
  };
}

/** Terminal statuses for the wait loop; `seeding` means all data is on disk. */
export const TERMINAL_STATUSES: ReadonlySet<MdxpTask["status"]> = new Set([
  "completed",
  "error",
  "seeding",
]);
