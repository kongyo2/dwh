import { FormData } from "undici";

import {
  adviceDiagnostic,
  DiagnosticError,
  errorDiagnostic,
  scrubDiagnostic,
  type Diagnostic,
} from "../lib/diagnostics.js";
import { isRecord, numberField, parseJson, recordFromJson } from "../lib/json.js";
import { wordingFor, type Wording } from "../lib/wording.js";
import { apiErrorDiagnostic } from "./errors.js";
import {
  defaultSleep,
  describeFetchError,
  formatSeconds,
  MAX_TRANSIENT_ATTEMPTS,
  proxyAwareFetch,
  retryBudget,
  type FetchLike,
  type RequestOptions,
} from "./http.js";
import type { Operation, UploadFile } from "./operation.js";

const TOOL_LOCATION = "dwh";
const REQUEST_TIMEOUT_MS = 120_000;
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_CUSHION_MS = 250;

type FetchResponse = Awaited<ReturnType<FetchLike>>;

export interface ClientOptions extends RequestOptions {
  readonly baseUrl: string;
  readonly query?: Readonly<Record<string, string>> | undefined;
}

export interface RateLimit {
  readonly remaining: number | undefined;
  readonly resetAfterMs: number;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly rateLimit: RateLimit;
}

export class Client {
  readonly #baseUrl: string;
  readonly #query: Readonly<Record<string, string>>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #emit: (diagnostic: Diagnostic) => void;
  readonly #wording: Wording;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#query = options.query ?? {};
    this.#fetch = options.fetchImpl ?? proxyAwareFetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#wording = wordingFor(options.hideDestination);
    const onDiagnostic = options.onDiagnostic;
    const scrub = this.#wording.scrub;
    this.#emit =
      onDiagnostic === undefined
        ? () => undefined
        : (diagnostic) => onDiagnostic(scrubDiagnostic(diagnostic, scrub));
  }

  async send(operation: Operation, request: object): Promise<ApiResult> {
    const fields = new Map<string, unknown>(Object.entries(request));
    const files = filesOf(operation, fields);
    try {
      const url = this.#url(operation, fields);
      const response = await this.#withPolicy(() =>
        this.#fetch(url, {
          method: operation.method,
          ...(files === undefined ? {} : { body: form(operation, files) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      );
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw new DiagnosticError([
          apiErrorDiagnostic({
            operation,
            status: response.status,
            bodyText,
            files,
            wording: this.#wording,
          }),
        ]);
      }
      return {
        status: response.status,
        body: operation.response === "json" && bodyText !== "" ? parseJson(bodyText) : undefined,
        rateLimit: rateLimitOf(response),
      };
    } catch (error) {
      throw scrubbedError(error, this.#wording);
    }
  }

  async pauseForRateLimit(ms: number): Promise<void> {
    this.#emit(
      adviceDiagnostic(
        TOOL_LOCATION,
        "rate-limit",
        `rate limit budget spent; pausing ${formatSeconds(ms)} before the next message (not an error)`,
      ),
    );
    await this.#sleep(ms);
  }

  #url(operation: Operation, fields: ReadonlyMap<string, unknown>): string {
    const path = operation.template.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = fields.get(name);
      if (typeof value !== "string" || value === "") {
        throw new DiagnosticError([
          errorDiagnostic(TOOL_LOCATION, "internal", `${operation.id} needs ${name}`),
        ]);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(this.#baseUrl + path);
    for (const name of operation.query) {
      const value = fields.get(name) ?? this.#query[name];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        url.searchParams.set(name, String(value));
      }
    }
    return url.href;
  }

  async #withPolicy(makeRequest: () => Promise<FetchResponse>): Promise<FetchResponse> {
    const wording = this.#wording;
    const retry = retryBudget({ emit: this.#emit, sleep: this.#sleep });
    for (;;) {
      let response: FetchResponse;
      try {
        response = await makeRequest();
      } catch (error) {
        const description = wording.scrub(describeFetchError(error));
        await retry.failed({
          location: TOOL_LOCATION,
          note: `network error (${description})`,
          giveUp: () =>
            new DiagnosticError([
              errorDiagnostic(
                TOOL_LOCATION,
                "unreachable",
                `could not reach ${wording.service} after ${MAX_TRANSIENT_ATTEMPTS} attempts: ${description}`,
                "check network access from this machine (and HTTPS_PROXY if it needs a proxy), then run the same command again",
              ),
            ]),
        });
        continue;
      }
      if (response.status === 429) {
        const waitMs = await rateLimitWaitMs(response);
        this.#emit(
          adviceDiagnostic(
            TOOL_LOCATION,
            "rate-limit",
            `rate limited by ${wording.service}; waiting ${formatSeconds(waitMs)}, then continuing (not an error)`,
          ),
        );
        await this.#sleep(waitMs);
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        await retry.failed({
          location: TOOL_LOCATION,
          note: `${wording.Service} returned ${response.status}`,
          giveUp: () =>
            new DiagnosticError([
              errorDiagnostic(
                TOOL_LOCATION,
                "unavailable",
                `${wording.Service} kept failing (${response.status}) after ${MAX_TRANSIENT_ATTEMPTS} attempts`,
                "the service is having trouble; run the same command again later",
              ),
            ]),
        });
        continue;
      }
      return response;
    }
  }
}

