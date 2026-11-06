import { formatDiagnostic, scrubDiagnostic, type Diagnostic } from "./diagnostics.js";
import { isRecord } from "./json.js";
import type { Wording } from "./wording.js";

export const EXIT_OK: number = 0;
export const EXIT_FAILURE: number = 1;
export const EXIT_USAGE: number = 2;

export interface Reporter {
  readonly line: (text: string) => void;
  readonly advice: (diagnostic: Diagnostic) => void;
  readonly succeed: (payload: Readonly<Record<string, unknown>>) => number;
  readonly fail: (
    diagnostics: readonly Diagnostic[],
    exitCode: number,
    payload?: Readonly<Record<string, unknown>>,
  ) => number;
}

export interface ReporterIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export function makeReporter(
  io: ReporterIo,
  wording: Wording,
  json: boolean,
  quiet: boolean,
): Reporter {
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

export function scrubValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") {
    return scrub(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => scrubValue(entry, scrub));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [scrub(key), scrubValue(entry, scrub)]),
    );
  }
  return value;
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
