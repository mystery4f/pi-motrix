/**
 * @author mystery4f
 * Human-readable formatting of MDXP task snapshots and stats.
 */
import type { MdxpTask, MdxpStats, MdxpEngineStatus } from "./types.js";

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec)) return "";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "eta unknown";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const STATUS_LABELS: Record<MdxpTask["status"], string> = {
  queued: "queued",
  fetching_metadata: "fetching metadata",
  downloading: "downloading",
  paused: "paused",
  seeding: "seeding",
  finalizing: "finalizing",
  completed: "completed",
  error: "error",
};

/** One-line progress summary, used for list rows and streaming updates. */
export function taskLine(task: MdxpTask): string {
  const pct = `${Math.round(task.progress * 100)}%`;
  const size = `${formatBytes(task.bytesDone)} / ${formatBytes(task.bytesTotal)}`;
  const speed = task.status === "downloading" || task.status === "seeding" ? ` @ ${formatSpeed(task.speedBps)}` : "";
  const eta = task.status === "downloading" ? `, ${formatEta(task.etaSec)}` : "";
  return `[${task.id}] ${task.name} — ${STATUS_LABELS[task.status]} ${pct} (${size}${speed}${eta})`;
}

/** Multi-line detail block for a single task snapshot. */
export function taskBlock(task: MdxpTask): string {
  const lines = [
    taskLine(task),
    `type: ${task.type} · saveDir: ${task.saveDir}`,
  ];
  if (task.error) lines.push(`error: ${task.error}`);
  if (task.errorCode !== undefined) lines.push(`errorCode: ${task.errorCode}`);
  if (task.finalPath) lines.push(`finalPath: ${task.finalPath}`);
  if (task.bt) {
    lines.push(
      `bt: ${task.bt.peeds ?? "?"} peers / ${task.bt.seeds ?? "?"} seeds · ratio ${task.bt.ratio?.toFixed(2) ?? "?"}`,
    );
  }
  return lines.join("\n");
}

export function formatStats(stats: MdxpStats): string {
  return [
    `total download speed: ${formatSpeed(stats.totalDownloadSpeed) || "0 B/s"}`,
    `total upload speed: ${formatSpeed(stats.totalUploadSpeed) || "0 B/s"}`,
    `tasks: ${stats.activeTasks} active · ${stats.waitingTasks} waiting · ${stats.stoppedTasks} stopped`,
  ].join("\n");
}

export function formatEngineStatus(engine: MdxpEngineStatus): string {
  const features = engine.featureReport?.features?.length
    ? `features: ${engine.featureReport.features.join(", ")}`
    : "features: unknown";
  const version = engine.featureReport?.version ? `version ${engine.featureReport.version}` : "";
  const persistence = engine.featureReport?.hasSqlitePersistence === true ? "sqlite persistence: yes" : "sqlite persistence: no";
  return [`engine state: ${engine.state}`, version, features, persistence].filter(Boolean).join("\n");
}
