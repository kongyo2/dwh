import { FormData } from "undici";
import { adviceDiagnostic, DiagnosticError, errorDiagnostic, scrubDiagnostic, type Diagnostic } from "./diagnostics.js";
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
import { formatBytes } from "./text.js";
import { wordingFor, wordingFromEnv, type Wording } from "./wording.js";

export { redactWebhookTokens } from "./wording.js";

export const WEBHOOK_ENV_VARS: readonly ["DWH_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"] = [
  "DWH_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
];

export type WebhookEnvVar = (typeof WEBHOOK_ENV_VARS)[number];

/** The destination accepts at most this many attachments per message. */
export const MAX_FILES_PER_MESSAGE: number = 10;

/** Keep each multipart request under the total request size with headroom for encoding overhead. */
export const MAX_BATCH_BYTES: number = 24 * 1024 * 1024;

const WEBHOOK_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]);
const WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

const REQUEST_TIMEOUT_MS = 120_000;
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_CUSHION_MS = 250;
const TOOL_LOCATION = "dwh";

// Error codes the destination returns in JSON bodies (see the webhook and error-code references).
const CODE_UNKNOWN_CHANNEL = 10003;
const CODE_UNKNOWN_WEBHOOK = 10015;
const CODE_REQUEST_ENTITY_TOO_LARGE = 40005;
const CODE_INVALID_WEBHOOK_TOKEN = 50027;
const CODE_INVALID_FORM_BODY = 50035;

type UndiciResponse = Awaited<ReturnType<FetchLike>>;

export interface WebhookConfig {
  /** The validated URL, query string included (a ?thread_id=<id> is preserved). */
  readonly url: string;
  /** Which environment variable supplied it. */
  readonly source: WebhookEnvVar;
  /** The thread the URL targets, when it carries ?thread_id=<id>. */
  readonly threadId: string | undefined;
}

/**
 * Read the webhook URL from the environment (DWH_WEBHOOK_URL, then DISCORD_WEBHOOK_URL)
 * and reject anything that is not a webhook URL, so a misconfiguration fails here with a
 * clear diagnostic instead of as a confusing HTTP error later. DWH_HIDE_DESTINATION in the
 * same environment decides how that diagnostic is worded.
 */
export function resolveWebhookConfig(env: Readonly<Record<string, string | undefined>>): WebhookConfig {
  const wording = wordingFromEnv(env);
  for (const key of WEBHOOK_ENV_VARS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") {
      const url = validateWebhookUrl(value, key, wording);
      return { url: url.href, source: key, threadId: url.searchParams.get("thread_id") ?? undefined };
    }
  }
  const { message, help } = wording.notConfigured;
  throw new DiagnosticError([errorDiagnostic(TOOL_LOCATION, "not-configured", message, help)]);
}

/** Whether a string is a webhook URL of the service (any of its hosts, any API version). */
export function isWebhookUrl(spec: string): boolean {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return false;
  }
  return WEBHOOK_HOSTS.has(url.hostname) && WEBHOOK_PATH_PATTERN.test(url.pathname);
}

/** The validated webhook URL from the environment; see resolveWebhookConfig for the details. */
export function resolveWebhookUrl(env: Readonly<Record<string, string | undefined>>): string {
  return resolveWebhookConfig(env).url;
}

/** A URL handed straight to the library gets the same validation as one from the environment. */
function validateDirectUrl(webhookUrl: string, wording: Wording): URL {
  return validateWebhookUrl(webhookUrl, "the webhook URL", wording);
}

function validateWebhookUrl(raw: string, source: string, wording: Wording): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const { message, help } = wording.invalidConfig(source, "not-a-url");
    throw new DiagnosticError([errorDiagnostic(TOOL_LOCATION, "invalid-config", message, help)]);
  }
  if (url.protocol !== "https:" || !WEBHOOK_HOSTS.has(url.hostname) || !WEBHOOK_PATH_PATTERN.test(url.pathname)) {
    const { message, help } = wording.invalidConfig(source, "not-a-webhook");
    throw new DiagnosticError([errorDiagnostic(TOOL_LOCATION, "invalid-config", message, help)]);
  }
  return url;
}

