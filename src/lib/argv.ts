import { parseArgs, type ParseArgsConfig } from "node:util";

import type { CommandSpec, Invocation, OptionSpec } from "./command.js";

export const COMMON_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "one JSON object on stdout instead of lines" },
  { name: "quiet", short: "q", type: "boolean", description: "print nothing but errors" },
  { name: "help", short: "h", type: "boolean", description: "show help" },
];

export const VERSION_OPTION: OptionSpec = {
  name: "version",
  short: "v",
  type: "boolean",
  description: "print the version",
};

export interface CommandLine {
  readonly command: CommandSpec;
  readonly explicit: boolean;
  readonly invocation: Invocation;
  readonly foreign: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
}

type ParseOptions = NonNullable<ParseArgsConfig["options"]>;

function allOptions(commands: readonly CommandSpec[]): ParseOptions {
  const out: ParseOptions = {};
  for (const spec of [
    ...COMMON_OPTIONS,
    VERSION_OPTION,
    ...commands.flatMap((c) => c.workflow.options),
  ]) {
    out[spec.name] =
      spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short };
  }
  return out;
}

export function parseCommandLine(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): CommandLine {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: allOptions(commands),
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw new Error(firstSentence(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  const { values, positionals, tokens } = parsed;
  const terminatorAt =
    tokens.find((token) => token.kind === "option-terminator")?.index ?? Number.POSITIVE_INFINITY;
  const first = tokens.find((token) => token.kind === "positional");
  const named =
    first !== undefined && first.index < terminatorAt
      ? commands.find((c) => c.name === first.value)
      : undefined;
  const command = named ?? defaultCommand(commands);
  const own = new Set(
    [...COMMON_OPTIONS, VERSION_OPTION, ...command.workflow.options].map((option) => option.name),
  );
  const foreign: string[] = [];
  for (const token of tokens) {
    if (token.kind === "option" && !own.has(token.name) && !foreign.includes(token.name)) {
      foreign.push(token.name);
    }
  }
  return {
    command,
    explicit: named !== undefined,
    invocation: { positionals: named === undefined ? positionals : positionals.slice(1), values },
    foreign,
    help: values["help"] === true,
    version: values["version"] === true,
    json: values["json"] === true,
    quiet: values["quiet"] === true,
  };
}

export function defaultCommand(commands: readonly CommandSpec[]): CommandSpec {
  const command = commands.find((c) => c.default) ?? commands[0];
  if (command === undefined) {
    throw new Error("the command table is empty");
  }
  return command;
}

export function commandNamedIn(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): CommandSpec {
  const valued = new Set(
    commands.flatMap((c) =>
      c.workflow.options
        .filter((option) => option.type === "string")
        .map((option) => `--${option.name}`),
    ),
  );
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      break;
    }
    if (valued.has(token)) {
      index += 1;
    } else if (token === "-" || !token.startsWith("-")) {
      return commands.find((c) => c.name === token) ?? defaultCommand(commands);
    }
  }
  return defaultCommand(commands);
}

function firstSentence(text: string): string {
  const cut = text.indexOf(". ");
  return (cut === -1 ? text : text.slice(0, cut)).replace(/\.$/, "");
}

export function optionList(names: readonly string[]): string {
  const flags = names.map((name) => `--${name}`);
  return flags.length <= 2
    ? flags.join(" and ")
    : `${flags.slice(0, -1).join(", ")}, and ${flags.at(-1) ?? ""}`;
}
