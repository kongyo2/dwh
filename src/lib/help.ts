import { COMMON_OPTIONS, VERSION_OPTION } from "./argv.js";
import type { CommandSpec, HelpSection, OptionSpec, ProgramSpec } from "./command.js";
import type { Wording } from "./wording.js";

export interface ProgramPage {
  readonly title: string;
  readonly usage: readonly string[];
  readonly examples: readonly string[];
  readonly footer: readonly string[];
}

function rows(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(0, ...entries.map(([term]) => term.length));
  return entries.map(([term, description]) => `  ${term.padEnd(width)}  ${description}`);
}

function section(part: HelpSection): string {
  const body =
    part.rows === undefined ? (part.lines ?? []).map((line) => `  ${line}`) : rows(part.rows);
  return [`${part.title}:`, ...body].join("\n");
}

function options(
  specs: readonly OptionSpec[],
  wording: Readonly<Record<string, string>>,
): HelpSection {
  return {
    title: "Options",
    rows: specs.map((spec) => {
      const short = spec.short === undefined ? "" : `-${spec.short}, `;
      const value = spec.value === undefined ? "" : ` ${spec.value}`;
      return [`${short}--${spec.name}${value}`, wording[spec.name] ?? spec.description] as const;
    }),
  };
}

export function programHelp(
  program: ProgramSpec,
  commands: readonly CommandSpec[],
  page: ProgramPage,
): string {
  const listed = commands.filter((command) => !command.hidden);
  const ordered = [...listed.filter((c) => c.default), ...listed.filter((c) => !c.default)];
  return [
    `${program.name} - ${page.title}`,
    section({ title: "Usage", lines: page.usage }),
    section({
      title: "Commands",
      rows: ordered.map(
        (c) => [c.name, c.default ? `${c.summary} (the default command)` : c.summary] as const,
      ),
    }),
    section(
      options([...COMMON_OPTIONS, VERSION_OPTION], {
        help: `show help; ${program.name} <command> --help lists that command's options`,
      }),
    ),
    section({ title: "Examples", lines: page.examples }),
    page.footer.join("\n"),
  ].join("\n\n");
}

export function commandHelp(program: ProgramSpec, command: CommandSpec, wording: Wording): string {
  const page = command.workflow.help(wording, command);
  return [
    `${program.name} ${command.name} - ${page.title}`,
    section({ title: "Usage", lines: page.usage }),
    ...(page.before ?? []).map(section),
    section(
      options([...command.workflow.options, ...COMMON_OPTIONS], {
        help: "show this help",
        ...page.optionHelp,
      }),
    ),
    section({ title: "Examples", lines: page.examples }),
    ...(page.after ?? []).map(section),
    page.exitCodes,
  ].join("\n\n");
}
