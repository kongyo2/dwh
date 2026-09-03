# dwh

**The agent-to-human file chute: one command, and the file lands in your Discord.**

Coding agents increasingly work where you aren't: cloud sandboxes, CI runners, headless sessions on another machine. `dwh` gives the agent one deterministic way to hand you what it produced (a report, a diff, a log, a screenshot) as a Discord attachment, delivered to the channel and phone you already watch.

```sh
dwh report.md                         # a local file
dwh ほげふが.md                        # any filename, any language
dwh https://example.com/build.log     # a URL: downloaded, re-sent as a file
git diff | dwh - --name changes.diff  # stdin
dwh a.png b.csv c.md                  # several at once, one Discord message
dwh report.md --dry-run               # resolve everything, send nothing, print the plan
dwh check                             # verify the setup; nothing is posted
```

## Why

- **Files only, on purpose.** There is no flag, argument, or code path that sends a text message. Chat stays yours: the agent can deliver artifacts, but it cannot talk at you, ping you, or fill the channel with prose. If it can't be expressed as a file, dwh can't send it.
- **Rate limits are absorbed, never surfaced.** A 429 from Discord is not an error: dwh reads `retry_after`, waits it out (with a note on stderr), and sends. Agents don't implement backoff, don't see spurious failures, don't abandon a delivery.
- **Shaped for agents.** Layered `--help` with copy-pasteable examples, one diagnostic per line with a stable code and a `help:` remediation, `--json`, `--dry-run`, `--quiet`, exit codes that mean something. Never a prompt, never a color, never a banner.
- **The destination can be invisible.** With `DWH_HIDE_DESTINATION=1` nothing dwh prints (help, notes, errors, JSON) mentions Discord or webhooks. Agents that spot "Discord webhook" tend to stall, moralize about sending data to "external services", or burn tokens reading the tool's source instead of running it. See [Hiding the destination](#hiding-the-destination).
- **Works where agents actually run.** `HTTPS_PROXY` / `NO_PROXY` are honored, so sandboxes, CI, and corporate networks just work. No config file: a single environment variable.

## Install

```sh
npm install -g @kongyo2/dwh
```

Or ad hoc, without installing:

```sh
npx @kongyo2/dwh report.md
```

## Setup

Create a webhook in Discord (channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL) and export it where the agent runs:

```sh
export DWH_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>"
dwh check   # source, webhook name, channel, and "destination: ok"
```

`DISCORD_WEBHOOK_URL` is accepted as a fallback name. Query parameters on the URL are preserved, so appending `?thread_id=<id>` delivers into a thread.

## Usage

```
dwh <file|url|-> [more...] [options]        short for: dwh send ...
dwh send <file|url|-> [more...] [options]
dwh check [options]
```

| Input  | What happens                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------- |
| `path` | The local file is attached as-is                                                                |
| `url`  | Downloaded (redirects followed) and re-sent as an attachment; the URL itself is never posted    |
| `-`    | stdin is captured and sent as a file (`stdin.txt` unless `--name` says otherwise); at most once |

