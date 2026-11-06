import type { RequestOptions } from "../api/http.js";
import type { RunIo } from "./command.js";
import { diagnosticsOf, type Diagnostic } from "./diagnostics.js";
import type { Reporter } from "./reporter.js";
import type { Wording } from "./wording.js";

export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export async function attempt<T>(step: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await step() };
  } catch (error) {
    return { ok: false, diagnostics: diagnosticsOf(error) };
  }
}

export function requestOptions(io: RunIo, wording: Wording, reporter: Reporter): RequestOptions {
  return {
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
    onDiagnostic: reporter.advice,
    hideDestination: wording.hidden,
  };
}
