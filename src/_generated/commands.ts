/* eslint-disable */

import { checkWorkflow } from "../commands/check/index.js";
import { sendWorkflow } from "../commands/send/index.js";
import type { CommandSpec, ProgramSpec } from "../lib/command.js";

export const program: ProgramSpec = {
  name: "dwh",
  description: "deliver files to the user",
};

export const commands: readonly CommandSpec[] = [
  {
    name: "check",
    id: "dwh.check",
    summary: "verify the configuration and the destination; sends nothing",
    default: false,
    hidden: false,
    workflow: checkWorkflow,
  },
  {
    name: "send",
    id: "dwh.send",
    summary: "deliver one or more files to the user",
    default: true,
    hidden: false,
    workflow: sendWorkflow,
  },
];
