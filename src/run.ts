import { readFileSync } from "node:fs";

import { commands, program } from "./_generated/commands.js";
import { programPage } from "./commands/program.js";
import { commandNamedIn, optionList, parseCommandLine, type CommandLine } from "./lib/argv.js";
import type { RunIo } from "./lib/command.js";
import { errorDiagnostic } from "./lib/diagnostics.js";
import { commandHelp, programHelp } from "./lib/help.js";
import { isRecord, stringField } from "./lib/json.js";
import { EXIT_OK, EXIT_USAGE, makeReporter } from "./lib/reporter.js";
import { wordingFromEnv } from "./lib/wording.js";

export type { RunIo } from "./lib/command.js";
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./lib/reporter.js";

export async function run(argv: readonly string[], io: RunIo): Promise<number> {
  const wording = wordingFromEnv(io.env);
  let line: CommandLine;
  try {
    line = parseCommandLine(argv, commands);
  } catch (error) {
    const name = commandNamedIn(argv, commands).name;
    return makeReporter(io, wording, argv.includes("--json"), false).fail(
      [
        errorDiagnostic(
          "dwh",
          "usage",
          error instanceof Error ? error.message : String(error),
          `run dwh ${name} --help for the options (dwh --help lists the commands)`,
        ),
      ],
      EXIT_USAGE,
      { command: name },
    );
  }
  const reporter = makeReporter(io, wording, line.json, line.quiet);
  if (line.help) {
    const page = line.explicit
      ? commandHelp(program, line.command, wording)
      : programHelp(program, commands, programPage(program, wording));
    io.stdout(wording.scrub(page));
    return EXIT_OK;
  }
  if (line.version) {
    io.stdout(packageVersion());
    return EXIT_OK;
  }
  const { command, invocation } = line;
  const foreign = line.foreign[0];
  if (foreign !== undefined) {
    const own = [...command.workflow.options.map((option) => option.name), "json", "quiet"];
    const help =
      command.workflow.foreignOptionHelp?.[foreign] ??
      `dwh ${command.name} takes only ${optionList(own)}`;
    return reporter.fail(
      [errorDiagnostic("dwh", "usage", `--${foreign} is not a ${command.name} option`, help)],
      EXIT_USAGE,
      { command: command.name },
    );
  }
  return command.workflow.run({ io, wording, reporter, command, invocation });
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  return (isRecord(parsed) ? stringField(parsed, "version") : undefined) ?? "unknown";
}
