import { resolveWebhookConfig } from "../../destination.js";
import type { CommandContext, CommandSpec, HelpPage, Workflow } from "../../lib/command.js";
import { errorDiagnostic, type Diagnostic } from "../../lib/diagnostics.js";
import { EXIT_FAILURE, EXIT_USAGE } from "../../lib/reporter.js";
import { attempt, requestOptions } from "../../lib/run-helpers.js";
import { formatBytes, plural, shellQuote } from "../../lib/text.js";
import type { Wording } from "../../lib/wording.js";
import {
  MAX_BATCH_BYTES,
  MAX_FILES_PER_MESSAGE,
  planBatches,
  sendFiles,
  type Delivery,
} from "./deliver.js";
import { resolveInputs, type OutgoingFile } from "./inputs.js";

const TOOL_LOCATION = "dwh";
const MIB = 1024 * 1024;

async function run(context: CommandContext): Promise<number> {
  const { io, wording, reporter, invocation } = context;
  const dryRun = invocation.values["dry-run"] === true;
  const nameValue = invocation.values["name"];
  const name = typeof nameValue === "string" ? nameValue : undefined;
  const payload = { command: "send", dry_run: dryRun };
  const usage = usageError(invocation.positionals, name, io.stdinIsTTY);
  if (usage !== undefined) {
    return reporter.fail([usage], EXIT_USAGE, payload);
  }
  const now = io.now ?? (() => performance.now());
  const started = now();
  const configured = await attempt(() => resolveWebhookConfig(io.env));
  if (!configured.ok) {
    return reporter.fail(configured.diagnostics, EXIT_FAILURE, payload);
  }
  const resolved = await attempt(() =>
    resolveInputs(invocation.positionals, {
      ...requestOptions(io, wording, reporter),
      nameOverride: name,
      readStdin: io.readStdin,
    }),
  );
  if (!resolved.ok) {
    return reporter.fail(resolved.diagnostics, EXIT_FAILURE, payload);
  }
  const files = resolved.value;
  const batches = planBatches(files);
  if (dryRun) {
    const planned: Array<Record<string, unknown>> = [];
    for (const [index, batch] of batches.entries()) {
      for (const file of batch) {
        reporter.line(`would send ${file.name} (${formatBytes(file.data.byteLength)})`);
        planned.push({ ...jsonFile(file), message: index + 1 });
      }
    }
    reporter.line(
      `dry run: ${plural(files.length, "file")} in ${plural(batches.length, "message")}; nothing was sent`,
    );
    return reporter.succeed({
      ...payload,
      files: planned,
      messages: batches.length,
      duration_ms: Math.round(now() - started),
    });
  }
  const delivered: Array<Record<string, unknown>> = [];
  const sent = await attempt(() =>
    sendFiles(configured.value.url, files, {
      ...requestOptions(io, wording, reporter),
      onSent: (file, delivery) => {
        reporter.line(`sent ${file.name} (${formatBytes(file.data.byteLength)})`);
        delivered.push(jsonDelivery(delivery, wording));
      },
    }),
  );
  if (!sent.ok) {
    return reporter.fail(sent.diagnostics, EXIT_FAILURE, {
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

function usageError(
  positionals: readonly string[],
  name: string | undefined,
  stdinIsTTY: boolean,
): Diagnostic | undefined {
  const usage = (message: string, fix: string): Diagnostic =>
    errorDiagnostic(TOOL_LOCATION, "usage", message, fix);
  if (positionals.length === 0) {
    return usage(
      "nothing to send",
      stdinIsTTY
        ? "pass at least one file path or URL, e.g. dwh ./report.md, or dwh https://example.com/build.log"
        : 'pass at least one file path or URL, e.g. dwh ./report.md; to send what is on stdin, name it with "-", e.g. git diff | dwh - --name changes.diff',
    );
  }
  if (positionals.filter((positional) => positional === "-").length > 1) {
    return usage(
      '"-" (stdin) can be given only once',
      "keep one - and pass the rest as files, e.g. cat log.txt | dwh - a.png",
    );
  }
  if (name !== undefined && positionals.length > 1) {
    return usage(
      `--name applies to a single input, but ${plural(positionals.length, "input")} were given`,
      `drop --name, or send that input alone: dwh ${shellQuote(positionals[0] ?? "")} --name ${shellQuote(name)}`,
    );
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
    ...(wording.hidden ? {} : { url: delivery.url ?? null }),
  };
}

function help(wording: Wording, command: CommandSpec): HelpPage {
  const rateLimits = wording.hidden ? "rate limits at the destination" : "Discord rate limits";
  const configuration = wording.hidden
    ? ["the user has already configured the destination; nothing needs setting up here"]
    : [
        "DWH_WEBHOOK_URL       Discord webhook URL (DISCORD_WEBHOOK_URL is a fallback); append ?thread_id=<id> to target a thread",
        "DWH_HIDE_DESTINATION  1 = never mention Discord or webhooks in any output (help, notes, errors, JSON)",
      ];
  return {
    title: wording.hidden ? command.summary : "deliver one or more files to the user's Discord",
    usage: [
      "dwh send <file|url|-> [more...] [options]",
      "dwh <file|url|-> [more...] [options]        (send is the default command)",
    ],
    before: [
      {
        title: "Inputs",
        rows: [
          ["<file>", "a local file, attached as-is"],
          [
            "<url>",
            "an http(s) URL, downloaded and re-sent as a file; the URL itself is never posted",
          ],
          [
            "-",
            "stdin, sent as a file named stdin.txt unless --name says otherwise (at most once)",
          ],
        ],
      },
    ],
    optionHelp: {
      json: `one JSON object on stdout: per-file name, size, message id${wording.hidden ? "" : ", attachment URL"}`,
    },
    examples: [
      "dwh send report.md",
      "dwh send a.png b.csv c.md",
      "git diff | dwh send - --name changes.diff",
      "dwh send https://example.com/build.log",
      "dwh send report.md --dry-run",
      "dwh send report.md --json",
    ],
    after: [
      {
        title: "Behavior",
        lines: [
          "files only: there is no way to send a text message",
          "every input is resolved before anything is sent, and every bad input is reported, not just the first",
          `up to ${MAX_FILES_PER_MESSAGE} files and ${MAX_BATCH_BYTES / MIB} MiB per message; more is split across messages in input order`,
          `${rateLimits} are waited out, never surfaced; network errors and 5xx retry up to 5 times`,
          "delivery is at-least-once: a retry after a dropped connection can, rarely, duplicate a message",
          "HTTPS_PROXY / NO_PROXY are honored",
          "a nonzero exit is a real failure: read the one-line diagnostic on stderr instead of retrying blindly",
        ],
      },
      { title: "Configuration", lines: configuration },
    ],
    exitCodes:
      "Exit codes: 0 all files delivered   1 configuration, input, or delivery failure   2 usage error",
  };
}

export const sendWorkflow: Workflow = {
  options: [
    {
      name: "name",
      type: "string",
      value: "<filename>",
      description:
        "filename shown to the user (single input only); its extension also sets the content type",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "resolve every input and print what would be sent, then stop; nothing is sent",
    },
  ],
  help,
  run,
};
