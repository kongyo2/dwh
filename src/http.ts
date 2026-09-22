import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { adviceDiagnostic, type Diagnostic } from "./diagnostics.js";

export type FetchLike = typeof undiciFetch;

let dispatcher: EnvHttpProxyAgent | undefined;

export const proxyAwareFetch: FetchLike = (input, init) => {
  dispatcher ??= new EnvHttpProxyAgent();
  return undiciFetch(input, { dispatcher, ...init });
};

export const MAX_TRANSIENT_ATTEMPTS: number = 5;

const MAX_TRANSIENT_DELAY_MS = 15_000;

export function transientDelayMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_TRANSIENT_DELAY_MS);
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RequestOptions {
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  onDiagnostic?: ((diagnostic: Diagnostic) => void) | undefined;
  hideDestination?: boolean | undefined;
}

export interface RetryContext {
  readonly emit: (diagnostic: Diagnostic) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface TransientFailure {
  readonly location: string;
  readonly note: string;
  readonly giveUp: () => Error;
}

export interface RetryBudget {
  readonly failed: (failure: TransientFailure) => Promise<void>;
}

export function retryBudget(context: RetryContext): RetryBudget {
  let failures = 0;
  return {
    failed: async (failure) => {
      failures += 1;
      if (failures >= MAX_TRANSIENT_ATTEMPTS) {
        throw failure.giveUp();
      }
      const delayMs = transientDelayMs(failures);
      context.emit(
        adviceDiagnostic(failure.location, "retry", `${failure.note}; retrying in ${formatSeconds(delayMs)}`),
      );
      await context.sleep(delayMs);
    },
  };
}

export function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "request timed out";
    }
    const cause = error.cause;
    const causeText = cause instanceof Error ? ` (${(cause as NodeJS.ErrnoException).code ?? cause.message})` : "";
    return `${error.message}${causeText}`;
  }
  return String(error);
}
