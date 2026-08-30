# dwh

**The agent-to-human file chute: one command, and the file lands in your Discord.**

Coding agents increasingly work where you aren't — cloud sandboxes, CI runners, headless sessions on another machine. `dwh` gives the agent one deterministic way to hand you what it produced (a report, a diff, a log, a screenshot) as a Discord attachment, delivered to the channel and phone you already watch.

```sh
dwh report.md                         # a local file
dwh ほげふが.md                        # any filename, any language
dwh https://example.com/build.log     # a URL — downloaded, re-sent as a file
git diff | dwh - --name changes.diff  # stdin
dwh a.png b.csv c.md                  # several at once, one Discord message
```

## Why

- **Files only, on purpose.** There is no flag, argument, or code path that sends a text message. Chat stays yours: the agent can deliver artifacts, but it cannot talk at you, ping you, or fill the channel with prose. If it can't be expressed as a file, dwh can't send it.
- **Rate limits are absorbed, never surfaced.** A 429 from Discord is not an error: dwh reads `retry_after`, waits it out (with a note on stderr), and sends. Agents don't implement backoff, don't see spurious failures, don't abandon a delivery.
- **Deterministic, agent-shaped output.** One `sent <name> (<size>)` line per delivered file on stdout; waits and retries on stderr; exit `0` only when everything was delivered. Errors are one line, actionable, and never contain the webhook token.
- **Works where agents actually run.** `HTTPS_PROXY` / `NO_PROXY` are honored, so sandboxes, CI, and corporate networks just work. No config file — a single environment variable.

## Install

```sh
npm install -g @kongyo2/dwh
```

Or ad hoc, without installing:

```sh
npx @kongyo2/dwh report.md
```

## Setup

Create a webhook in Discord (channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL) and export it where the agent runs:

```sh
export DWH_WEBHOOK_URL="https://discord.com/api/webhooks/<id>/<token>"
```

`DISCORD_WEBHOOK_URL` is accepted as a fallback name. Query parameters on the URL are preserved, so appending `?thread_id=<id>` delivers into a thread.

## Usage

```
dwh <file|url|-> [more...] [--name <filename>]
```

| Input  | What happens                                                                     |
| ------ | -------------------------------------------------------------------------------- |
| `path` | The local file is attached as-is                                                  |
| `url`  | Downloaded (redirects followed) and re-sent as an attachment — the URL itself is never posted |
| `-`    | stdin is captured and sent as a file (`stdin.txt` unless `--name` says otherwise) |

`--name <filename>` overrides the filename shown in Discord (single input only). The attachment's content type follows the final filename, so `--name log.json` also fixes how Discord previews it.

## Behavior, precisely

- Up to 10 files per Discord message and 24 MiB per request; more inputs are split across consecutive messages, order preserved.
- All inputs are resolved before anything is sent — a typo'd path never leaves a half-delivered set, and every bad input is reported, not just the first.
- Rate limiting: on 429, dwh waits what Discord asks (1–60 s per wait, then re-checks) for as long as it takes. After a message that spends the remaining rate-limit budget, dwh pauses before the next one instead of provoking the 429 at all.
- Network errors and 5xx responses — on URL downloads and Discord delivery alike — are retried up to 5 attempts with exponential backoff, then reported as real errors.
- Delivery is at-least-once: if the connection drops after Discord already accepted a message, the retry can — rarely — duplicate it. Discord webhooks offer no idempotency key, and dwh prefers a possible duplicate over a silent loss.
- Inputs resolve concurrently but boundedly (8 at a time), preserving order, so hundreds of inputs cannot exhaust file descriptors or connections.
- Inputs are buffered in memory before sending; one run holds at most 512 MiB combined — transient assembly peaks included — and fails fast beyond that.
- A file over 100 MiB fails fast; no Discord server accepts one. Between 10 and 100 MiB it depends on the server's boost tier — Discord decides, dwh relays a clear error.
- Downloaded files are named from `Content-Disposition` or the URL path; when the name has no extension, one is added from the content type.
- The webhook URL is validated up front, so a misconfigured variable fails with instructions instead of a confusing HTTP error.

Exit codes: `0` all files delivered · `1` config, input, or delivery failure · `2` usage error.

## For agents

Paste into your CLAUDE.md / AGENTS.md:

```
To hand a file to the user, run: dwh <path-or-url> (multiple inputs OK; pipe via `dwh - --name <filename>`).
It delivers files to the user's Discord. It cannot send text messages. It waits out Discord rate
limits by itself — treat a nonzero exit as a real failure, not something to retry blindly.
```

## Library use

The CLI's pieces are exported for embedding:

```ts
import { resolveInputs, resolveWebhookUrl, sendFiles } from "@kongyo2/dwh";

const files = await resolveInputs(["./report.md", "https://example.com/build.log"]);
await sendFiles(resolveWebhookUrl(process.env), files, {
  onSent: (file) => console.log(`delivered ${file.name}`),
});
```

## Development

```sh
npm install
npm run check    # typecheck (src + tests) + lint + format check + unit tests
npm run verify   # check + type-aware lint + build + package checks
```

CI runs `npm run verify` on Node 20, 22, and 24, smoke-runs the built CLI, and installs the packed tarball into a scratch consumer.

## Release

Manual, from the repository's Actions tab: run the **Release** workflow and pick the bump (patch / minor / major, or `none` to publish the current version as-is). It verifies everything, bumps `package.json`, tags, pushes, and publishes to npm. Requires the `NPM_TOKEN` repository secret — an npm automation token allowed to publish in the `@kongyo2` scope.

## License

MIT
