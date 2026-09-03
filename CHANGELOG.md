# Changelog

## 0.2.0

The agent-facing surface was rebuilt around two conventions: the agent-oriented CLI
guidelines (non-interactive, layered help with examples, fail-fast diagnostics, dry runs,
structured output) and the compact single-line diagnostic format.

### Added

- `dwh check`: verifies the configuration and the destination with one GET request; nothing is posted.
- `dwh send`: the explicit spelling of the default command. `dwh -- check` sends a file literally named `check`.
- `--dry-run`: resolves every input exactly like a real run and prints the plan; nothing is sent.
- `--json`: one JSON object on stdout with per-file name, size, message id, attachment id and URL,
  message count, and duration; failures carry the diagnostics and whatever was delivered first.
- `-q, --quiet`: nothing but errors (a `--json` result is still printed).
- Layered help: `dwh --help` lists the commands and global options; `dwh send --help` and
  `dwh check --help` carry that command's options, an Examples section, and behavior notes.
- `DWH_HIDE_DESTINATION=1`: every output (help, progress notes, errors, `--json`, `check`) speaks
  only of "the user" and "the destination"; webhook URLs become `<destination>` even in text
  echoed from the network, and attachment URLs are left out of `--json`.
- Usage errors, missing files, directories, devices, oversized files, and failed downloads now end
  with `help:` and a copy-pasteable command (`ls -la`, `zip -r`, `split -b 9M`, `curl -sSI`, ...).
  Running `dwh` with piped stdin but no `-` says so.
- Error-code-specific hints: 40005 / 413 (names the largest file), 10015 / 50027 / 401 / 403 / 404
  (bad destination), 10003 (stale `thread_id`), 50035 (invalid form body).
- Library: `run`, `checkWebhook`, `resolveWebhookConfig`, `isWebhookUrl`, `DiagnosticError`,
  `formatDiagnostic`, `scrubDiagnostic`, `diagnosticsOf`, `wordingFor`, `hideDestinationFrom`,
  `neutralize`; `sendFiles` returns a `SendResult` with one `Delivery` per file (message id,
  attachment id, URL). Diagnostics and notes reach callers scrubbed (tokens redacted, the service
  unnamed when hidden), and `sendFiles` / `checkWebhook` validate their URL, throwing
  `invalid-config` instead of a raw `TypeError`.
- A webhook URL given as an input is refused instead of downloaded (that would post the webhook
  object, token included, into the channel), and so is an input whose redirects land on one;
  percent-encoded spellings of the path are recognized, and redacted in canonical form.
- A file whose contents cannot be read even though it exists (mode 000, an I/O error) is reported
  as `unreadable` with the permission hint, not as `internal`.

### Changed

- stderr carries exactly one line per diagnostic in the form
  `{location}: {severity} dwh({code}): {message} help: {remediation}`, where the location is the
  input (path, URL, `stdin`) or `dwh`, the severity is `error` or `advice`, and the code is stable.
  Previously lines were `dwh: <message>` and could span several lines.
- Library: `onNote(string)` became `onDiagnostic(Diagnostic)`; `onSent(file)` became
  `onSent(file, delivery)`; every thrown error is a `DiagnosticError` whose `message` is the
  formatted lines; `OutgoingFile` gained an optional `source`.
- Messages use plain ASCII punctuation.

## 0.1.1

Initial public release.
