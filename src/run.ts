import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { diagnosticsOf, errorDiagnostic, formatDiagnostic, scrubDiagnostic, type Diagnostic } from "./diagnostics.js";
import type { FetchLike } from "./http.js";
import { resolveInputs, type OutgoingFile } from "./inputs.js";
import { formatBytes, plural, shellQuote } from "./text.js";
import {
  checkWebhook,
  planBatches,
  resolveWebhookConfig,
  sendFiles,
  type Delivery,
  type WebhookConfig,
  type WebhookInfo,
} from "./webhook.js";
import { wordingFromEnv, type Wording } from "./wording.js";

/** Everything the CLI touches in its environment, so it can run under test without a process. */
export interface RunIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Receives one stdout line (or one help page) at a time, without a trailing newline. */
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Whether stdin is a terminal; it decides the hint when no input is given. */
  readonly stdinIsTTY: boolean;
  readonly readStdin?: (() => Promise<Uint8Array>) | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Monotonic clock in milliseconds, for durations. */
  readonly now?: (() => number) | undefined;
}

export const EXIT_OK: number = 0;
export const EXIT_FAILURE: number = 1;
export const EXIT_USAGE: number = 2;

const TOOL_LOCATION = "dwh";

type Command = "send" | "check";

const COMMANDS: ReadonlySet<string> = new Set<Command>(["send", "check"]);

