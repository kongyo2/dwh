import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/http.js";
import { run, type RunIo } from "../src/run.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/aBc_dEf-123";
const FORBIDDEN = /discord|webhook/i;

interface Captured {
  code: number;
  stdout: string[];
  stderr: string[];
  calls: Array<{ url: string; init: { method?: string; body?: unknown } }>;
}

interface Scenario {
  env?: Record<string, string | undefined>;
  responses?: Array<Response | Error>;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<Uint8Array>;
}

async function cli(argv: string[], scenario: Scenario = {}): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Captured["calls"] = [];
  const responses = [...(scenario.responses ?? [])];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({ url: String(url), init: init ?? {} });
    const outcome = responses.shift();
    if (outcome === undefined) {
      throw new Error("unexpected extra fetch call");
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }) as unknown as FetchLike;
  const io: RunIo = {
    env: scenario.env ?? {},
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    stdinIsTTY: scenario.stdinIsTTY ?? true,
    readStdin: scenario.readStdin,
    fetchImpl,
    sleep: () => Promise.resolve(),
    now: () => 0,
  };
  const code = await run(argv, io);
  return { code, stdout, stderr, calls };
}

function message(id = "m1", attachments: Array<{ id: string; url: string }> = []): Response {
  return new Response(JSON.stringify({ id, channel_id: "c1", attachments }), {
    status: 200,
    headers: { "x-ratelimit-remaining": "4" },
  });
}

function rejection(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function rateLimited(seconds: number): Response {
  return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: seconds }), {
    status: 429,
  });
}

function webhookObject(name = "build-bot"): Response {
  return new Response(JSON.stringify({ id: "223", name, type: 1, channel_id: "199", guild_id: "56" }), {
    status: 200,
  });
}

async function scratchFile(name: string, content = "content"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dwh-run-"));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function parseJsonLine(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

const configured = { DWH_WEBHOOK_URL: WEBHOOK };
const hiddenConfigured = { DWH_WEBHOOK_URL: WEBHOOK, DWH_HIDE_DESTINATION: "1" };

describe("help", () => {
  it("lists the commands and global options at the root without the per-command options", async () => {
    const { code, stdout } = await cli(["--help"]);
    expect(code).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("Commands:");
    expect(text).toContain("  send ");
    expect(text).toContain("  check ");
    expect(text).toContain("Examples:");
    expect(text).toContain("dwh send --help");
    expect(text).not.toContain("--dry-run");
  });

  it("shows a command's own page, with examples, when the command is named", async () => {
    const send = await cli(["send", "-h"]);
    expect(send.code).toBe(0);
    expect(send.stdout.join("\n")).toContain("--dry-run");
    expect(send.stdout.join("\n")).toContain("Examples:");
    expect(send.stdout.join("\n")).toContain("git diff | dwh send - --name changes.diff");
    const check = await cli(["-h", "check"]);
    expect(check.stdout.join("\n")).toContain("Checks:");
    expect(check.stdout.join("\n")).toContain("dwh check --json");
  });

  it("shows the root page for -h with plain inputs", async () => {
    const { stdout } = await cli(["report.md", "-h"]);
    expect(stdout.join("\n")).toContain("Commands:");
  });

  it("names Discord only when the destination is not hidden", async () => {
    for (const argv of [["--help"], ["send", "--help"], ["check", "--help"]]) {
      const branded = await cli(argv);
      expect(branded.stdout.join("\n")).toMatch(FORBIDDEN);
      const hidden = await cli(argv, { env: { DWH_HIDE_DESTINATION: "1" } });
      expect(hidden.code).toBe(0);
      expect(hidden.stdout.join("\n")).not.toMatch(FORBIDDEN);
      expect(hidden.stdout.join("\n")).toContain("Examples:");
    }
  });

  it("prints the package version", async () => {
    const { code, stdout } = await cli(["--version"]);
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(code).toBe(0);
    expect(stdout).toEqual([pkg.version]);
  });
});

describe("usage errors", () => {
  it("fails fast with an example when nothing is passed", async () => {
    const { code, stdout, stderr, calls } = await cli([], { env: configured });
    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(calls).toEqual([]);
    expect(stderr).toEqual([
      "dwh: error dwh(usage): nothing to send help: pass at least one file path or URL, e.g. dwh ./report.md, or dwh https://example.com/build.log",
    ]);
  });

  it("points at - when stdin is piped but not named", async () => {
    const { code, stderr } = await cli([], { env: configured, stdinIsTTY: false });
    expect(code).toBe(2);
    expect(stderr[0]).toContain('name it with "-", e.g. git diff | dwh - --name changes.diff');
  });

  it("rejects unknown options, as JSON when --json was on the line", async () => {
    const plain = await cli(["--bogus", "a.txt"]);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toEqual([
      "dwh: error dwh(usage): Unknown option '--bogus' help: run dwh --help for the options, or dwh send --help",
    ]);
    const missingValue = await cli(["a.txt", "--name"]);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr[0]).toMatch(/^dwh: error dwh\(usage\): Option '--name <value>' argument missing help: /);
    const json = await cli(["--bogus", "a.txt", "--json"]);
    expect(json.code).toBe(2);
    expect(json.stderr).toEqual([]);
    const payload = parseJsonLine(json.stdout);
    expect(payload["ok"]).toBe(false);
    expect((payload["diagnostics"] as Array<{ code: string }>)[0]?.code).toBe("usage");
  });

  it("explains --name with several inputs using a copy-pasteable fix", async () => {
    const { code, stderr } = await cli(["a.txt", "b c.txt", "--name", "x.txt"], { env: configured });
    expect(code).toBe(2);
    expect(stderr).toEqual([
      "dwh: error dwh(usage): --name applies to a single input, but 2 inputs were given help: drop --name, or send that input alone: dwh a.txt --name x.txt",
    ]);
  });

  it("allows stdin only once", async () => {
    const { code, stderr } = await cli(["-", "-"], { env: configured });
    expect(code).toBe(2);
    expect(stderr[0]).toContain('"-" (stdin) can be given only once');
  });

  it("keeps check free of inputs and send-only options", async () => {
    expect((await cli(["check", "a.txt"], { env: configured })).stderr[0]).toContain(
      "check takes no inputs (got a.txt) help: run dwh check by itself; to send that file run dwh send a.txt",
    );
    expect((await cli(["check", "--name", "x"], { env: configured })).code).toBe(2);
    expect((await cli(["check", "--dry-run"], { env: configured })).code).toBe(2);
  });
});