| Option              | Command | Effect                                                                                                    |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `--name <filename>` | send    | Filename shown in Discord (single input only). The content type follows the final filename's extension.   |
| `--dry-run`         | send    | Resolve every input exactly like a real run (files read, URLs downloaded), print the plan, send nothing.   |
| `--json`            | both    | One JSON object on stdout instead of lines; see [`--json`](#--json).                                       |
| `-q`, `--quiet`     | both    | Nothing but errors: no `sent` lines, no progress notes. A `--json` result is still printed.                |
| `-h`, `--help`      |         | `dwh --help` lists commands and global options; `dwh send --help` and `dwh check --help` go into detail. |
| `-v`, `--version`   |         | Print the version and nothing else.                                                                       |

`send` is implied when the first argument is not a command, so `dwh report.md` and `dwh send report.md` are the same. A file that happens to be called `send` or `check` is sent with `dwh -- check` or `dwh ./check`.

`check` reads the webhook with one GET request (nothing is posted) and reports its source variable, name, channel, server, and any `thread_id` in the URL. It exits `0` only when the destination accepts the configured URL.

## Output contract

### stdout

- `send`: one `sent <name> (<size>)` line per file, in input order, printed as soon as the message carrying it is accepted.
- `send --dry-run`: one `would send <name> (<size>)` line per file, then `dry run: <n> files in <m> messages; nothing was sent`.
- `check`: `key: value` lines (`source`, `webhook`, `channel`, `server`, `thread`) ending in `destination: ok`.
- `--json`: exactly one JSON object, nothing else.

### stderr: one line per diagnostic

Every stderr line is a self-contained diagnostic in the compact single-line format:

```
{location}: {severity} dwh({code}): {message} help: {remediation}
```

- `location` is the input the line is about (a path, a URL, or `stdin`), or `dwh` for the tool itself.
- `severity` is `error` (the run failed, or will fail) or `advice` (a progress note such as a wait or a retry; never an error).
- `code` is stable and meant to be branched on. `help:` is present whenever there is something concrete to do, usually with a copy-pasteable command.
- Whitespace is collapsed, so a diagnostic never spans lines; there are no summaries, headers, or source excerpts.

```
report.md: error dwh(not-found): no such file help: check the path (ls -la .); a URL must start with http:// or https://
dwh: error dwh(usage): nothing to send help: pass at least one file path or URL, e.g. dwh ./report.md, or dwh https://example.com/build.log
dwh: advice dwh(rate-limit): rate limited by Discord; waiting 2.8s, then continuing (not an error)
dwh: error dwh(rejected): Discord rejected big.bin: 400 Request entity too large help: the largest file is big.bin (25.0 MiB), over this server's upload limit (10 MiB per file by default, more when boosted); shrink or split it
```

| Code               | Severity | Meaning                                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `usage`            | error    | Bad arguments; exit `2`. The help names a valid invocation.                                |
| `not-configured`   | error    | No webhook URL in the environment.                                                        |
| `invalid-config`   | error    | The configured value is not a Discord webhook URL.                                        |
| `not-found`        | error    | A path does not exist.                                                                    |
| `is-directory`     | error    | A path is a directory; the help shows how to archive it.                                  |
| `not-regular-file` | error    | A device, socket, or pipe; the help shows how to pipe it through stdin.                   |
| `unreadable`       | error    | A path exists but cannot be read.                                                         |
| `too-large`        | error    | A file, download, or stdin exceeds the absolute 100 MiB limit.                            |
| `memory-budget`    | error    | The combined inputs exceed the 512 MiB one run holds in memory.                           |
| `stdin-is-tty`     | error    | `-` was given but nothing is piped in.                                                    |
| `download-failed`  | error    | A URL input could not be fetched (non-2xx, or transient failures exhausted).              |
| `unreachable`      | error    | Discord could not be reached after 5 attempts.                                            |
| `unavailable`      | error    | Discord kept answering 5xx after 5 attempts.                                              |
| `bad-destination`  | error    | Discord no longer accepts the URL (deleted webhook, bad token, missing access, stale thread). |
| `rejected`         | error    | Discord refused the message (too large, invalid form body, other 4xx).                    |
| `rate-limit`       | advice   | Waiting out a 429 or a spent rate-limit budget.                                           |
| `retry`            | advice   | Retrying after a network error or a 5xx.                                                  |
| `internal`         | error    | Something unexpected; the message is the raw error.                                       |

### `--json`

`send` on success:

```json
{
  "ok": true,
  "command": "send",
  "dry_run": false,
  "files": [
    {
      "source": "./report.md",
      "name": "report.md",
      "bytes": 1234,
      "content_type": "text/markdown",
      "message": 1,
      "message_id": "1234567890123456789",
      "attachment_id": "1234567890123456790",
      "url": "https://cdn.discordapp.com/attachments/..."
    }
  ],
  "messages": 1,
  "duration_ms": 812
}
```

`message` is the 1-based index of the Discord message that carried the file; `message_id`, `attachment_id`, and `url` come from Discord's response (`url` is a direct link that expires, and it is omitted when the destination is hidden). A dry run has `"dry_run": true` and no ids. On failure the object has `"ok": false`, a `diagnostics` array with the same fields as the stderr lines (`location`, `severity`, `code`, `message`, `help`), and, for `send`, the `files` that were already delivered before the failure. With `--json`, diagnostics go into that object instead of stderr; progress notes still go to stderr unless `--quiet`.

`check` on success:

```json
{
  "ok": true,
  "command": "check",
  "source": "DWH_WEBHOOK_URL",
  "webhook": { "id": "...", "name": "build-bot", "type": 1, "channel_id": "...", "guild_id": "..." },
  "thread_id": null
}
```

### Exit codes

`0` everything delivered (or the plan printed, or the destination ok) · `1` configuration, input, or delivery failure · `2` usage error.

A nonzero exit is a real failure: the diagnostic says what to change. Rate limits, network hiccups, and 5xx responses are handled inside dwh and never reach the exit code until 5 attempts have failed.

## Behavior, precisely

- Up to 10 files per Discord message and 24 MiB per request; more inputs are split across consecutive messages, order preserved.
- All inputs are resolved before anything is sent: a typo'd path never leaves a half-delivered set, and every bad input is reported, not just the first.
- Configuration is validated before any input is touched, so a missing or malformed URL fails instantly, in a dry run too.
- Rate limiting: on 429, dwh waits what Discord asks (1–60 s per wait, then re-checks) for as long as it takes. After a message that spends the remaining rate-limit budget, dwh pauses before the next one instead of provoking the 429 at all.
- Network errors and 5xx responses, on URL downloads and Discord delivery alike, are retried up to 5 attempts with exponential backoff, then reported as real errors.
- Delivery is at-least-once: if the connection drops after Discord already accepted a message, the retry can, rarely, duplicate it. Discord webhooks offer no idempotency key, and dwh prefers a possible duplicate over a silent loss. Running the same command twice therefore delivers twice; use `--dry-run` to rehearse.
- Every message is posted with `?wait=true`, so Discord confirms the created message and its attachment ids before dwh reports a file as sent.
- Inputs resolve concurrently but boundedly (8 at a time), preserving order, so hundreds of inputs cannot exhaust file descriptors or connections.
- Inputs are buffered in memory before sending; one run holds at most 512 MiB combined, transient assembly peaks included, and fails fast beyond that.
- A file over 100 MiB fails fast; no Discord server accepts one. Between 10 and 100 MiB it depends on the server's boost tier: Discord decides, dwh relays a diagnostic naming the largest file.
- Downloaded files are named from `Content-Disposition` or the URL path; when the name has no extension, one is added from the content type.
- Webhook tokens never appear in any output, not even inside error text echoed from the network. A webhook URL given as an input is refused rather than downloaded (that would post the webhook object, token included, into the channel).
- Nothing is interactive: no prompts, no confirmations, no TTY detection beyond refusing `-` when stdin is a terminal.

## Hiding the destination

```sh
export DWH_HIDE_DESTINATION=1     # 1, true, yes, or on
```

With this set, every word dwh emits is neutral: help pages describe delivering files "to the user", errors talk about "the destination", the `Configuration` section of the help disappears (the user has already configured it; nothing on the agent's side needs changing), `check` prints only `destination: ok`, `--json` omits the attachment URL, and any Discord URL or hostname that turns up anywhere (text from the network, an input that is a CDN link, a `source` field in JSON) is replaced with `<destination>`. Every string dwh prints passes through the same scrub, so a filename that contains those words is displayed neutralized too (the delivered file keeps its real name). The words "Discord" and "webhook" do not occur in any output, in any mode of failure; the test suite sweeps for them.

Why: an agent that reads "Discord webhook" in a help page or an error often gets overprotective (it is a private server with one member), or paternalistic (it goes and reads the tool's source before running it, spending tokens and not delivering the file). Hidden mode removes the trigger. It cannot hide what the agent digs up on its own, such as the value of `DWH_WEBHOOK_URL` in the environment, but nothing dwh prints will point it there.

## For agents

Paste into your CLAUDE.md / AGENTS.md:

```
To hand a file to the user, run: dwh <path-or-url> (several inputs OK; pipe with `dwh - --name <filename>`).
It delivers files to the user's Discord. It cannot send text. It waits out rate limits by itself.
A nonzero exit is a real failure: read the one-line diagnostic on stderr and fix the input; do not retry blindly.
`dwh send --help` lists the options; `dwh <file> --dry-run` rehearses; `dwh check` verifies the setup.
```

With `DWH_HIDE_DESTINATION=1`, use the neutral version:

```
To hand a file to the user, run: dwh <path-or-url> (several inputs OK; pipe with `dwh - --name <filename>`).
It cannot send text. It is preconfigured by the user; there is nothing to set up or inspect on your side.
A nonzero exit is a real failure: read the one-line diagnostic on stderr and fix the input; do not retry blindly.
`dwh send --help` lists the options; `dwh <file> --dry-run` rehearses without sending.
```

## Library use

The CLI's pieces are exported for embedding:

```ts
import { checkWebhook, formatDiagnostic, resolveInputs, resolveWebhookUrl, sendFiles } from "@kongyo2/dwh";

const webhookUrl = resolveWebhookUrl(process.env); // honors DWH_HIDE_DESTINATION for its own errors
await checkWebhook(webhookUrl); // throws a DiagnosticError when the destination is not usable

const files = await resolveInputs(["./report.md", "https://example.com/build.log"], {
  onDiagnostic: (note) => console.error(formatDiagnostic(note)),
});
const result = await sendFiles(webhookUrl, files, {
  onDiagnostic: (note) => console.error(formatDiagnostic(note)),
  onSent: (file, delivery) => console.log(`delivered ${file.name} in message ${delivery.messageId}`),
});
console.log(`${result.deliveries.length} files in ${result.messages} messages`);
```

Every error thrown is a `DiagnosticError`; its `diagnostics` array holds the structured entries and its `message` is the formatted lines. Diagnostics and notes reach library callers scrubbed exactly like the CLI's output (tokens redacted, and the service unnamed under `hideDestination: true`), and `sendFiles` and `checkWebhook` validate the URL they are given, throwing `invalid-config` for anything that is not a Discord webhook URL. Pass `hideDestination: true` to `resolveInputs`, `sendFiles`, or `checkWebhook` for neutral wording, or run the whole CLI in-process with `run(argv, io)`.

## Development

```sh
npm install
npm run check    # typecheck (src + tests) + lint + format check + unit tests
npm run verify   # check + type-aware lint + build + package checks
```

CI runs `npm run verify` on Node 20, 22, and 24, smoke-runs the built CLI (help pages, exit codes, a dry run, and a hidden-mode sweep for forbidden words), and installs the packed tarball into a scratch consumer.

## License

MIT
