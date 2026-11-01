/**
 * @author mystery4f
 * Typed errors shared by the Motrix tools, with agent-readable hints.
 */

export type MotrixErrorCode =
  | "NOT_RUNNING"
  | "NO_BRIDGE"
  | "AUTH"
  | "RPC"
  | "NETWORK"
  | "TIMEOUT";

export class MotrixError extends Error {
  readonly code: MotrixErrorCode;
  readonly rpcCode?: number;
  readonly hint?: string;

  constructor(code: MotrixErrorCode, message: string, rpcCode?: number, hint?: string) {
    super(message);
    this.name = "MotrixError";
    this.code = code;
    this.rpcCode = rpcCode;
    this.hint = hint;
  }
}

/** Render an error into a short agent-readable message with an actionable hint. */
export function friendlyError(error: unknown): string {
  if (error instanceof MotrixError) {
    return error.hint ? `${error.message} (${error.hint})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