describe("send", () => {
  it("posts the file with wait=true and prints one sent line", async () => {
    const path = await scratchFile("report.md", "# hi");
    const { code, stdout, stderr, calls } = await cli([path], { env: configured, responses: [message()] });
    expect(code).toBe(0);
    expect(stdout).toEqual(["sent report.md (4 B)"]);
    expect(stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${WEBHOOK}?wait=true`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("accepts the explicit send command and a -- terminator", async () => {
    const path = await scratchFile("check", "x");
    const explicit = await cli(["send", path], { env: configured, responses: [message()] });
    expect(explicit.code).toBe(0);
    expect(explicit.stdout).toEqual(["sent check (1 B)"]);
    const terminated = await cli(["--", "check"], { env: configured });
    expect(terminated.code).toBe(1);
    expect(terminated.stderr[0]).toMatch(
      /^check: error dwh\(not-found\): no such file help: check the path \(ls -la \.\)/,
    );
  });

  it("sends stdin as a file", async () => {
    const { code, stdout } = await cli(["-", "--name", "changes.diff"], {
      env: configured,
      responses: [message()],
      stdinIsTTY: false,
      readStdin: () => Promise.resolve(new TextEncoder().encode("diff")),
    });
    expect(code).toBe(0);
    expect(stdout).toEqual(["sent changes.diff (4 B)"]);
  });

  it("emits one JSON object with ids and URLs under --json", async () => {
    const path = await scratchFile("report.md", "# hi");
    const url = "https://cdn.discordapp.com/attachments/c1/a1/report.md?ex=1";
    const { code, stdout, stderr } = await cli([path, "--json"], {
      env: configured,
      responses: [message("m1", [{ id: "a1", url }])],
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const payload = parseJsonLine(stdout);
    expect(payload).toEqual({
      ok: true,
      command: "send",
      dry_run: false,
      files: [
        {
          source: path,
          name: "report.md",
          bytes: 4,
          content_type: "text/markdown",
          message: 1,
          message_id: "m1",
          attachment_id: "a1",
          url,
        },
      ],
      messages: 1,
      duration_ms: 0,
    });
  });

  it("leaves the attachment URL out of the JSON when the destination is hidden", async () => {
    const path = await scratchFile("report.md", "# hi");
    const url = "https://cdn.discordapp.com/attachments/c1/a1/report.md";
    const { stdout } = await cli([path, "--json"], {
      env: hiddenConfigured,
      responses: [message("m1", [{ id: "a1", url }])],
    });
    const payload = parseJsonLine(stdout);
    expect(payload["ok"]).toBe(true);
    expect((payload["files"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("url");
    expect(stdout.join("\n")).not.toMatch(FORBIDDEN);
  });

  it("reports waits as advice on stderr and silences them under --quiet", async () => {
    const path = await scratchFile("a.txt");
    const noisy = await cli([path], { env: configured, responses: [rateLimited(2.5), message()] });
    expect(noisy.code).toBe(0);
    expect(noisy.stderr).toEqual([
      "dwh: advice dwh(rate-limit): rate limited by Discord; waiting 2.8s, then continuing (not an error)",
    ]);
    const quiet = await cli([path, "--quiet"], { env: configured, responses: [rateLimited(2.5), message()] });
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toEqual([]);
    expect(quiet.stderr).toEqual([]);
    const hidden = await cli([path], { env: hiddenConfigured, responses: [rateLimited(2.5), message()] });
    expect(hidden.stderr).toEqual([
      "dwh: advice dwh(rate-limit): rate limited by the destination; waiting 2.8s, then continuing (not an error)",
    ]);
  });

  it("still prints the JSON result under --json --quiet", async () => {
    const path = await scratchFile("a.txt");
    const { stdout, stderr } = await cli([path, "--json", "-q"], {
      env: configured,
      responses: [rateLimited(1), message()],
    });
    expect(stderr).toEqual([]);
    expect(parseJsonLine(stdout)["ok"]).toBe(true);
  });

  it("plans without sending under --dry-run, but still needs a configuration", async () => {
    const path = await scratchFile("report.md", "# hi");
    const planned = await cli([path, "--dry-run"], { env: configured });
    expect(planned.code).toBe(0);
    expect(planned.calls).toEqual([]);
    expect(planned.stdout).toEqual(["would send report.md (4 B)", "dry run: 1 file in 1 message; nothing was sent"]);
    const json = await cli([path, "--dry-run", "--json"], { env: configured });
    const payload = parseJsonLine(json.stdout);
    expect(payload["dry_run"]).toBe(true);
    expect(payload["files"]).toEqual([
      { source: path, name: "report.md", bytes: 4, content_type: "text/markdown", message: 1 },
    ]);
    const unconfigured = await cli([path, "--dry-run"]);
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.stderr[0]).toMatch(/^dwh: error dwh\(not-configured\)/);
  });

  it("fails on a missing configuration with setup instructions, neutral when hidden", async () => {
    const path = await scratchFile("a.txt");
    const branded = await cli([path]);
    expect(branded.code).toBe(1);
    expect(branded.calls).toEqual([]);
    expect(branded.stderr[0]).toMatch(
      /^dwh: error dwh\(not-configured\): no webhook configured help: export DWH_WEBHOOK_URL="https:\/\/discord\.com\/api\/webhooks\/<id>\/<token>"/,
    );
    const hidden = await cli([path], { env: { DWH_HIDE_DESTINATION: "1" } });
    expect(hidden.code).toBe(1);
    expect(hidden.stderr).toEqual([
      "dwh: error dwh(not-configured): delivery is not configured on this machine help: only the user can set it up; tell them dwh is not configured here (nothing on your side needs changing)",
    ]);
  });

  it("fails on an invalid configuration before touching any input", async () => {
    const branded = await cli(["missing.txt"], { env: { DWH_WEBHOOK_URL: "https://example.com/hook" } });
    expect(branded.code).toBe(1);
    expect(branded.stderr).toEqual([
      "dwh: error dwh(invalid-config): DWH_WEBHOOK_URL is not a Discord webhook URL help: expected https://discord.com/api/webhooks/<id>/<token>; copy it from Discord: channel settings > Integrations > Webhooks",
    ]);
    const hidden = await cli(["missing.txt"], {
      env: { DWH_WEBHOOK_URL: "not a url", DWH_HIDE_DESTINATION: "yes" },
    });
    expect(hidden.stderr).toHaveLength(1);
    expect(hidden.stderr[0]).toMatch(
      /^dwh: error dwh\(invalid-config\): the delivery configuration on this machine is invalid help: /,
    );
    expect(hidden.stderr[0]).not.toMatch(FORBIDDEN);
  });

  it("reports every bad input on its own line, located at the input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwh-run-"));
    const first = join(dir, "one.txt");
    const second = join(dir, "two.txt");
    const { code, stderr, calls } = await cli([first, second], { env: configured });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).toEqual([
      `${first}: error dwh(not-found): no such file help: check the path (ls -la ${dir}); a URL must start with http:// or https://`,
      `${second}: error dwh(not-found): no such file help: check the path (ls -la ${dir}); a URL must start with http:// or https://`,
    ]);
    const json = await cli([first, second, "--json"], { env: configured });
    const payload = parseJsonLine(json.stdout);
    expect(payload["ok"]).toBe(false);
    expect(payload["files"]).toBeUndefined();
    expect(payload["diagnostics"]).toHaveLength(2);
  });

  it("names the largest file when a message is rejected for size, keeping what was delivered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwh-run-"));
    const paths: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const path = join(dir, `f${String(index).padStart(2, "0")}.txt`);
      await writeFile(path, index === 10 ? "the biggest one" : "x");
      paths.push(path);
    }
    const { code, stdout, stderr } = await cli(paths, {
      env: configured,
      responses: [message(), rejection(400, { message: "Request entity too large", code: 40005 })],
    });
    expect(code).toBe(1);
    expect(stdout).toHaveLength(10);
    expect(stderr).toEqual([
      "dwh: error dwh(rejected): Discord rejected f10.txt: 400 Request entity too large help: the largest file is f10.txt (15 B), over this server's upload limit (10 MiB per file by default, more when boosted); shrink or split it",
    ]);
    const json = await cli([...paths, "--json"], {
      env: configured,
      responses: [message(), rejection(400, { message: "Request entity too large", code: 40005 })],
    }).then((result) => result.stdout);
    const payload = JSON.parse(json[0] ?? "") as Record<string, unknown>;
    expect(payload["ok"]).toBe(false);
    expect(payload["files"]).toHaveLength(10);
    expect(payload["messages"]).toBe(2);
  });

  it("treats an unknown webhook as a configuration problem, neutral when hidden", async () => {
    const path = await scratchFile("a.txt");
    const unknown = (): Response => rejection(404, { message: "Unknown Webhook", code: 10015 });
    const branded = await cli([path], { env: configured, responses: [unknown()] });
    expect(branded.code).toBe(1);
    expect(branded.stderr[0]).toMatch(
      /^dwh: error dwh\(bad-destination\): Discord rejected a\.txt: 404 Unknown Webhook help: .*DWH_WEBHOOK_URL/,
    );
    const hidden = await cli([path], { env: hiddenConfigured, responses: [unknown()] });
    expect(hidden.code).toBe(1);
    expect(hidden.stderr).toEqual([
      "dwh: error dwh(bad-destination): The destination rejected a.txt: 404 Unknown destination help: the destination configured on this machine is no longer valid; only the user can fix that, so tell them",
    ]);
  });

  it("never leaks the URL through network errors, hidden or not", async () => {
    const path = await scratchFile("a.txt");
    const failures = (): Error[] => Array.from({ length: 5 }, () => new Error(`fetch failed for ${WEBHOOK}?wait=true`));
    const branded = await cli([path], { env: configured, responses: failures() });
    expect(branded.code).toBe(1);
    expect(branded.stderr.at(-1)).toContain("could not reach Discord after 5 attempts");
    expect(branded.stderr.join("\n")).toContain("<token>");
    expect(branded.stderr.join("\n")).not.toContain("aBc_dEf-123");
    const hidden = await cli([path], { env: hiddenConfigured, responses: failures() });
    expect(hidden.code).toBe(1);
    expect(hidden.stderr.at(-1)).toBe(
      "dwh: error dwh(unreachable): could not reach the destination after 5 attempts: fetch failed for <destination> help: check network access from this machine (and HTTPS_PROXY if it needs a proxy), then run the same command again",
    );
    expect(hidden.stderr.join("\n")).not.toMatch(FORBIDDEN);
  });
});

