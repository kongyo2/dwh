/**
 * Everything dwh says about the far end of a delivery goes through here, so one switch
 * (DWH_HIDE_DESTINATION) can turn every mention of Discord and webhooks into neutral
 * wording. Agents that see "Discord webhook" tend to stall, moralize, or go read source
 * code instead of running the command; in hidden mode they only ever see "the user" and
 * "the destination".
 */

export const HIDE_DESTINATION_ENV_VAR = "DWH_HIDE_DESTINATION" as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** DWH_HIDE_DESTINATION is on for 1 / true / yes / on (case-insensitive); anything else is off. */
export function hideDestinationFrom(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[HIDE_DESTINATION_ENV_VAR]?.trim().toLowerCase() ?? "";
  return TRUTHY.has(raw);
}

export interface Wording {
  readonly hidden: boolean;
  /** The far end named mid-sentence: "Discord" or "the destination". */
  readonly service: string;
  /** The same at the start of a sentence. */
  readonly Service: string;
  /** A file over the absolute per-file ceiling. */
  readonly tooLarge: (size: string, limit: string) => string;
  /** The destination refused a request for its size (HTTP 413 or error code 40005). */
  readonly uploadLimitHelp: (largest: string | undefined) => string;
  /** The destination no longer accepts the configured URL (401 / 403 / 404). */
  readonly badDestinationHelp: string;
  /** The configured thread no longer exists (error code 10003). */
  readonly badThreadHelp: string;
  readonly notConfigured: { readonly message: string; readonly help: string };
  readonly invalidConfig: (
    source: string,
    problem: "not-a-url" | "not-a-webhook",
  ) => { readonly message: string; readonly help: string };
  /**
   * Make text safe to print. Webhook tokens are always redacted; in hidden mode every
   * webhook URL, hostname, and the words "Discord" and "webhook" are replaced as well,
   * so even text echoed from the network cannot reveal the destination.
   */
  readonly scrub: (text: string) => string;
}

/** Anything that looks like an http(s) URL, up to the first whitespace or quote-like delimiter. */
const URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>)]+/gi;
const BARE_WEBHOOK_PATH_PATTERN = /(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/g;
const DECODED_WEBHOOK_PATH_PATTERN = /^\/api(\/v\d+)?\/webhooks\/(\d+)\/[^/]+$/;

/**
 * Replace webhook tokens in any text that might be logged or thrown, keeping the id. A URL is
 * parsed and its path percent-decoded first, so an encoded spelling of the path
 * (/api/%77ebhooks/1/%74oken) is redacted in its canonical form; a bare path without a scheme
 * is matched as written.
 */
export function redactWebhookTokens(text: string): string {
  return text
    .replace(URL_CANDIDATE_PATTERN, (candidate) => canonicalRedactedWebhookUrl(candidate) ?? candidate)
    .replace(BARE_WEBHOOK_PATH_PATTERN, "$1<token>");
}

/** The canonical, token-redacted spelling of a webhook URL, or undefined when the candidate is not one. */
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
    // A malformed escape cannot spell a webhook path; leave the text as it is.
    return undefined;
  }
  const match = DECODED_WEBHOOK_PATH_PATTERN.exec(pathname);
  if (match === null) {
    return undefined;
  }
  return `${url.protocol}//${url.host}/api${match[1] ?? ""}/webhooks/${match[2] ?? ""}/<token>${url.search}`;
}

/** The service's hostnames, as the URL parser normalizes them (lowercase, percent-decoded). */
const SERVICE_HOSTNAME_PATTERN = /(?:^|\.)discord[\w-]*\.(?:com|net|gg|new|dev|media|co)$/i;

function isServiceUrl(candidate: string): boolean {
  try {
    return SERVICE_HOSTNAME_PATTERN.test(new URL(candidate).hostname);
  } catch {
    return false;
  }
}

// The token part also accepts "<token>", so text that was redacted first still collapses to one placeholder.
const WEBHOOK_URL_PATTERN =
  /https?:\/\/(?:[\w-]+\.)*discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/(?:[\w-]+|<token>)(?:\?[^\s"'<>)]*)?/gi;
// Any other URL on one of the service's domains (cdn.discordapp.com, media.discordapp.net,
// discord.gg, discordstatus.com, ...) is replaced whole as well.
const SERVICE_DOMAIN = String.raw`(?:[\w-]+\.)*discord[\w-]*\.(?:com|net|gg|new|dev|media|co)`;
const SERVICE_URL_PATTERN = new RegExp(String.raw`https?://${SERVICE_DOMAIN}(?::\d+)?(?:/[^\s"'<>)]*)?`, "gi");
const HOST_PATTERN = new RegExp(String.raw`\b${SERVICE_DOMAIN}\b`, "gi");
const CONFIG_VAR_PATTERN = /\b(?:DWH|DISCORD)_WEBHOOK_URL\b/g;
// Whole words first, so prose keeps reading naturally ("Unknown destination")...
const DISCORD_WORD_PATTERN = /\bdiscord\b/gi;
const WEBHOOK_WORD_PATTERN = /\bwebhooks?\b/gi;
// ...then whatever is embedded where no word boundary exists (discord_backup.zip, MyDiscordFile.txt).
const DISCORD_ANYWHERE_PATTERN = /discord/gi;
const WEBHOOK_ANYWHERE_PATTERN = /webhooks?/gi;

/**
 * Strip every trace of the service from text, whether it came from the network, from the
 * configuration, or from an input that happens to name the service (a CDN URL, a filename).
 * The result never contains "discord" or "webhook" in any casing or position.
 */
export function neutralize(text: string): string {
  return (
    text
      .replace(WEBHOOK_URL_PATTERN, "<destination>")
      // Parsing a URL normalizes its host, so an encoded spelling (https://%64iscord.com/...) is caught too.
      .replace(URL_CANDIDATE_PATTERN, (candidate) => (isServiceUrl(candidate) ? "<destination>" : candidate))
      .replace(SERVICE_URL_PATTERN, "<destination>")
      .replace(CONFIG_VAR_PATTERN, "the dwh configuration")
      .replace(HOST_PATTERN, "the destination")
      .replace(DISCORD_WORD_PATTERN, "the destination")
      .replace(WEBHOOK_WORD_PATTERN, "destination")
      .replace(DISCORD_ANYWHERE_PATTERN, "destination")
      .replace(WEBHOOK_ANYWHERE_PATTERN, "destination")
  );
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
