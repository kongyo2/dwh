import { sendOperation, type SendRequest } from "./_generated/dwh/send.js";
import { Client } from "./api/client.js";
import type { RequestOptions } from "./api/http.js";
import { DiagnosticError, errorDiagnostic } from "./lib/diagnostics.js";
import { wordingFromEnv, type Wording } from "./lib/wording.js";

export const WEBHOOK_ENV_VARS: readonly ["DWH_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"] = [
  "DWH_WEBHOOK_URL",
  "DISCORD_WEBHOOK_URL",
];

export type WebhookEnvVar = (typeof WEBHOOK_ENV_VARS)[number];

const WEBHOOK_HOSTS = new Set([
  "discord.com",
  "ptb.discord.com",
  "canary.discord.com",
  "discordapp.com",
]);

const SEGMENT_PATTERNS: Readonly<Record<string, string>> = {
  webhook_id: String.raw`\d+`,
  webhook_token: String.raw`[\w-]+`,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

function templatePattern(template: string): string {
  return template
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const name = /^\{([^}]+)\}$/.exec(part)?.[1];
      return name === undefined
        ? escapeRegExp(part)
        : `(?<${name}>${SEGMENT_PATTERNS[name] ?? "[^/]+"})`;
    })
    .join("");
}

const DESTINATION_PATH = new RegExp(
  String.raw`^(?<base>/api(?:/v\d+)?)${templatePattern(sendOperation.template)}$`,
);

export type DestinationParams = Pick<SendRequest, "webhook_id" | "webhook_token">;

export interface WebhookConfig {
  readonly url: string;
  readonly source: WebhookEnvVar;
  readonly threadId: string | undefined;
}

export interface Destination {
  readonly url: string;
  readonly baseUrl: string;
  readonly params: DestinationParams;
  readonly query: Readonly<Record<string, string>>;
}

export function resolveWebhookConfig(
  env: Readonly<Record<string, string | undefined>>,
): WebhookConfig {
  const wording = wordingFromEnv(env);
  for (const key of WEBHOOK_ENV_VARS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") {
      const url = validateWebhookUrl(value, key, wording);
      return {
        url: url.href,
        source: key,
        threadId: url.searchParams.get("thread_id") ?? undefined,
      };
    }
  }
  const { message, help } = wording.notConfigured;
  throw new DiagnosticError([errorDiagnostic("dwh", "not-configured", message, help)]);
}

export function resolveWebhookUrl(env: Readonly<Record<string, string | undefined>>): string {
  return resolveWebhookConfig(env).url;
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
  if (DESTINATION_PATH.test(url.pathname)) {
    return true;
  }
  try {
    return DESTINATION_PATH.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export function validateDirectUrl(webhookUrl: string, wording: Wording): URL {
  return validateWebhookUrl(webhookUrl, "the webhook URL", wording);
}

function validateWebhookUrl(raw: string, source: string, wording: Wording): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const { message, help } = wording.invalidConfig(source, "not-a-url");
    throw new DiagnosticError([errorDiagnostic("dwh", "invalid-config", message, help)]);
  }
  if (
    url.protocol !== "https:" ||
    !WEBHOOK_HOSTS.has(url.hostname) ||
    !DESTINATION_PATH.test(url.pathname)
  ) {
    const { message, help } = wording.invalidConfig(source, "not-a-webhook");
    throw new DiagnosticError([errorDiagnostic("dwh", "invalid-config", message, help)]);
  }
  return url;
}

export function destinationOf(url: URL): Destination {
  const groups = DESTINATION_PATH.exec(url.pathname)?.groups;
  const base = groups?.["base"];
  const webhookId = groups?.["webhook_id"];
  const webhookToken = groups?.["webhook_token"];
  if (base === undefined || webhookId === undefined || webhookToken === undefined) {
    throw new DiagnosticError([
      errorDiagnostic("dwh", "internal", "the destination URL was not validated"),
    ]);
  }
  return {
    url: url.href,
    baseUrl: `${url.origin}${base}`,
    params: { webhook_id: webhookId, webhook_token: webhookToken },
    query: Object.fromEntries(url.searchParams),
  };
}

export function clientFor(destination: Destination, options: RequestOptions = {}): Client {
  return new Client({ ...options, baseUrl: destination.baseUrl, query: destination.query });
}