describe("check", () => {
  it("reads the webhook with one GET, query string stripped, and reports what it found", async () => {
    const { code, stdout, stderr, calls } = await cli(["check"], {
      env: { DWH_WEBHOOK_URL: `${WEBHOOK}?thread_id=42` },
      responses: [webhookObject()],
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.init.method).toBe("GET");
    expect(stdout).toEqual([
      "source: DWH_WEBHOOK_URL",
      "webhook: build-bot (id 223)",
      "channel: 199",
      "server: 56",
      "thread: 42 (not verified)",
      "destination: ok",
    ]);
  });

  it("emits the webhook object under --json", async () => {
    const { stdout } = await cli(["check", "--json"], { env: configured, responses: [webhookObject()] });
    expect(parseJsonLine(stdout)).toEqual({
      ok: true,
      command: "check",
      source: "DWH_WEBHOOK_URL",
      webhook: { id: "223", name: "build-bot", type: 1, channel_id: "199", guild_id: "56" },
      thread_id: null,
    });
  });

  it("says only that the destination is ok when hidden", async () => {
    const plain = await cli(["check"], { env: hiddenConfigured, responses: [webhookObject("Discord Webhook Bot")] });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toEqual(["destination: ok"]);
    const json = await cli(["check", "--json"], {
      env: hiddenConfigured,
      responses: [webhookObject("Discord Webhook Bot")],
    });
    expect(parseJsonLine(json.stdout)).toEqual({ ok: true, command: "check" });
    const quiet = await cli(["check", "--quiet"], { env: hiddenConfigured, responses: [webhookObject()] });
    expect(quiet.stdout).toEqual([]);
  });

  it("fails with the configuration hint when the webhook is gone", async () => {
    const { code, stderr } = await cli(["check"], {
      env: configured,
      responses: [rejection(404, { message: "Unknown Webhook", code: 10015 })],
    });
    expect(code).toBe(1);
    expect(stderr).toEqual([
      "dwh: error dwh(bad-destination): Discord refused the configured URL: 404 Unknown Webhook help: the webhook URL is wrong or the webhook was deleted; copy a fresh one (Discord: channel settings > Integrations > Webhooks) into DWH_WEBHOOK_URL",
    ]);
  });

  it("fails without a configuration, before any request", async () => {
    const { code, stderr, calls } = await cli(["check"]);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr[0]).toMatch(/^dwh: error dwh\(not-configured\)/);
  });
});

