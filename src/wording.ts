export const HIDE_DESTINATION_ENV_VAR = "DWH_HIDE_DESTINATION" as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function hideDestinationFrom(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[HIDE_DESTINATION_ENV_VAR]?.trim().toLowerCase() ?? "";
  return TRUTHY.has(raw);
}

export interface Wording {
  readonly hidden: boolean;
  readonly service: string;
  readonly Service: string;
  readonly tooLarge: (size: string, limit: string) => string;
  readonly uploadLimitHelp: (largest: string | undefined) => string;
  readonly badDestinationHelp: string;
  readonly badThreadHelp: string;
  readonly notConfigured: { readonly message: string; readonly help: string };
  readonly invalidConfig: (
    source: string,
    problem: "not-a-url" | "not-a-webhook",
  ) => { readonly message: string; readonly help: string };
  readonly scrub: (text: string) => string;
}

const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>)]+/gi;
const BARE_WEBHOOK_PATH_PATTERN = /(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/g;
const DECODED_WEBHOOK_PATH_PATTERN = /^\/api(\/v\d+)?\/webhooks\/(\d+)\/[^/]+$/;

export function redactWebhookTokens(text: string): string {
  return text
    .replace(URL_CANDIDATE_PATTERN, (candidate) => canonicalRedactedWebhookUrl(candidate) ?? candidate)
    .replace(BARE_WEBHOOK_PATH_PATTERN, "$1<token>");
}

function canonicalRedactedWebhookUrl(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const match = DECODED_WEBHOOK_PATH_PATTERN.exec(pathname);
  if (match === null) {
    return undefined;
  }
  return `${url.protocol}//${url.host}/api${match[1] ?? ""}/webhooks/${match[2] ?? ""}/<token>${url.search}`;
}

const SERVICE_HOSTNAME_PATTERN = /(?:^|\.)discord[\w-]*\.(?:com|net|gg|new|dev|media|co)$/i;

function isServiceUrl(candidate: string): boolean {
  try {
    return SERVICE_HOSTNAME_PATTERN.test(new URL(candidate).hostname);
  } catch {
    return false;
  }
}

const WEBHOOK_URL_PATTERN =
  /https?:\/\/(?:[\w-]+\.)*discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/(?:[\w-]+|<token>)(?:\?[^\s"'<>)]*)?/gi;
const SERVICE_DOMAIN = String.raw`(?:[\w-]+\.)*discord[\w-]*\.(?:com|net|gg|new|dev|media|co)`;
const SERVICE_URL_PATTERN = new RegExp(String.raw`https?://${SERVICE_DOMAIN}(?::\d+)?(?:/[^\s"'<>)]*)?`, "gi");
const HOST_PATTERN = new RegExp(String.raw`\b${SERVICE_DOMAIN}\b`, "gi");
const CONFIG_VAR_PATTERN = /\b(?:DWH|DISCORD)_WEBHOOK_URL\b/g;
const DISCORD_WORD_PATTERN = /\bdiscord\b/gi;
const WEBHOOK_WORD_PATTERN = /\bwebhooks?\b/gi;
const DISCORD_ANYWHERE_PATTERN = /discord/gi;
const WEBHOOK_ANYWHERE_PATTERN = /webhooks?/gi;

export function neutralize(text: string): string {
  return text
    .replace(WEBHOOK_URL_PATTERN, "<destination>")
    .replace(URL_CANDIDATE_PATTERN, (candidate) => (isServiceUrl(candidate) ? "<destination>" : candidate))
    .replace(SERVICE_URL_PATTERN, "<destination>")
    .replace(CONFIG_VAR_PATTERN, "the dwh configuration")
    .replace(HOST_PATTERN, "the destination")
    .replace(DISCORD_WORD_PATTERN, "the destination")
    .replace(WEBHOOK_WORD_PATTERN, "destination")
    .replace(DISCORD_ANYWHERE_PATTERN, "destination")
    .replace(WEBHOOK_ANYWHERE_PATTERN, "destination");
}

const DEFAULT_UPLOAD_LIMIT = "10 MiB";

const BRANDED: Wording = {
  hidden: false,
  service: "Discord",
  Service: "Discord",
  tooLarge: (size, limit) => `${size} exceeds Discord's absolute limit of ${limit}`,
  uploadLimitHelp: (largest) =>
    `${largest === undefined ? "a file exceeds" : `the largest file is ${largest}, over`} this server's upload limit (${DEFAULT_UPLOAD_LIMIT} per file by default, more when boosted); shrink or split it`,
  badDestinationHelp:
    "the webhook URL is wrong or the webhook was deleted; copy a fresh one (Discord: channel settings > Integrations > Webhooks) into DWH_WEBHOOK_URL",
  badThreadHelp: "the ?thread_id in DWH_WEBHOOK_URL points at a thread that no longer exists; fix it or drop it",
  notConfigured: {
    message: "no webhook configured",
    help: 'export DWH_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>" (create one in Discord: channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL)',
  },
  invalidConfig: (source, problem) => ({
    message: problem === "not-a-url" ? `${source} is not a valid URL` : `${source} is not a Discord webhook URL`,
    help: `expected https://discord.com/api/webhooks/<id>/<token>; copy it from Discord: channel settings > Integrations > Webhooks`,
  }),
  scrub: redactWebhookTokens,
};

const NEUTRAL: Wording = {
  hidden: true,
  service: "the destination",
  Service: "The destination",
  tooLarge: (size, limit) => `${size} exceeds the absolute per-file limit of ${limit}`,
  uploadLimitHelp: (largest) =>
    `${largest === undefined ? "a file exceeds" : `the largest file is ${largest}, over`} the destination's per-file limit (usually ${DEFAULT_UPLOAD_LIMIT}); shrink or split it`,
  badDestinationHelp:
    "the destination configured on this machine is no longer valid; only the user can fix that, so tell them",
  badThreadHelp:
    "the destination configured on this machine points at a location that no longer exists; only the user can fix that, so tell them",
  notConfigured: {
    message: "delivery is not configured on this machine",
    help: "only the user can set it up; tell them dwh is not configured here (nothing on your side needs changing)",
  },
  invalidConfig: () => ({
    message: "the delivery configuration on this machine is invalid",
    help: "only the user can fix it; tell them dwh is misconfigured here (nothing on your side needs changing)",
  }),
  scrub: (text) => redactWebhookTokens(neutralize(text)),
};

export function wordingFor(hidden: boolean | undefined): Wording {
  return hidden === true ? NEUTRAL : BRANDED;
}

export function wordingFromEnv(env: Readonly<Record<string, string | undefined>>): Wording {
  return wordingFor(hideDestinationFrom(env));
}
