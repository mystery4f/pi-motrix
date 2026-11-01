/**
 * @author mystery4f
 * Minimal MDXP (Motrix Download eXchange Protocol) JSON-RPC 2.0 client.
 */
import { MotrixError } from "./errors.js";
import type { MotrixEndpoint } from "./discovery.js";

export interface RpcOptions {
  /** Per-call timeout in milliseconds (default 15000). */
  timeoutMs?: number;
  /** External abort signal (tool cancellation). */
  signal?: AbortSignal;
}

interface JsonRpcBody<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Perform one unary MDXP call: POST {jsonrpc:"2.0",id,method,params} to
 * `http://127.0.0.1:{port}/mdxp` with `authorization: Bearer {localToken}`.
 */
export async function mdxpCall<T>(
  endpoint: MotrixEndpoint,
  method: string,
  params: unknown,
  options: RpcOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new MotrixError("TIMEOUT", `MDXP call ${method} timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl}/mdxp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? new MotrixError("TIMEOUT", "aborted");
      throw new MotrixError(
        "NETWORK",
        `cannot reach Motrix bridge at ${endpoint.baseUrl}`,
        undefined,
        "is the Motrix desktop app running?",
      );
    }

    if (response.status === 401) {
      throw new MotrixError(
        "AUTH",
        "Motrix bridge rejected the token (HTTP 401)",
        undefined,
        "restart the Motrix desktop app so it rewrites bridge/endpoint.json",
      );
    }
    if (response.status === 404) {
      throw new MotrixError(
        "NO_BRIDGE",
        `no MDXP bridge at ${endpoint.baseUrl} (HTTP 404)`,
        undefined,
        "this Motrix version may be too old — update to a recent Motrix release",
      );
    }
    if (!response.ok) {
      throw new MotrixError("NETWORK", `Motrix bridge returned HTTP ${response.status}`);
    }

    let body: JsonRpcBody<T>;
    try {
      body = (await response.json()) as JsonRpcBody<T>;
    } catch {
      throw new MotrixError("NETWORK", "Motrix bridge returned a non-JSON response");
    }
    if (body.error) {
      throw new MotrixError("RPC", body.error.message ?? "MDXP RPC error", body.error.code);
    }
    return body.result as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Sleep for `ms`, resolving early on abort. Returns true when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
