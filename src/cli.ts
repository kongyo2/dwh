#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveInputs } from "./inputs.js";
import { redactWebhookTokens, resolveWebhookUrl, sendFiles } from "./webhook.js";

const HELP = `dwh — deliver files to a human over a Discord webhook

Usage:
  dwh <file|url|-> [more...] [--name <filename>]

Inputs:
  path               local file, sent as a Discord attachment
  url                http(s) URL, downloaded and re-sent as an attachment
  -                  read stdin (e.g. git diff | dwh - --name changes.diff)

Options:
  --name <filename>  filename shown in Discord (single input only)
  -h, --help         show this help
  -v, --version      print the version

Configuration:
  DWH_WEBHOOK_URL    Discord webhook URL (DISCORD_WEBHOOK_URL also works)

Behavior:
  - files only: dwh has no way to send a text message
  - Discord rate limits are waited out and retried, never surfaced as errors
  - up to 10 files go in one message; more inputs are split across messages
  - HTTPS_PROXY / NO_PROXY are honored

Exit codes:
  0 all files delivered   1 config/input/delivery failure   2 usage error`;

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  let values: { name?: string | undefined; help?: boolean | undefined; version?: boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    console.error('dwh: run "dwh --help" for usage');
    return 2;
  }
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  if (values.version === true) {
    console.log(packageVersion());
    return 0;
  }
  try {
    checkUsage(positionals, values.name);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    console.error('dwh: run "dwh --help" for usage');
    return 2;
  }
  try {
    const webhookUrl = resolveWebhookUrl(process.env);
    const files = await resolveInputs(positionals, {
      nameOverride: values.name,
      onNote: (note) => {
        console.error(`dwh: ${note}`);
      },
    });
    await sendFiles(webhookUrl, files, {
      onNote: (note) => {
        console.error(`dwh: ${note}`);
      },
      onSent: (file) => {
        console.log(`sent ${file.name} (${formatBytes(file.data.byteLength)})`);
      },
    });
    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function checkUsage(positionals: readonly string[], nameOverride: string | undefined): void {
  if (positionals.length === 0) {
    throw new UsageError("nothing to send — pass at least one file path or URL");
  }
  if (positionals.filter((positional) => positional === "-").length > 1) {
    throw new UsageError('stdin ("-") can be given only once');
  }
  if (nameOverride !== undefined && positionals.length > 1) {
    throw new UsageError("--name only makes sense with a single input");
  }
}

function printError(message: string): void {
  for (const line of redactWebhookTokens(message).split("\n")) {
    console.error(`dwh: ${line}`);
  }
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  return "unknown";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  for (const unit of ["KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") {
      return `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

process.exitCode = await main(process.argv.slice(2));