/**
 * Split files into messages: at most MAX_FILES_PER_MESSAGE files and MAX_BATCH_BYTES
 * bytes per message, preserving input order. A single file larger than the byte
 * budget gets a message of its own (the destination judges whether it fits the server's limit).
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

/** Where one file ended up, as reported by the destination for the message that carried it. */
export interface Delivery {
  readonly file: OutgoingFile;
  /** 1-based index of the message that carried the file. */
  readonly message: number;
  readonly messageId: string | undefined;
  readonly channelId: string | undefined;
  readonly attachmentId: string | undefined;
  /** Direct URL of the attachment as reported by the destination; such links expire. */
  readonly url: string | undefined;
}

export interface SendResult {
  /** One entry per file, in input order. */
  readonly deliveries: readonly Delivery[];
  /** How many messages it took. */
  readonly messages: number;
}

export interface SendOptions {
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Progress notes worth relaying (rate-limit waits, retries). Always severity "advice", never an error. */
  onDiagnostic?: ((diagnostic: Diagnostic) => void) | undefined;
  /** Called once per file after the message carrying it is accepted by the destination. */
  onSent?: ((file: OutgoingFile, delivery: Delivery) => void) | undefined;
  /** Word every message so that it never names the service files are delivered to. */
  hideDestination?: boolean | undefined;
}

/**
 * Send files to the webhook, one message per batch.
 *
 * Rate limiting is absorbed, never surfaced: a 429 waits out the requested retry_after and
 * sends again, and an exhausted rate-limit budget pauses before the next message.
 * Network errors and 5xx responses retry with backoff a bounded number of times; only
 * those and real 4xx rejections throw (as a DiagnosticError).
 */
export async function sendFiles(
  webhookUrl: string,
  files: readonly OutgoingFile[],
  options: SendOptions = {},
): Promise<SendResult> {
  const policy = policyFrom(options);
  const url = urlWithWait(validateDirectUrl(webhookUrl, policy.wording).href);
  if (files.length === 0) {
    return { deliveries: [], messages: 0 };
  }
  const batches = planBatches(files);
  const deliveries: Delivery[] = [];
  try {
    for (const [index, batch] of batches.entries()) {
      const { meta, message } = await postBatch(policy, url, batch);
      for (const [position, file] of batch.entries()) {
        const attachment = message.attachments[position];
        const delivery: Delivery = {
          file,
          message: index + 1,
          messageId: message.id,
          channelId: message.channelId,
          attachmentId: attachment?.id,
          url: attachment?.url,
        };
        deliveries.push(delivery);
        options.onSent?.(file, delivery);
      }
      const isLastBatch = index === batches.length - 1;
      if (!isLastBatch && meta.remaining === 0 && meta.resetAfterMs > 0) {
        policy.emit(
          adviceDiagnostic(
            TOOL_LOCATION,
            "rate-limit",
            `rate limit budget spent; pausing ${formatSeconds(meta.resetAfterMs)} before the next message (not an error)`,
          ),
        );
        await policy.sleep(meta.resetAfterMs);
      }
    }
  } catch (error) {
    throw scrubbedError(error, policy.wording);
  }
  return { deliveries, messages: batches.length };
}

/** What the destination reports about the webhook itself. */
export interface WebhookInfo {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly type: number | undefined;
  readonly channelId: string | undefined;
  readonly guildId: string | undefined;
}

export interface CheckOptions {
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  onDiagnostic?: ((diagnostic: Diagnostic) => void) | undefined;
  hideDestination?: boolean | undefined;
}

/**
 * Verify that the webhook exists and accepts its token with one GET request; nothing is
 * posted. Rate limits and transient failures are handled exactly as for delivery.
 */
export async function checkWebhook(webhookUrl: string, options: CheckOptions = {}): Promise<WebhookInfo> {
  const policy = policyFrom(options);
  const url = validateDirectUrl(webhookUrl, policy.wording);
  url.search = "";
  let response: UndiciResponse;
  let bodyText: string;
  try {
    response = await requestWithPolicy(policy, () =>
      policy.fetchImpl(url.href, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    );
    bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new DiagnosticError([apiErrorDiagnostic(response.status, bodyText, policy.wording)]);
    }
  } catch (error) {
    throw scrubbedError(error, policy.wording);
  }
  const parsed = parseJson(bodyText);
  const record = isRecord(parsed) ? parsed : {};
  return {
    id: stringField(record, "id"),
    name: stringField(record, "name"),
    type: numberField(record, "type"),
    channelId: stringField(record, "channel_id"),
    guildId: stringField(record, "guild_id"),
  };
}

