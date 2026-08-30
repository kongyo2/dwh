import { FormData } from "undici";
import {
  defaultSleep,
  describeFetchError,
  formatSeconds,
  MAX_TRANSIENT_ATTEMPTS,
  proxyAwareFetch,
  transientDelayMs,
  type FetchLike,
} from "./http.js";
import type { OutgoingFile } from "./inputs.js";

export const WEBHOOK_ENV_VARS: readonly ["DWH_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"] = [
  "DWH_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
];

/** Discord accepts at most this many attachments per message. */
export const MAX_FILES_PER_MESSAGE: number = 10;

/** Keep each multipart request under Discord's total request size with headroom for encoding overhead. */
export const MAX_BATCH_BYTES: number = 24 * 1024 * 1024;

const WEBHOOK_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]);
const WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

const REQUEST_TIMEOUT_MS = 120_000;
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_CUSHION_MS = 250;

export interface SendOptions {
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Progress notes worth relaying (rate-limit waits, retries). Never an error. */
  onNote?: ((note: string) => void) | undefined;
  /** Called once per file after the message carrying it is accepted by Discord. */
  onSent?: ((file: OutgoingFile) => void) | undefined;
}

/**
 * Read the webhook URL from the environment (DWH_WEBHOOK_URL, then DISCORD_WEBHOOK_URL)
 * and reject anything that is not a Discord webhook URL, so a misconfiguration fails
 * here with a clear message instead of as a confusing HTTP error later.
 */
export function resolveWebhookUrl(env: Readonly<Record<string, string | undefined>>): string {
  for (const key of WEBHOOK_ENV_VARS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") {
      return validateWebhookUrl(value, key);
    }
  }
  throw new Error(
    [
      "no webhook configured — set DWH_WEBHOOK_URL to your Discord webhook URL",
      "create one in Discord: channel settings → Integrations → Webhooks → New Webhook",
      'then: export DWH_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>"',
    ].join("\n"),
  );
}

function validateWebhookUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL — expected https://discord.com/api/webhooks/<id>/<token>`);
  }
  if (url.protocol !== "https:" || !WEBHOOK_HOSTS.has(url.hostname) || !WEBHOOK_PATH_PATTERN.test(url.pathname)) {
    throw new Error(
      `${source} does not look like a Discord webhook URL — expected https://discord.com/api/webhooks/<id>/<token>`,
    );
  }
  return url.href;
}

/**
 * Split files into messages: at most MAX_FILES_PER_MESSAGE files and MAX_BATCH_BYTES
 * bytes per message, preserving input order. A single file larger than the byte
 * budget gets a message of its own (Discord judges whether it fits the server's limit).
 */
