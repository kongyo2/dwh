import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/**
 * The fetch used for every request dwh makes.
 *
 * Node's global fetch ignores HTTP(S)_PROXY / NO_PROXY, which breaks in exactly the
 * environments coding agents run in (sandboxes, CI, corporate networks). undici's
 * EnvHttpProxyAgent honors those variables and behaves like a plain agent when they
 * are unset, so this is safe to use unconditionally.
 */
export type FetchLike = typeof undiciFetch;

let dispatcher: EnvHttpProxyAgent | undefined;

export const proxyAwareFetch: FetchLike = (input, init) => {
  dispatcher ??= new EnvHttpProxyAgent();
  return undiciFetch(input, { dispatcher, ...init });
};

/** Bounded retry policy shared by URL downloads and webhook delivery. */
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

/** One readable line for a failed fetch, surfacing the OS-level cause code when there is one. */
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
