export {
  describeFetchError,
  proxyAwareFetch,
  type FetchLike,
  type RequestOptions,
} from "./api/http.js";
export { checkWebhook, type CheckOptions, type WebhookInfo } from "./commands/check/probe.js";
export {
  MAX_BATCH_BYTES,
  MAX_FILES_PER_MESSAGE,
  planBatches,
  sendFiles,
  type Delivery,
  type SendOptions,
  type SendResult,
} from "./commands/send/deliver.js";
export {
  filenameForDownload,
  isUrl,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  resolveInputs,
  type OutgoingFile,
  type ResolveOptions,
} from "./commands/send/inputs.js";
export {
  isWebhookUrl,
  resolveWebhookConfig,
  resolveWebhookUrl,
  WEBHOOK_ENV_VARS,
  type WebhookConfig,
  type WebhookEnvVar,
} from "./destination.js";
export {
  compactText,
  DiagnosticError,
  diagnosticsOf,
  formatDiagnostic,
  scrubDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type Severity,
} from "./lib/diagnostics.js";
export {
  HIDE_DESTINATION_ENV_VAR,
  hideDestinationFrom,
  neutralize,
  redactWebhookTokens,
  wordingFor,
  wordingFromEnv,
  type Wording,
} from "./lib/wording.js";
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run, type RunIo } from "./run.js";
