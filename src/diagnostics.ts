/**
 * Structured diagnostics, serialized one per line in the compact agent-oriented format:
 *
 *   {location}: {severity} dwh({code}): {message} help: {help}
 *
 * No source excerpts, no summaries, no decoration; whitespace collapsed; the `help:` tail
 * carries the remediation. Agents can branch on `dwh(<code>)` without parsing prose.
 */

export type Severity = "error" | "warning" | "advice";

export type DiagnosticCode =
  // usage and configuration
  | "usage"
  | "not-configured"
  | "invalid-config"
  // inputs
  | "not-found"
  | "is-directory"
  | "not-regular-file"
  | "unreadable"
  | "too-large"
  | "memory-budget"
  | "stdin-is-tty"
  | "download-failed"
  // delivery
  | "unreachable"
  | "unavailable"
  | "bad-destination"
  | "rejected"
  // progress notes (severity "advice")
  | "rate-limit"
  | "retry"
  // anything unexpected
  | "internal";

export interface Diagnostic {
  /** The input spec the diagnostic is about (path, URL, "stdin"), or "dwh" for the tool itself. */
  readonly location: string;
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  /** Remediation, ideally containing a copy-pasteable command. */
  readonly help?: string | undefined;
}

/** Collapse every whitespace run (tabs, newlines, NBSP included) to one space and trim. */
export function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = compactText(diagnostic.location) || "<unknown>";
  const help = diagnostic.help === undefined ? "" : compactText(diagnostic.help);
  const helpText = help === "" ? "" : ` help: ${help}`;
  return `${location}: ${diagnostic.severity} dwh(${diagnostic.code}): ${compactText(diagnostic.message)}${helpText}`;
}

export function errorDiagnostic(location: string, code: DiagnosticCode, message: string, help?: string): Diagnostic {
  return { location, severity: "error", code, message, help };
}

export function adviceDiagnostic(location: string, code: DiagnosticCode, message: string, help?: string): Diagnostic {
  return { location, severity: "advice", code, message, help };
}

/** The same diagnostic with every free-text field (location, message, help) passed through `scrub`. */
export function scrubDiagnostic(diagnostic: Diagnostic, scrub: (text: string) => string): Diagnostic {
  return {
    ...diagnostic,
    location: scrub(diagnostic.location),
    message: scrub(diagnostic.message),
    help: diagnostic.help === undefined ? undefined : scrub(diagnostic.help),
  };
}

/**
 * An error carrying one or more diagnostics. `message` is the formatted lines joined by
 * newlines, so a consumer that only logs `error.message` still gets the compact format.
 */
export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[], options?: ErrorOptions) {
    super(diagnostics.map(formatDiagnostic).join("\n"), options);
    this.name = "DiagnosticError";
    this.diagnostics = diagnostics;
  }
}

/** The diagnostics behind any thrown value; unexpected errors become a single `internal` one. */
export function diagnosticsOf(error: unknown, location = "dwh"): readonly Diagnostic[] {
  if (error instanceof DiagnosticError) {
    return error.diagnostics;
  }
  const message = error instanceof Error ? error.message : String(error);
  return [errorDiagnostic(location, "internal", message)];
}
