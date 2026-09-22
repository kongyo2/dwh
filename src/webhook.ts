import { FormData } from "undici";
import { adviceDiagnostic, DiagnosticError, errorDiagnostic, scrubDiagnostic, type Diagnostic } from "./diagnostics.js";
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
import type { OutgoingFile } from "./inputs.js";
import { isRecord, numberField, recordFromJson, stringField } from "./json.js";
import { formatBytes } from "./text.js";
import { wordingFor, wordingFromEnv, type Wording } from "./wording.js";

export { redactWebhookTokens } from "./wording.js";

export const WEBHOOK_ENV_VARS: readonly ["DWH_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"] = [
  "DWH_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
];

export type WebhookEnvVar = (typeof WEBHOOK_ENV_VARS)[number];

export const MAX_FILES_PER_MESSAGE: number = 10;

export const MAX_BATCH_BYTES: number = 24 * 1024 * 1024;

const WEBHOOK_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]);
const WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

const REQUEST_TIMEOUT_MS = 120_000;
const MIN_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_CUSHION_MS = 250;
const TOOL_LOCATION = "dwh";

const CODE_UNKNOWN_CHANNEL = 10003;
const CODE_UNKNOWN_WEBHOOK = 10015;
const CODE_REQUEST_ENTITY_TOO_LARGE = 40005;
const CODE_INVALID_WEBHOOK_TOKEN = 50027;
const CODE_INVALID_FORM_BODY = 50035;

type UndiciResponse = Awaited<ReturnType<FetchLike>>;

export interface WebhookConfig {
  readonly url: string;
  readonly source: WebhookEnvVar;
  readonly threadId: string | undefined;
}

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

export function isWebhookUrl(spec: string): boolean {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return false;
  }
  if (!WEBHOOK_HOSTS.has(url.hostname)) {
    return false;
  }
  if (WEBHOOK_PATH_PATTERN.test(url.pathname)) {
    return true;
  }
  try {
    return WEBHOOK_PATH_PATTERN.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export function resolveWebhookUrl(env: Readonly<Record<string, string | undefined>>): string {
  return resolveWebhookConfig(env).url;
}

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

export interface Delivery {
  readonly file: OutgoingFile;
  readonly message: number;
  readonly messageId: string | undefined;
  readonly channelId: string | undefined;
  readonly attachmentId: string | undefined;
  readonly url: string | undefined;
}

export interface SendResult {
  readonly deliveries: readonly Delivery[];
  readonly messages: number;
}

export interface SendOptions extends RequestOptions {
  onSent?: ((file: OutgoingFile, delivery: Delivery) => void) | undefined;
}

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

export interface WebhookInfo {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly type: number | undefined;
  readonly channelId: string | undefined;
  readonly guildId: string | undefined;
}

export type CheckOptions = RequestOptions;

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
  const record = recordFromJson(bodyText);
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
    emit:
      onDiagnostic === undefined
        ? () => undefined
        : (diagnostic) => onDiagnostic(scrubDiagnostic(diagnostic, wording.scrub)),
    wording,
  };
}

function scrubbedError(error: unknown, wording: Wording): unknown {
  if (error instanceof DiagnosticError) {
    return new DiagnosticError(error.diagnostics.map((diagnostic) => scrubDiagnostic(diagnostic, wording.scrub)));
  }
  return error;
}

async function requestWithPolicy(
  policy: RequestPolicy,
  makeRequest: () => Promise<UndiciResponse>,
): Promise<UndiciResponse> {
  const { wording } = policy;
  const retry = retryBudget(policy);
  for (;;) {
    let response: UndiciResponse;
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

function parseMessage(bodyText: string): MessageInfo {
  const record = recordFromJson(bodyText);
  const rawAttachments: unknown = record["attachments"];
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments.map((entry: unknown) => {
        const attachment = isRecord(entry) ? entry : {};
        return { id: stringField(attachment, "id"), url: stringField(attachment, "url") };
      })
    : [];
  return { id: stringField(record, "id"), channelId: stringField(record, "channel_id"), attachments };
}

function apiErrorDiagnostic(
  status: number,
  bodyText: string,
  wording: Wording,
  batch?: readonly OutgoingFile[],
): Diagnostic {
  const record = recordFromJson(bodyText);
  const detail = stringField(record, "message") ?? bodyText.slice(0, 300);
  const code = numberField(record, "code");
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
