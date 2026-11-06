import { resolveWebhookConfig } from "../../destination.js";
import type { CommandContext, CommandSpec, HelpPage, Workflow } from "../../lib/command.js";
import { errorDiagnostic } from "../../lib/diagnostics.js";
import { EXIT_FAILURE, EXIT_USAGE } from "../../lib/reporter.js";
import { attempt, requestOptions } from "../../lib/run-helpers.js";
import { shellQuote } from "../../lib/text.js";
import type { Wording } from "../../lib/wording.js";
import { checkWebhook } from "./probe.js";

async function run(context: CommandContext): Promise<number> {
  const { io, wording, reporter, invocation } = context;
  const payload = { command: "check" };
  const first = invocation.positionals[0];
  if (first !== undefined) {
    return reporter.fail(
      [
        errorDiagnostic(
          "dwh",
          "usage",
          `check takes no inputs (got ${shellQuote(first)})`,
          `run dwh check by itself; to send that file run dwh send ${shellQuote(first)}`,
        ),
      ],
      EXIT_USAGE,
      payload,
    );
  }
  const configured = await attempt(() => resolveWebhookConfig(io.env));
  if (!configured.ok) {
    return reporter.fail(configured.diagnostics, EXIT_FAILURE, payload);
  }
  const config = configured.value;
  const checked = await attempt(() =>
    checkWebhook(config.url, requestOptions(io, wording, reporter)),
  );
  if (!checked.ok) {
    return reporter.fail(checked.diagnostics, EXIT_FAILURE, payload);
  }
  const info = checked.value;
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

function help(wording: Wording, command: CommandSpec): HelpPage {
  const checks = wording.hidden
    ? [
        "the destination is configured on this machine",
        "the destination is reachable and accepts this machine: one read-only request, nothing is sent",
      ]
    : [
        "DWH_WEBHOOK_URL (or DISCORD_WEBHOOK_URL) is set and shaped like a Discord webhook URL",
        "the webhook exists and accepts its token: one GET request, no message is posted",
        "a ?thread_id in the URL is reported but not verified",
      ];
  return {
    title: command.summary,
    usage: ["dwh check [options]"],
    optionHelp: {
      json: "one JSON object on stdout",
      quiet: "print nothing; the exit code is the answer",
    },
    examples: ["dwh check", "dwh check --json", "dwh check --quiet && dwh report.md"],
    after: [{ title: "Checks", lines: checks }],
    exitCodes: "Exit codes: 0 ready   1 not configured, invalid, or unreachable   2 usage error",
  };
}

export const checkWorkflow: Workflow = {
  options: [],
  foreignOptionHelp: { "dry-run": "check never sends anything; run dwh check" },
  help,
  run,
};
