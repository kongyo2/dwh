import type { ProgramSpec } from "../lib/command.js";
import type { ProgramPage } from "../lib/help.js";
import type { Wording } from "../lib/wording.js";

export function programPage(program: ProgramSpec, wording: Wording): ProgramPage {
  return {
    title: wording.hidden ? program.description : "deliver files to the user's Discord",
    usage: [
      "dwh <file|url|-> [more...] [options]    (short for: dwh send ...)",
      "dwh <command> [options]",
    ],
    examples: [
      "dwh report.md",
      "dwh a.png b.csv c.md",
      "git diff | dwh - --name changes.diff",
      "dwh https://example.com/build.log",
      "dwh check",
      "dwh send --help",
    ],
    footer: [
      "Files only: dwh cannot send a text message. It never prompts, and the user has already configured it.",
      "Exit codes: 0 done   1 configuration, input, or delivery failure   2 usage error",
    ],
  };
}