describe("hidden destination sweep", () => {
  it("never prints the words Discord or webhook, whatever happens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwh-run-"));
    const small = join(dir, "a.txt");
    await writeFile(small, "x");
    const huge = join(dir, "huge.bin");
    await writeFile(huge, "");
    await truncate(huge, 101 * 1024 * 1024);
    const env = hiddenConfigured;
    const scenarios: Array<[string[], Scenario]> = [
      [["--help"], { env }],
      [["send", "--help"], { env }],
      [["check", "--help"], { env }],
      [[], { env }],
      [[small], { env: { DWH_HIDE_DESTINATION: "1" } }],
      [[small], { env: { DWH_HIDE_DESTINATION: "1", DWH_WEBHOOK_URL: "https://discord.com/nope" } }],
      [[huge], { env }],
      [[join(dir, "missing.txt")], { env }],
      [[small], { env, responses: [rejection(404, { message: "Unknown Webhook", code: 10015 })] }],
      [[small], { env, responses: [rejection(400, "Discord says: no webhook here")] }],
      [[small], { env, responses: [rejection(403, { message: "Missing Access", code: 50001 })] }],
      [[small], { env, responses: [rejection(404, { message: "Unknown Channel", code: 10003 })] }],
      [[small], { env, responses: Array.from({ length: 5 }, () => new Error(`ECONNRESET ${WEBHOOK}`)) }],
      [[small], { env, responses: Array.from({ length: 5 }, () => new Response("", { status: 502 })) }],
      [[small], { env, responses: [rateLimited(3), message()] }],
      [[small, "--json"], { env, responses: [message("m1", [{ id: "a1", url: "https://cdn.discordapp.com/x" }])] }],
      [["check"], { env, responses: [webhookObject("Discord Webhook Bot")] }],
      [["check", "--json"], { env, responses: [webhookObject("Discord Webhook Bot")] }],
      [["check"], { env, responses: [rejection(401, { message: "Invalid Webhook Token", code: 50027 })] }],
      [["check"], { env, responses: Array.from({ length: 5 }, () => new Error(`fetch failed ${WEBHOOK}`)) }],
    ];
    for (const [argv, scenario] of scenarios) {
      const { stdout, stderr } = await cli(argv, scenario);
      const output = [...stdout, ...stderr].join("\n");
      expect(output, `argv ${JSON.stringify(argv)}`).not.toMatch(FORBIDDEN);
      expect(output, `argv ${JSON.stringify(argv)}`).not.toContain("aBc_dEf-123");
    }
  });
});
