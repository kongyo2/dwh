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
