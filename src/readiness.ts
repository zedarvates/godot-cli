import type { GodotResponse } from "./client.js";

export const MAX_READY_TIMEOUT_MS = 300_000;
export const MIN_READY_INTERVAL_MS = 50;
export const MAX_READY_INTERVAL_MS = 5_000;
const MAX_ATTEMPT_TIMEOUT_MS = 1_000;

export interface ReadinessClient {
  send(
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<GodotResponse>;
}

export interface ReadinessOptions {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ReadinessReport {
  status: "ok" | "error";
  ready: boolean;
  attempts: number;
  elapsed_ms: number;
  response?: GodotResponse;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function waitForReady(
  client: ReadinessClient,
  options: ReadinessOptions
): Promise<ReadinessReport> {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_READY_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be between 1 and ${MAX_READY_TIMEOUT_MS}`
    );
  }
  if (
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs < MIN_READY_INTERVAL_MS ||
    options.intervalMs > MAX_READY_INTERVAL_MS
  ) {
    throw new Error(
      `intervalMs must be between ${MIN_READY_INTERVAL_MS} and ${MAX_READY_INTERVAL_MS}`
    );
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  let attempts = 0;
  let lastError = "Godot did not report ready";

  while (true) {
    attempts += 1;
    const remainingBeforeAttempt = Math.max(1, deadline - now());
    try {
      const response = await client.send(
        "ping",
        {},
        Math.min(MAX_ATTEMPT_TIMEOUT_MS, remainingBeforeAttempt)
      );
      const data = asRecord(response.data);
      if (response.status === "ok" && data?.ready === true) {
        return {
          status: "ok",
          ready: true,
          attempts,
          elapsed_ms: Math.max(0, now() - startedAt),
          response,
        };
      }
      lastError =
        response.status === "error"
          ? response.error ?? "Godot readiness probe failed"
          : "Godot ping response did not declare ready=true";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: "error",
        ready: false,
        attempts,
        elapsed_ms: Math.max(0, now() - startedAt),
        error: lastError,
      };
    }
    await sleep(Math.min(options.intervalMs, remaining));
  }
}