export function planBatches(files: readonly OutgoingFile[]): OutgoingFile[][] {
  const batches: OutgoingFile[][] = [];
  let current: OutgoingFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const size = file.data.byteLength;
    if (current.length > 0 && (current.length >= MAX_FILES_PER_MESSAGE || currentBytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * Send files to the webhook, one Discord message per batch.
 *
 * Rate limiting is absorbed, never surfaced: a 429 waits out Discord's retry_after and
 * sends again, and an exhausted rate-limit budget pauses before the next message.
 * Network errors and 5xx responses retry with backoff a bounded number of times; only
 * those and real 4xx rejections throw.
 */
export async function sendFiles(
  webhookUrl: string,
  files: readonly OutgoingFile[],
  options: SendOptions = {},
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const fetchImpl = options.fetchImpl ?? proxyAwareFetch;
  const sleep = options.sleep ?? defaultSleep;
  const note = options.onNote ?? (() => undefined);
  const url = urlWithWait(webhookUrl);
  const batches = planBatches(files);
  for (const [index, batch] of batches.entries()) {
    const meta = await postBatch(url, batch, fetchImpl, sleep, note);
    for (const file of batch) {
      options.onSent?.(file);
    }
    const isLastBatch = index === batches.length - 1;
    if (!isLastBatch && meta.remaining === 0 && meta.resetAfterMs > 0) {
      note(`rate limit budget spent — pausing ${formatSeconds(meta.resetAfterMs)} before the next message`);
      await sleep(meta.resetAfterMs);
    }
  }
}

/** Replace webhook tokens in any text that might be logged or thrown. */
export function redactWebhookTokens(text: string): string {
  return text.replace(/(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/g, "$1<token>");
}

interface BatchMeta {
  remaining: number | undefined;
  resetAfterMs: number;
}

async function postBatch(
  url: string,
  batch: readonly OutgoingFile[],
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void>,
  note: (text: string) => void,
): Promise<BatchMeta> {
  let transientFailures = 0;
  for (;;) {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        body: buildForm(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      transientFailures += 1;
      const description = redactWebhookTokens(describeFetchError(error));
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        // The caught error is deliberately NOT attached as `cause`: undici error messages can
        // contain the full request URL, and consumers log thrown errors whole, which would
        // leak the webhook token past the redaction below.
        // oxlint-disable-next-line preserve-caught-error
        throw new Error(`could not reach Discord after ${MAX_TRANSIENT_ATTEMPTS} attempts: ${description}`);
      }
      const delayMs = transientDelayMs(transientFailures);
      note(`network error (${description}) — retrying in ${formatSeconds(delayMs)}`);
      await sleep(delayMs);
      continue;
    }
    if (response.status === 429) {
      const waitMs = await rateLimitWaitMs(response);
      note(`rate limited by Discord — waiting ${formatSeconds(waitMs)}, then sending (not an error)`);
      await sleep(waitMs);
      continue;
    }
    if (response.status >= 500) {
      // Cancel the unread body so undici can reuse or close the connection instead of
      // holding a socket per failed attempt.
      await response.body?.cancel().catch(() => undefined);
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        throw new Error(`Discord kept failing (${response.status}) after ${MAX_TRANSIENT_ATTEMPTS} attempts`);
      }
      const delayMs = transientDelayMs(transientFailures);
      note(`Discord returned ${response.status} — retrying in ${formatSeconds(delayMs)}`);
      await sleep(delayMs);
      continue;
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(describeApiError(response.status, bodyText, batch));
    }
    // Drain the (small) response body so the connection can be reused.
    await response.text().catch(() => "");
    return metaFromHeaders(response);
  }
}

function buildForm(batch: readonly OutgoingFile[]): FormData {
  const form = new FormData();
  for (const [index, file] of batch.entries()) {
    form.append(`files[${index}]`, new Blob([file.data], { type: file.contentType }), file.name);
  }
  return form;
}

function urlWithWait(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  return url.href;
}

async function rateLimitWaitMs(response: Awaited<ReturnType<FetchLike>>): Promise<number> {
  let seconds: number | undefined;
  const bodyText = await response.text().catch(() => "");
  const parsed = parseJson(bodyText);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "retry_after" in parsed &&
    typeof parsed.retry_after === "number" &&
    parsed.retry_after >= 0
  ) {
    seconds = parsed.retry_after;
  }
  if (seconds === undefined) {
    const header = Number(response.headers.get("retry-after") ?? "");
    if (Number.isFinite(header) && header > 0) {
      seconds = header;
    }
  }
  const waitMs = Math.min(Math.max((seconds ?? 1) * 1000, MIN_RATE_LIMIT_WAIT_MS), MAX_RATE_LIMIT_WAIT_MS);
  return Math.ceil(waitMs) + RATE_LIMIT_CUSHION_MS;
}

function metaFromHeaders(response: Awaited<ReturnType<FetchLike>>): BatchMeta {
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  const resetAfterHeader = response.headers.get("x-ratelimit-reset-after");
  const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
  const resetAfter = resetAfterHeader === null ? Number.NaN : Number(resetAfterHeader);
  return {
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAfterMs: Number.isFinite(resetAfter) && resetAfter > 0 ? Math.ceil(resetAfter * 1000) : 0,
  };
}

function describeApiError(status: number, bodyText: string, batch: readonly OutgoingFile[]): string {
  let detail = bodyText.slice(0, 300);
  let code: number | undefined;
  const parsed = parseJson(bodyText);
  if (typeof parsed === "object" && parsed !== null) {
    if ("message" in parsed && typeof parsed.message === "string") {
      detail = parsed.message;
    }
    if ("code" in parsed && typeof parsed.code === "number") {
      code = parsed.code;
    }
  }
  const names = batch.map((file) => file.name).join(", ");
  let hint = "";
  if (status === 413 || code === 40005) {
    hint =
      " — a file exceeds this server's upload limit (10 MiB by default, more on boosted servers); shrink or split it";
  } else if (status === 401 || status === 403 || code === 10015 || code === 50027) {
    hint = " — the webhook URL is wrong or was deleted; check DWH_WEBHOOK_URL";
  }
  const detailText = detail === "" ? "" : ` ${redactWebhookTokens(detail)}`;
  return `Discord rejected ${names}: ${status}${detailText}${hint}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
