import { describe, expect, it } from "vitest";
import {
  adviceDiagnostic,
  compactText,
  DiagnosticError,
  diagnosticsOf,
  errorDiagnostic,
  formatDiagnostic,
} from "../src/diagnostics.js";

describe("formatDiagnostic", () => {
  it("serializes location, severity, rule, message, and help on one line", () => {
    expect(formatDiagnostic(errorDiagnostic("report.md", "not-found", "no such file", "check the path"))).toBe(
      "report.md: error dwh(not-found): no such file help: check the path",
    );
  });

  it("omits the help tail when there is none", () => {
    expect(formatDiagnostic(adviceDiagnostic("dwh", "rate-limit", "waiting 2.0s"))).toBe(
      "dwh: advice dwh(rate-limit): waiting 2.0s",
    );
    expect(formatDiagnostic(errorDiagnostic("dwh", "internal", "boom", "   "))).toBe("dwh: error dwh(internal): boom");
  });

  it("collapses every whitespace run to one space and trims, newlines and NBSP included", () => {
    const line = formatDiagnostic({
      location: "  config.json\t",
      severity: "error",
      code: "internal",
      message: "Failed to parse\nconfiguration  file ",
      help: "  try\r\n again  ",
    });
    expect(line).toBe("config.json: error dwh(internal): Failed to parse configuration file help: try again");
    expect(line).not.toContain("\n");
  });

  it("substitutes <unknown> for an empty location", () => {
    expect(formatDiagnostic(errorDiagnostic("", "internal", "lost"))).toBe("<unknown>: error dwh(internal): lost");
  });

  it("keeps colons inside messages intact", () => {
    const line = formatDiagnostic(errorDiagnostic("x.ts", "internal", "Expected `;` but found `:`"));
    expect(line).toBe("x.ts: error dwh(internal): Expected `;` but found `:`");
  });
});

describe("compactText", () => {
  it("normalizes tabs, newlines, carriage returns, and non-breaking spaces", () => {
    expect(compactText(" a\t\tb\r\nc d ")).toBe("a b c d");
  });
});

describe("DiagnosticError", () => {
  it("uses the formatted lines as its message so plain logging stays compact", () => {
    const error = new DiagnosticError([
      errorDiagnostic("a.txt", "not-found", "no such file"),
      errorDiagnostic("b.txt", "not-found", "no such file", "check the path"),
    ]);
    expect(error.name).toBe("DiagnosticError");
    expect(error.message).toBe(
      "a.txt: error dwh(not-found): no such file\nb.txt: error dwh(not-found): no such file help: check the path",
    );
    expect(error.diagnostics).toHaveLength(2);
  });

  it("is unwrapped by diagnosticsOf, which wraps anything else as internal", () => {
    const diagnostic = errorDiagnostic("dwh", "usage", "nothing to send");
    expect(diagnosticsOf(new DiagnosticError([diagnostic]))).toEqual([diagnostic]);
    expect(diagnosticsOf(new Error("unexpected"), "x.txt")).toEqual([
      errorDiagnostic("x.txt", "internal", "unexpected"),
    ]);
    expect(diagnosticsOf("plain string")).toEqual([errorDiagnostic("dwh", "internal", "plain string")]);
  });
});