interface ParsedArgs {
  readonly command: Command;
  /** Whether the command was spelled out (decides which help page -h shows). */
  readonly explicitCommand: boolean;
  readonly positionals: readonly string[];
  readonly name: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

/** Run the CLI with the given arguments (argv without node and the script) and return the exit code. */
export async function run(argv: readonly string[], io: RunIo): Promise<number> {
  const wording = wordingFromEnv(io.env);
  let parsed: ParsedArgs;
  try {
    parsed = parse(argv);
  } catch (error) {
    // The flags could not be parsed, so honor a literal --json when deciding how to say so.
    const reporter = makeReporter(io, wording, argv.includes("--json"), false);
    const message = firstSentence(error instanceof Error ? error.message : String(error));
    return reporter.fail(
      [errorDiagnostic(TOOL_LOCATION, "usage", message, "run dwh --help for the options, or dwh send --help")],
      EXIT_USAGE,
      { command: "send" },
    );
  }
  const reporter = makeReporter(io, wording, parsed.json, parsed.quiet);
  if (parsed.help) {
    io.stdout(helpFor(parsed.explicitCommand ? parsed.command : "root", wording));
    return EXIT_OK;
  }
  if (parsed.version) {
    io.stdout(packageVersion());
    return EXIT_OK;
  }
  if (parsed.command === "check") {
    return runCheck(parsed, io, wording, reporter);
  }
  return runSend(parsed, io, wording, reporter);
}

function parse(argv: readonly string[]): ParsedArgs {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    options: {
      name: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
  // The first positional names the command unless it comes after "--", which lets a file
  // that happens to be called "send" or "check" still be sent: dwh -- check
  const terminatorAt = tokens.find((token) => token.kind === "option-terminator")?.index ?? Number.POSITIVE_INFINITY;
  const firstPositional = tokens.find((token) => token.kind === "positional");
  const explicitCommand =
    firstPositional !== undefined && firstPositional.index < terminatorAt && COMMANDS.has(firstPositional.value);
  const inputs = explicitCommand ? positionals.slice(1) : positionals;
  return {
    command: explicitCommand && positionals[0] === "check" ? "check" : "send",
    explicitCommand,
    positionals: inputs,
    name: values.name,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    quiet: values.quiet === true,
    help: values.help === true,
    version: values.version === true,
  };
}

/** Routes plain lines, advice, results, and failures to stdout/stderr according to --json and --quiet. */
interface Reporter {
  /** A plain stdout line; dropped under --json (the JSON object is the output) and --quiet. */
  readonly line: (text: string) => void;
  /** A progress note on stderr; dropped under --quiet. */
  readonly advice: (diagnostic: Diagnostic) => void;
  /** Finish successfully: under --json, print the payload as one JSON line. */
  readonly succeed: (payload: Readonly<Record<string, unknown>>) => number;
  /** Finish with diagnostics: one stderr line each, or one JSON object on stdout under --json. */
  readonly fail: (
    diagnostics: readonly Diagnostic[],
    exitCode: number,
    payload?: Readonly<Record<string, unknown>>,
  ) => number;
}

/**
 * Every byte the CLI prints passes through the wording's scrub: plain lines, advice, JSON
 * payloads (each string value), and diagnostics. Producers scrub too; this is the last line.
 */
function makeReporter(io: RunIo, wording: Wording, json: boolean, quiet: boolean): Reporter {
  const scrub = (diagnostic: Diagnostic): Diagnostic => scrubDiagnostic(diagnostic, wording.scrub);
  const emitJson = (payload: Readonly<Record<string, unknown>>): void => {
    io.stdout(JSON.stringify(scrubValue(payload, wording.scrub)));
  };
  return {
    line: (text) => {
      if (!json && !quiet) {
        io.stdout(wording.scrub(text));
      }
    },
    advice: (diagnostic) => {
      if (!quiet) {
        io.stderr(formatDiagnostic(scrub(diagnostic)));
      }
    },
    succeed: (payload) => {
      if (json) {
        emitJson({ ok: true, ...payload });
      }
      return EXIT_OK;
    },
    fail: (diagnostics, exitCode, payload = {}) => {
      const scrubbed = diagnostics.map(scrub);
      if (json) {
        emitJson({ ok: false, ...payload, diagnostics: scrubbed.map(jsonDiagnostic) });
      } else {
        for (const diagnostic of scrubbed) {
          io.stderr(formatDiagnostic(diagnostic));
        }
      }
      return exitCode;
    },
  };
}

/** Every string anywhere in a JSON payload passes through `scrub`; keys, numbers, booleans, and nulls stay. */
function scrubValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") {
    return scrub(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => scrubValue(entry, scrub));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubValue(entry, scrub)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonDiagnostic(diagnostic: Diagnostic): Record<string, unknown> {
  return {
    location: diagnostic.location,
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.help === undefined ? {} : { help: diagnostic.help }),
  };
}

async function runSend(parsed: ParsedArgs, io: RunIo, wording: Wording, reporter: Reporter): Promise<number> {
  const payload = { command: "send", dry_run: parsed.dryRun };
  const usage = sendUsageError(parsed, io);
  if (usage !== undefined) {
    return reporter.fail([usage], EXIT_USAGE, payload);
  }
  const now = io.now ?? (() => performance.now());
  const started = now();
  let config: WebhookConfig;
  try {
    config = resolveWebhookConfig(io.env);
  } catch (error) {
    return reporter.fail(diagnosticsOf(error), EXIT_FAILURE, payload);
  }
  let files: OutgoingFile[];
  try {
    files = await resolveInputs(parsed.positionals, {
      nameOverride: parsed.name,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
      readStdin: io.readStdin,
      onDiagnostic: reporter.advice,
      hideDestination: wording.hidden,
    });
  } catch (error) {
    return reporter.fail(diagnosticsOf(error), EXIT_FAILURE, payload);
  }
  const batches = planBatches(files);
  if (parsed.dryRun) {
    const planned: Array<Record<string, unknown>> = [];
    for (const [index, batch] of batches.entries()) {
      for (const file of batch) {
        reporter.line(`would send ${file.name} (${formatBytes(file.data.byteLength)})`);
        planned.push({ ...jsonFile(file), message: index + 1 });
      }
    }
    reporter.line(`dry run: ${plural(files.length, "file")} in ${plural(batches.length, "message")}; nothing was sent`);
    return reporter.succeed({
      ...payload,
      files: planned,
      messages: batches.length,
      duration_ms: Math.round(now() - started),
    });
  }
  const delivered: Array<Record<string, unknown>> = [];
  try {
    await sendFiles(config.url, files, {
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
      hideDestination: wording.hidden,
      onDiagnostic: reporter.advice,
      onSent: (file, delivery) => {
        reporter.line(`sent ${file.name} (${formatBytes(file.data.byteLength)})`);
        delivered.push(jsonDelivery(delivery, wording));
      },
    });
  } catch (error) {
    // Files that were already accepted stay in the payload, so a consumer knows what did arrive.
    return reporter.fail(diagnosticsOf(error), EXIT_FAILURE, {
      ...payload,
      files: delivered,
      messages: batches.length,
    });
  }
  return reporter.succeed({
    ...payload,
    files: delivered,
    messages: batches.length,
    duration_ms: Math.round(now() - started),
  });
}

function sendUsageError(parsed: ParsedArgs, io: RunIo): Diagnostic | undefined {
  const usage = (message: string, help: string): Diagnostic => errorDiagnostic(TOOL_LOCATION, "usage", message, help);
  if (parsed.positionals.length === 0) {
    return usage(
      "nothing to send",
      io.stdinIsTTY
        ? "pass at least one file path or URL, e.g. dwh ./report.md, or dwh https://example.com/build.log"
        : 'pass at least one file path or URL, e.g. dwh ./report.md; to send what is on stdin, name it with "-", e.g. git diff | dwh - --name changes.diff',
    );
  }
  if (parsed.positionals.filter((positional) => positional === "-").length > 1) {
    return usage(
      '"-" (stdin) can be given only once',
      "keep one - and pass the rest as files, e.g. cat log.txt | dwh - a.png",
    );
  }
  const first = parsed.positionals[0] ?? "";
  if (parsed.name !== undefined && parsed.positionals.length > 1) {
    return usage(
      `--name applies to a single input, but ${plural(parsed.positionals.length, "input")} were given`,
      `drop --name, or send that input alone: dwh ${shellQuote(first)} --name ${shellQuote(parsed.name)}`,
    );
  }
  return undefined;
}

async function runCheck(parsed: ParsedArgs, io: RunIo, wording: Wording, reporter: Reporter): Promise<number> {
  const payload = { command: "check" };
  const usage = checkUsageError(parsed);
  if (usage !== undefined) {
    return reporter.fail([usage], EXIT_USAGE, payload);
  }
  let config: WebhookConfig;
  try {
    config = resolveWebhookConfig(io.env);
  } catch (error) {
    return reporter.fail(diagnosticsOf(error), EXIT_FAILURE, payload);
  }
  let info: WebhookInfo;
  try {
    info = await checkWebhook(config.url, {
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
      hideDestination: wording.hidden,
      onDiagnostic: reporter.advice,
    });
  } catch (error) {
    return reporter.fail(diagnosticsOf(error), EXIT_FAILURE, payload);
  }
  if (wording.hidden) {
    reporter.line("destination: ok");
    return reporter.succeed(payload);
  }
  reporter.line(`source: ${config.source}`);
  reporter.line(`webhook: ${info.name ?? "(unnamed)"} (id ${info.id ?? "unknown"})`);
  if (info.channelId !== undefined) {
    reporter.line(`channel: ${info.channelId}`);
  }
  if (info.guildId !== undefined) {
    reporter.line(`server: ${info.guildId}`);
  }
  if (config.threadId !== undefined) {
    reporter.line(`thread: ${config.threadId} (not verified)`);
  }
  reporter.line("destination: ok");
  return reporter.succeed({
    ...payload,
    source: config.source,
    webhook: {
      id: info.id ?? null,
      name: info.name ?? null,
      type: info.type ?? null,
      channel_id: info.channelId ?? null,
      guild_id: info.guildId ?? null,
    },
    thread_id: config.threadId ?? null,
  });
}

function checkUsageError(parsed: ParsedArgs): Diagnostic | undefined {
  const usage = (message: string, help: string): Diagnostic => errorDiagnostic(TOOL_LOCATION, "usage", message, help);
  const first = parsed.positionals[0];
  if (first !== undefined) {
    return usage(
      `check takes no inputs (got ${shellQuote(first)})`,
      `run dwh check by itself; to send that file run dwh send ${shellQuote(first)}`,
    );
  }
  if (parsed.name !== undefined) {
    return usage("--name is not a check option", "dwh check takes only --json and --quiet");
  }
  if (parsed.dryRun) {
    return usage("--dry-run is not a check option", "check never sends anything; run dwh check");
  }
  return undefined;
}

function jsonFile(file: OutgoingFile): Record<string, unknown> {
  return {
    source: file.source ?? null,
    name: file.name,
    bytes: file.data.byteLength,
    content_type: file.contentType,
  };
}

function jsonDelivery(delivery: Delivery, wording: Wording): Record<string, unknown> {
  return {
    ...jsonFile(delivery.file),
    message: delivery.message,
    message_id: delivery.messageId ?? null,
    attachment_id: delivery.attachmentId ?? null,
    // The attachment URL names the service's CDN, so hidden mode leaves it out entirely.
    ...(wording.hidden ? {} : { url: delivery.url ?? null }),
  };
}

/** parseArgs explains itself at length; the first sentence is the diagnostic, the help tail says where to look. */
function firstSentence(text: string): string {
  const cut = text.indexOf(". ");
  const sentence = cut === -1 ? text : text.slice(0, cut);
  return sentence.replace(/\.$/, "");
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  return "unknown";
}

const EXIT_CODES_LINE = "Exit codes: 0 done   1 configuration, input, or delivery failure   2 usage error";

function helpFor(page: "root" | Command, wording: Wording): string {
  if (page === "send") {
    return sendHelp(wording);
  }
  if (page === "check") {
    return checkHelp(wording);
  }
  return rootHelp(wording);
}

function rootHelp(wording: Wording): string {
  const audience = wording.hidden ? "the user" : "the user's Discord";
  return `dwh - deliver files to ${audience}

Usage:
  dwh <file|url|-> [more...] [options]    (short for: dwh send ...)
  dwh <command> [options]

Commands:
  send   deliver one or more files to the user (the default command)
  check  verify the configuration and the destination; sends nothing

Options:
  --json         one JSON object on stdout instead of lines
  -q, --quiet    print nothing but errors
  -h, --help     show help; dwh <command> --help lists that command's options
  -v, --version  print the version

Examples:
  dwh report.md
  dwh a.png b.csv c.md
  git diff | dwh - --name changes.diff
  dwh https://example.com/build.log
  dwh check
  dwh send --help

Files only: dwh cannot send a text message. It never prompts, and the user has already configured it.
${EXIT_CODES_LINE}`;
}

function sendHelp(wording: Wording): string {
  const audience = wording.hidden ? "the user" : "the user's Discord";
  const jsonFields = wording.hidden
    ? "per-file name, size, message id"
    : "per-file name, size, message id, attachment URL";
  const rateLimits = wording.hidden ? "rate limits at the destination" : "Discord rate limits";
  const configuration = wording.hidden
    ? "  the user has already configured the destination; nothing needs setting up here"
    : `  DWH_WEBHOOK_URL       Discord webhook URL (DISCORD_WEBHOOK_URL is a fallback); append ?thread_id=<id> to target a thread
  DWH_HIDE_DESTINATION  1 = never mention Discord or webhooks in any output (help, notes, errors, JSON)`;
  return `dwh send - deliver one or more files to ${audience}

Usage:
  dwh send <file|url|-> [more...] [options]
  dwh <file|url|-> [more...] [options]        (send is the default command)

Inputs:
  <file>  a local file, attached as-is
  <url>   an http(s) URL, downloaded and re-sent as a file; the URL itself is never posted
  -       stdin, sent as a file named stdin.txt unless --name says otherwise (at most once)

Options:
  --name <filename>  filename shown to the user (single input only); its extension also sets the content type
  --dry-run          resolve every input and print what would be sent, then stop; nothing is sent
  --json             one JSON object on stdout: ${jsonFields}
  -q, --quiet        print nothing but errors
  -h, --help         show this help

Examples:
  dwh send report.md
  dwh send a.png b.csv c.md
  git diff | dwh send - --name changes.diff
  dwh send https://example.com/build.log
  dwh send report.md --dry-run
  dwh send report.md --json

Behavior:
  files only: there is no way to send a text message
  every input is resolved before anything is sent, and every bad input is reported, not just the first
  up to 10 files and 24 MiB per message; more is split across messages in input order
  ${rateLimits} are waited out, never surfaced; network errors and 5xx retry up to 5 times
  delivery is at-least-once: a retry after a dropped connection can, rarely, duplicate a message
  HTTPS_PROXY / NO_PROXY are honored
  a nonzero exit is a real failure: read the one-line diagnostic on stderr instead of retrying blindly

Configuration:
${configuration}

Exit codes: 0 all files delivered   1 configuration, input, or delivery failure   2 usage error`;
}

function checkHelp(wording: Wording): string {
  const checks = wording.hidden
    ? `  the destination is configured on this machine
  the destination is reachable and accepts this machine: one read-only request, nothing is sent`
    : `  DWH_WEBHOOK_URL (or DISCORD_WEBHOOK_URL) is set and shaped like a Discord webhook URL
  the webhook exists and accepts its token: one GET request, no message is posted
  a ?thread_id in the URL is reported but not verified`;
  return `dwh check - verify the configuration and the destination; sends nothing

Usage:
  dwh check [options]

Options:
  --json       one JSON object on stdout
  -q, --quiet  print nothing; the exit code is the answer
  -h, --help   show this help

Examples:
  dwh check
  dwh check --json
  dwh check --quiet && dwh report.md

Checks:
${checks}

Exit codes: 0 ready   1 not configured, invalid, or unreachable   2 usage error`;
}
