import type { FetchLike } from "../api/http.js";
import type { Reporter } from "./reporter.js";
import type { Wording } from "./wording.js";

export interface RunIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdinIsTTY: boolean;
  readonly readStdin?: (() => Promise<Uint8Array>) | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ProgramSpec {
  readonly name: string;
  readonly description: string;
}

export interface OptionSpec {
  readonly name: string;
  readonly short?: string | undefined;
  readonly type: "string" | "boolean";
  readonly value?: string | undefined;
  readonly description: string;
}

export interface HelpSection {
  readonly title: string;
  readonly lines?: readonly string[] | undefined;
  readonly rows?: ReadonlyArray<readonly [string, string]> | undefined;
}

export interface HelpPage {
  readonly title: string;
  readonly usage: readonly string[];
  readonly before?: readonly HelpSection[] | undefined;
  readonly optionHelp?: Readonly<Record<string, string>> | undefined;
  readonly examples: readonly string[];
  readonly after?: readonly HelpSection[] | undefined;
  readonly exitCodes: string;
}

export interface Invocation {
  readonly positionals: readonly string[];
  readonly values: Readonly<
    Record<string, string | boolean | readonly (string | boolean)[] | undefined>
  >;
}

export interface CommandContext {
  readonly io: RunIo;
  readonly wording: Wording;
  readonly reporter: Reporter;
  readonly command: CommandSpec;
  readonly invocation: Invocation;
}

export interface Workflow {
  readonly options: readonly OptionSpec[];
  readonly foreignOptionHelp?: Readonly<Record<string, string>> | undefined;
  readonly help: (wording: Wording, command: CommandSpec) => HelpPage;
  readonly run: (context: CommandContext) => Promise<number>;
}

export interface CommandSpec {
  readonly name: string;
  readonly id: string;
  readonly summary: string;
  readonly default: boolean;
  readonly hidden: boolean;
  readonly workflow: Workflow;
}