interface RequestPolicy {
  readonly fetchImpl: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly emit: (diagnostic: Diagnostic) => void;
  readonly wording: Wording;
}

function policyFrom(options: SendOptions | CheckOptions): RequestPolicy {
  const wording = wordingFor(options.hideDestination);
  const onDiagnostic = options.onDiagnostic;
  return {
    fetchImpl: options.fetchImpl ?? proxyAwareFetch,
    sleep: options.sleep ?? defaultSleep,
    // Every note reaches the caller scrubbed, like every thrown diagnostic.
    emit:
      onDiagnostic === undefined
        ? () => undefined
        : (diagnostic) => onDiagnostic(scrubDiagnostic(diagnostic, wording.scrub)),
    wording,
  };
}

/** Rethrow with every diagnostic scrubbed, so library callers never see a raw token or, when hidden, the service. */
function scrubbedError(error: unknown, wording: Wording): unknown {
  if (error instanceof DiagnosticError) {
    return new DiagnosticError(error.diagnostics.map((diagnostic) => scrubDiagnostic(diagnostic, wording.scrub)));
  }
  return error;
}

/**
 * Run one request under the shared policy: network errors and 5xx responses retry with
 * backoff up to MAX_TRANSIENT_ATTEMPTS, a 429 waits out retry_after however often it
 * happens, and any other response is returned to the caller unread.
 */
async function requestWithPolicy(
  policy: RequestPolicy,
  makeRequest: () => Promise<UndiciResponse>,
): Promise<UndiciResponse> {
  const { wording } = policy;
  let transientFailures = 0;
  for (;;) {
    let response: UndiciResponse;
    try {
      response = await makeRequest();
    } catch (error) {
      transientFailures += 1;
      const description = wording.scrub(describeFetchError(error));
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        // The caught error is deliberately NOT attached as `cause`: undici error messages can
        // contain the full request URL, and consumers log thrown errors whole, which would
        // leak the webhook token past the scrubbing above.
        // oxlint-disable-next-line preserve-caught-error
        throw new DiagnosticError([
          errorDiagnostic(
            TOOL_LOCATION,
            "unreachable",
            `could not reach ${wording.service} after ${MAX_TRANSIENT_ATTEMPTS} attempts: ${description}`,
            "check network access from this machine (and HTTPS_PROXY if it needs a proxy), then run the same command again",
          ),
        ]);
      }
      const delayMs = transientDelayMs(transientFailures);
      policy.emit(
        adviceDiagnostic(
          TOOL_LOCATION,
          "retry",
          `network error (${description}); retrying in ${formatSeconds(delayMs)}`,
        ),
      );
      await policy.sleep(delayMs);
      continue;
    }
    if (response.status === 429) {
      const waitMs = await rateLimitWaitMs(response);
      policy.emit(
        adviceDiagnostic(
          TOOL_LOCATION,
          "rate-limit",
          `rate limited by ${wording.service}; waiting ${formatSeconds(waitMs)}, then continuing (not an error)`,
        ),
      );
      await policy.sleep(waitMs);
      continue;
    }
    if (response.status >= 500) {
      // Cancel the unread body so undici can reuse or close the connection instead of
      // holding a socket per failed attempt.
      await response.body?.cancel().catch(() => undefined);
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        throw new DiagnosticError([
          errorDiagnostic(
            TOOL_LOCATION,
            "unavailable",
            `${wording.Service} kept failing (${response.status}) after ${MAX_TRANSIENT_ATTEMPTS} attempts`,
            "the service is having trouble; run the same command again later",
          ),
        ]);
      }
      const delayMs = transientDelayMs(transientFailures);
      policy.emit(
        adviceDiagnostic(
          TOOL_LOCATION,
          "retry",
          `${wording.Service} returned ${response.status}; retrying in ${formatSeconds(delayMs)}`,
        ),
      );
      await policy.sleep(delayMs);
      continue;
    }
    return response;
  }
}

