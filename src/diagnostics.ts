export type Severity = "error" | "warning" | "advice";

export type DiagnosticCode =
  | "usage"
  | "not-configured"
  | "invalid-config"
  | "not-found"
  | "is-directory"
  | "not-regular-file"
  | "unreadable"
  | "too-large"
  | "memory-budget"
  | "stdin-is-tty"
  | "download-failed"
  | "unreachable"
  | "unavailable"
  | "bad-destination"
  | "rejected"
  | "rate-limit"
  | "retry"
  | "internal";

export interface Diagnostic {
  readonly location: string;
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly help?: string | undefined;
}

export function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = compactText(diagnostic.location) || "<unknown>";
  const help = diagnostic.help === undefined ? "" : compactText(diagnostic.help);
  const helpText = help === "" ? "" : ` help: ${help}`;
  return `${location}: ${diagnostic.severity} dwh(${diagnostic.code}): ${compactText(diagnostic.message)}${helpText}`;
}

export type DiagnosticMaker = (location: string, code: DiagnosticCode, message: string, help?: string) => Diagnostic;

function makerFor(severity: Severity): DiagnosticMaker {
  return (location, code, message, help) => ({ location, severity, code, message, help });
}

export const errorDiagnostic: DiagnosticMaker = makerFor("error");

export const adviceDiagnostic: DiagnosticMaker = makerFor("advice");

export function scrubDiagnostic(diagnostic: Diagnostic, scrub: (text: string) => string): Diagnostic {
  return {
    ...diagnostic,
    location: scrub(diagnostic.location),
    message: scrub(diagnostic.message),
    help: diagnostic.help === undefined ? undefined : scrub(diagnostic.help),
  };
}

export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[], options?: ErrorOptions) {
    super(diagnostics.map(formatDiagnostic).join("\n"), options);
    this.name = "DiagnosticError";
    this.diagnostics = diagnostics;
  }
}

export function diagnosticsOf(error: unknown, location = "dwh"): readonly Diagnostic[] {
  if (error instanceof DiagnosticError) {
    return error.diagnostics;
  }
  const message = error instanceof Error ? error.message : String(error);
  return [errorDiagnostic(location, "internal", message)];
}
