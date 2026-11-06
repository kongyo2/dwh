import { errorDiagnostic, type Diagnostic } from "../lib/diagnostics.js";
import { numberField, recordFromJson, stringField } from "../lib/json.js";
import { formatBytes, formatMiB } from "../lib/text.js";
import type { Wording } from "../lib/wording.js";
import type { ErrorRule, Operation, UploadFile } from "./operation.js";

const TOOL_LOCATION = "dwh";

export interface ApiErrorContext {
  readonly operation: Operation;
  readonly status: number;
  readonly bodyText: string;
  readonly files: readonly UploadFile[] | undefined;
  readonly wording: Wording;
}

export function matchErrorRule(
  rules: readonly ErrorRule[],
  status: number,
  code: number | undefined,
): ErrorRule | undefined {
  return rules.find(
    (rule) =>
      (rule.code === undefined || rule.code === code) &&
      (rule.status === undefined || rule.status === status),
  );
}

export function apiErrorDiagnostic(context: ApiErrorContext): Diagnostic {
  const { operation, status, bodyText, files, wording } = context;
  const record = recordFromJson(bodyText);
  const detail = stringField(record, "message") ?? bodyText.slice(0, 300);
  const code = numberField(record, "code");
  const detailText = detail.trim() === "" ? "" : ` ${wording.scrub(detail)}`;
  const subject =
    files === undefined
      ? `${wording.Service} refused the configured URL: ${status}${detailText}`
      : `${wording.Service} rejected ${files.map((file) => file.name).join(", ")}: ${status}${detailText}`;
  switch (matchErrorRule(operation.errors, status, code)?.kind) {
    case "too-large":
      return errorDiagnostic(
        TOOL_LOCATION,
        "rejected",
        subject,
        wording.uploadLimitHelp(largestOf(files), defaultLimitOf(operation)),
      );
    case "stale-thread":
      return errorDiagnostic(TOOL_LOCATION, "bad-destination", subject, wording.badThreadHelp);
    case "bad-destination":
      return errorDiagnostic(TOOL_LOCATION, "bad-destination", subject, wording.badDestinationHelp);
    case "invalid-form":
      return errorDiagnostic(
        TOOL_LOCATION,
        "rejected",
        subject,
        "the request body was refused; if a filename is unusual, send that input alone with --name <plain-ascii-name>",
      );
    default:
      return errorDiagnostic(
        TOOL_LOCATION,
        "rejected",
        subject,
        "this is not transient; fix the input or the setup before running the same command again",
      );
  }
}

function defaultLimitOf(operation: Operation): string {
  const bytes = operation.upload?.defaultFileBytes;
  if (bytes === undefined) {
    return "the default";
  }
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : formatMiB(bytes);
}

function largestOf(files: readonly UploadFile[] | undefined): string | undefined {
  let largest: UploadFile | undefined;
  for (const file of files ?? []) {
    if (largest === undefined || file.data.byteLength > largest.data.byteLength) {
      largest = file;
    }
  }
  return largest === undefined
    ? undefined
    : `${largest.name} (${formatBytes(largest.data.byteLength)})`;
}