interface BatchMeta {
  remaining: number | undefined;
  resetAfterMs: number;
}

interface MessageInfo {
  id: string | undefined;
  channelId: string | undefined;
  attachments: ReadonlyArray<{ id: string | undefined; url: string | undefined }>;
}

async function postBatch(
  policy: RequestPolicy,
  url: string,
  batch: readonly OutgoingFile[],
): Promise<{ meta: BatchMeta; message: MessageInfo }> {
  const response = await requestWithPolicy(policy, () =>
    policy.fetchImpl(url, {
      method: "POST",
      body: buildForm(batch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  // Read the (small) body either way: it carries the rejection detail or, thanks to
  // ?wait=true, the created message, and draining it lets the connection be reused.
  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new DiagnosticError([apiErrorDiagnostic(response.status, bodyText, policy.wording, batch)]);
  }
  return { meta: metaFromHeaders(response), message: parseMessage(bodyText) };
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

async function rateLimitWaitMs(response: UndiciResponse): Promise<number> {
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

function metaFromHeaders(response: UndiciResponse): BatchMeta {
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  const resetAfterHeader = response.headers.get("x-ratelimit-reset-after");
  const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
  const resetAfter = resetAfterHeader === null ? Number.NaN : Number(resetAfterHeader);
  return {
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAfterMs: Number.isFinite(resetAfter) && resetAfter > 0 ? Math.ceil(resetAfter * 1000) : 0,
  };
}

/** The message object returned for ?wait=true; every field is optional because nothing depends on it. */
function parseMessage(bodyText: string): MessageInfo {
  const record = parseJson(bodyText);
  if (!isRecord(record)) {
    return { id: undefined, channelId: undefined, attachments: [] };
  }
  const rawAttachments: unknown = record["attachments"];
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments.map((entry: unknown) => {
        const attachment = isRecord(entry) ? entry : {};
        return { id: stringField(attachment, "id"), url: stringField(attachment, "url") };
      })
    : [];
  return { id: stringField(record, "id"), channelId: stringField(record, "channel_id"), attachments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function apiErrorDiagnostic(
  status: number,
  bodyText: string,
  wording: Wording,
  batch?: readonly OutgoingFile[],
): Diagnostic {
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
  const detailText = detail.trim() === "" ? "" : ` ${wording.scrub(detail)}`;
  const subject =
    batch === undefined
      ? `${wording.Service} refused the configured URL: ${status}${detailText}`
      : `${wording.Service} rejected ${batch.map((file) => file.name).join(", ")}: ${status}${detailText}`;
  if (status === 413 || code === CODE_REQUEST_ENTITY_TOO_LARGE) {
    return errorDiagnostic(TOOL_LOCATION, "rejected", subject, wording.uploadLimitHelp(largestOf(batch)));
  }
  if (code === CODE_UNKNOWN_CHANNEL) {
    return errorDiagnostic(TOOL_LOCATION, "bad-destination", subject, wording.badThreadHelp);
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    code === CODE_UNKNOWN_WEBHOOK ||
    code === CODE_INVALID_WEBHOOK_TOKEN
  ) {
    return errorDiagnostic(TOOL_LOCATION, "bad-destination", subject, wording.badDestinationHelp);
  }
  if (code === CODE_INVALID_FORM_BODY) {
    return errorDiagnostic(
      TOOL_LOCATION,
      "rejected",
      subject,
      "the request body was refused; if a filename is unusual, send that input alone with --name <plain-ascii-name>",
    );
  }
  return errorDiagnostic(
    TOOL_LOCATION,
    "rejected",
    subject,
    "this is not transient; fix the input or the setup before running the same command again",
  );
}

function largestOf(batch: readonly OutgoingFile[] | undefined): string | undefined {
  if (batch === undefined || batch.length === 0) {
    return undefined;
  }
  let largest = batch[0];
  for (const file of batch) {
    if (largest === undefined || file.data.byteLength > largest.data.byteLength) {
      largest = file;
    }
  }
  return largest === undefined ? undefined : `${largest.name} (${formatBytes(largest.data.byteLength)})`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
