# dwh

dwh delivers the files a coding agent produces to you, as attachments in your Discord channel. It sends files and nothing else.

```sh
dwh report.md                         # a local file
dwh ほげふが.md                        # any filename, any language
dwh https://example.com/build.log     # a URL, downloaded and re-sent as a file
git diff | dwh - --name changes.diff  # stdin
dwh a.png b.csv c.md                  # several files, in as few messages as possible
dwh report.md --dry-run               # resolve every input and print the plan; nothing is sent
dwh check                             # verify the setup; nothing is posted
```

## Design

- **Files only.** dwh has no way to send a text message. An agent can hand you artifacts, but it cannot talk at you, ping you, or fill the channel with prose.
- **Rate limits are absorbed.** On a 429, dwh waits as long as Discord asks, notes the wait on stderr, and sends. Network errors and 5xx responses are retried. A nonzero exit means the delivery really failed.
- **Output for agents.** Layered `--help` with examples, one diagnostic per line with a stable code and a fix, `--json`, `--dry-run`, and `--quiet`. dwh never prompts and never prints color.
- **The destination can be hidden.** Agents that read "Discord webhook" in a tool's output tend to stall, or go read the tool's source instead of running it. With `DWH_HIDE_DESTINATION=1`, nothing dwh prints mentions either word. See [Hiding the destination](#hiding-the-destination).
- **Works where agents run.** `HTTPS_PROXY` and `NO_PROXY` are honored, and the whole configuration is one environment variable.

## Install

```sh
npm install -g @kongyo2/dwh
```

Or run it without installing: `npx @kongyo2/dwh report.md`. dwh needs Node.js 20.18.1 or later.

## Setup

Create a webhook in Discord (channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL) and export its URL where the agent runs:

```sh
export DWH_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>"
dwh check
```

`dwh check` prints the variable it read, the webhook's name, channel, and server, and ends with `destination: ok`. `DISCORD_WEBHOOK_URL` works as a fallback name. To deliver into a thread, append `?thread_id=<id>` to the URL.

## Usage

```
dwh <file|url|-> [more...] [options]        short for: dwh send ...
dwh send <file|url|-> [more...] [options]
dwh check [options]
```

| Input  | What happens                                                                               |
| ------ | ------------------------------------------------------------------------------------------ |
| `path` | The file is attached as it is.                                                             |
| `url`  | The URL is downloaded (redirects followed) and re-sent as an attachment. The URL itself is never posted. |
| `-`    | stdin is sent as a file, `stdin.txt` unless `--name` says otherwise. It can be given once. |

| Option              | Command | Effect                                                                                          |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `--name <filename>` | send    | The filename shown in Discord, for a single input. Its extension also sets the content type.    |
| `--dry-run`         | send    | Resolve every input as a real run would (files read, URLs downloaded), print the plan, send nothing. |
| `--json`            | both    | Print one JSON object on stdout instead of lines. See [`--json`](#--json).                      |
| `-q`, `--quiet`     | both    | Print nothing but errors. A `--json` result is still printed.                                   |
| `-h`, `--help`      |         | `dwh --help` lists the commands; `dwh send --help` and `dwh check --help` describe one.         |
| `-v`, `--version`   |         | Print the version.                                                                              |

`send` runs when the first argument is not a command, so `dwh report.md` and `dwh send report.md` do the same. To send a file named `send` or `check`, write `dwh -- check` or `dwh ./check`.

`check` reads the webhook with one GET request and posts nothing. It exits `0` only when Discord accepts the configured URL.

## Output

### stdout

- `send`: one `sent <name> (<size>)` line per file, in input order, as soon as the message carrying it is accepted.
- `send --dry-run`: one `would send <name> (<size>)` line per file, then `dry run: <n> files in <m> messages; nothing was sent`.
- `check`: `source`, `webhook`, `channel`, `server`, and `thread` lines, then `destination: ok`.
- `--json`: one JSON object and nothing else.

### stderr

Each line is one diagnostic:

```
{location}: {severity} dwh({code}): {message} help: {remediation}
```

- `location` is the input the line is about (a path, a URL, or `stdin`), or `dwh` for the tool itself.
- `severity` is `error` when the run fails, or `advice` for a progress note such as a wait or a retry.
- `code` is stable; branch on it. `help:` follows whenever there is something concrete to do, usually a command to copy.
- Whitespace is collapsed, so a diagnostic never spans lines.

```
report.md: error dwh(not-found): no such file help: check the path (ls -la .); a URL must start with http:// or https://
dwh: error dwh(usage): nothing to send help: pass at least one file path or URL, e.g. dwh ./report.md, or dwh https://example.com/build.log
dwh: advice dwh(rate-limit): rate limited by Discord; waiting 2.8s, then continuing (not an error)
dwh: error dwh(rejected): Discord rejected big.bin: 400 Request entity too large help: the largest file is big.bin (25.0 MiB), over this server's upload limit (10 MiB per file by default, more when boosted); shrink or split it
```

| Code               | Severity | Meaning                                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `usage`            | error    | Bad arguments; exit `2`. The help names a valid invocation.                                   |
| `not-configured`   | error    | No webhook URL in the environment.                                                            |
| `invalid-config`   | error    | The configured value is not a Discord webhook URL.                                            |
| `not-found`        | error    | A path does not exist.                                                                        |
| `is-directory`     | error    | A path is a directory; the help shows how to archive it.                                      |
| `not-regular-file` | error    | A device, socket, or pipe; the help shows how to pipe it through stdin.                       |
| `unreadable`       | error    | A path exists but cannot be read.                                                             |
| `too-large`        | error    | A file, download, or stdin is over the absolute limit of 100 MiB.                             |
| `memory-budget`    | error    | The inputs together are over the 512 MiB one run holds in memory.                             |
| `stdin-is-tty`     | error    | `-` was given but nothing is piped in.                                                        |
| `download-failed`  | error    | A URL could not be fetched: a non-2xx response, or 5 failed attempts.                         |
| `unreachable`      | error    | Discord could not be reached in 5 attempts.                                                   |
| `unavailable`      | error    | Discord answered 5xx to 5 attempts.                                                           |
| `bad-destination`  | error    | Discord no longer accepts the URL: a deleted webhook, a bad token, lost access, or a stale thread. |
| `rejected`         | error    | Discord refused the message: too large, an invalid form body, or another 4xx.                 |
| `rate-limit`       | advice   | Waiting out a 429, or a spent rate-limit budget.                                              |
| `retry`            | advice   | Retrying after a network error or a 5xx.                                                      |
| `internal`         | error    | Something unexpected; the message is the raw error.                                           |

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

`message` is the 1-based index of the message that carried the file. `message_id`, `attachment_id`, and `url` come from Discord's response; `url` is a direct link that expires, and it is left out when the destination is hidden. A dry run has `"dry_run": true` and no ids.

On failure the object has `"ok": false` and a `diagnostics` array with the fields of the stderr lines (`location`, `severity`, `code`, `message`, `help`). For `send`, `files` lists what was delivered before the failure. With `--json`, errors go into the object instead of stderr; progress notes still go to stderr unless `--quiet`.

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

`0` everything delivered, the plan printed, or the destination ok · `1` configuration, input, or delivery failure · `2` usage error.

## Behavior

- A message carries up to 10 files and 24 MiB. More inputs are split across messages, in order.
- Every input is resolved before anything is sent, and every bad input is reported, so a mistyped path never leaves half a set delivered.
- The configuration is checked before any input is read, so a missing or malformed URL fails at once, in a dry run too.
- On a 429, dwh waits what Discord asks (1 to 60 seconds per wait, then it asks again) for as long as it takes. After a message that spends the rate-limit budget, it pauses before the next one.
- Network errors and 5xx responses, for downloads and deliveries alike, are retried up to 5 attempts with exponential backoff.
- Delivery is at least once. If the connection drops after Discord accepted a message, the retry can send it again: Discord webhooks have no idempotency key, and a duplicate beats a silent loss. Running the same command twice delivers twice; rehearse with `--dry-run`.
- Messages are posted with `?wait=true`, so a file counts as sent only once Discord returns the created message and its attachment ids.
- Of the query parameters on the configured URL, `thread_id` is sent with every message.
- Inputs are resolved 8 at a time, in order.
- Inputs are held in memory: at most 100 MiB per file and 512 MiB per run. Between 10 and 100 MiB, whether Discord accepts a file depends on the server's boost level; when it refuses, the diagnostic names the largest file.
- A download is named from `Content-Disposition` or the URL path. A name without an extension gets one from the content type.
- Webhook tokens never appear in any output. A webhook URL given as an input is refused, since downloading it would post the webhook object, token included, into the channel. So is a URL that redirects to one.

## Hiding the destination

```sh
export DWH_HIDE_DESTINATION=1     # 1, true, yes, or on
```

With this set, dwh speaks of "the user" and "the destination":

- help pages describe delivering files to the user, and their `Configuration` section says only that the user has already configured the destination;
- errors talk about the destination, and tell the agent that only the user can fix the setup;
- `check` prints only `destination: ok`, and `--json` leaves out attachment URLs;
- any Discord URL or hostname in the output, including text from the network and inputs that are Discord CDN links, becomes `<destination>`;
- the words are replaced inside filenames as well (`discord_backup.zip`, `MyWebhookNotes.md`), in the output only; the delivered file keeps its name.

The words "Discord" and "webhook" occur in no output, whatever fails; the test suite sweeps for them. An agent can still find `DWH_WEBHOOK_URL` in its environment, but nothing dwh prints points it there.

## For agents

Paste into your CLAUDE.md or AGENTS.md:

```
To hand a file to the user, run: dwh <path-or-url> (several inputs OK; pipe with `dwh - --name <filename>`).
It delivers files to the user's Discord. It cannot send text. It waits out rate limits by itself.
A nonzero exit is a real failure: read the one-line diagnostic on stderr and fix the input; do not retry blindly.
`dwh send --help` lists the options; `dwh <file> --dry-run` rehearses; `dwh check` verifies the setup.
```

With `DWH_HIDE_DESTINATION=1`:

```
To hand a file to the user, run: dwh <path-or-url> (several inputs OK; pipe with `dwh - --name <filename>`).
It cannot send text. It is preconfigured by the user; there is nothing to set up or inspect on your side.
A nonzero exit is a real failure: read the one-line diagnostic on stderr and fix the input; do not retry blindly.
`dwh send --help` lists the options; `dwh <file> --dry-run` rehearses without sending.
```

## Library

```ts
import { checkWebhook, formatDiagnostic, resolveInputs, resolveWebhookUrl, sendFiles } from "@kongyo2/dwh";

const webhookUrl = resolveWebhookUrl(process.env);
await checkWebhook(webhookUrl);

const files = await resolveInputs(["./report.md", "https://example.com/build.log"], {
  onDiagnostic: (note) => console.error(formatDiagnostic(note)),
});
const result = await sendFiles(webhookUrl, files, {
  onDiagnostic: (note) => console.error(formatDiagnostic(note)),
  onSent: (file, delivery) => console.log(`delivered ${file.name} in message ${delivery.messageId}`),
});
console.log(`${result.deliveries.length} files in ${result.messages} messages`);
```

Every error thrown is a `DiagnosticError`: its `diagnostics` array holds the entries, and its `message` is the formatted lines. Diagnostics reach callers scrubbed like the CLI's output. `sendFiles` and `checkWebhook` throw `invalid-config` for a URL that is not a Discord webhook URL. Pass `hideDestination: true` to `resolveInputs`, `sendFiles`, or `checkWebhook` for the neutral wording, or run the whole CLI in-process with `run(argv, io)`.

## Development

```sh
npm install
npm run check        # typecheck (src and tests), lint, format check, unit tests
npm run verify       # check, then type-aware lint, build, and package checks
npm run format:fix   # format with oxfmt
npm run lint:fix     # apply oxlint's fixes
```

- `src/_generated/` was generated by [cloudflare/forge](https://github.com/cloudflare/forge) from an OpenAPI description of the two Discord endpoints dwh calls, Execute Webhook and Get Webhook with Token. It holds each operation's path, query parameters, file parts, error codes, and upload limits, their request and response types, and the command table. The generator is not in this repository, so change these files directly.
- `src/api/` sends those operations: proxy-aware fetch, retries, rate-limit waits, and diagnostics for error responses.
- `src/commands/` is what `send` and `check` do.
- `src/lib/` parses arguments, renders help, and formats and scrubs output.

CI runs `npm run verify` on Node 20, 22, and 24, smoke-runs the built CLI, sweeps hidden mode for the forbidden words, and installs the packed tarball into a scratch project.

## License

MIT