function isUploadFile(value: unknown): value is UploadFile {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    value["data"] instanceof Uint8Array &&
    typeof value["contentType"] === "string"
  );
}

function filesOf(
  operation: Operation,
  fields: ReadonlyMap<string, unknown>,
): UploadFile[] | undefined {
  if (operation.body === undefined) {
    return undefined;
  }
  const files: UploadFile[] = [];
  for (const list of operation.body.files) {
    const value = fields.get(list.field) ?? [];
    if (!Array.isArray(value) || !value.every(isUploadFile) || value.length > list.parts.length) {
      throw new DiagnosticError([
        errorDiagnostic(
          TOOL_LOCATION,
          "internal",
          `${operation.id}: ${list.field} must be at most ${list.parts.length} files`,
        ),
      ]);
    }
    files.push(...value);
  }
  return files;
}

function form(operation: Operation, files: readonly UploadFile[]): FormData {
  const body = new FormData();
  const parts = operation.body?.files.flatMap((list) => list.parts) ?? [];
  for (const [index, file] of files.entries()) {
    body.append(
      parts[index] ?? `files[${index}]`,
      new Blob([file.data], { type: file.contentType }),
      file.name,
    );
  }
  return body;
}

async function rateLimitWaitMs(response: FetchResponse): Promise<number> {
  let seconds: number | undefined;
  const bodyText = await response.text().catch(() => "");
  const retryAfter = numberField(recordFromJson(bodyText), "retry_after");
  if (retryAfter !== undefined && retryAfter >= 0) {
    seconds = retryAfter;
  }
  if (seconds === undefined) {
    const header = Number(response.headers.get("retry-after") ?? "");
    if (Number.isFinite(header) && header > 0) {
      seconds = header;
    }
  }
  const waitMs = Math.min(
    Math.max((seconds ?? 1) * 1000, MIN_RATE_LIMIT_WAIT_MS),
    MAX_RATE_LIMIT_WAIT_MS,
  );
  return Math.ceil(waitMs) + RATE_LIMIT_CUSHION_MS;
}

function rateLimitOf(response: FetchResponse): RateLimit {
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  const resetAfterHeader = response.headers.get("x-ratelimit-reset-after");
  const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
  const resetAfter = resetAfterHeader === null ? Number.NaN : Number(resetAfterHeader);
  return {
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAfterMs: Number.isFinite(resetAfter) && resetAfter > 0 ? Math.ceil(resetAfter * 1000) : 0,
  };
}

function scrubbedError(error: unknown, wording: Wording): unknown {
  if (error instanceof DiagnosticError) {
    return new DiagnosticError(
      error.diagnostics.map((diagnostic) => scrubDiagnostic(diagnostic, wording.scrub)),
    );
  }
  return error;
}
