import { describe, expect, it } from "vitest";
import { FormData } from "undici";
import type { Diagnostic } from "../src/diagnostics.js";
import type { FetchLike } from "../src/http.js";
import type { OutgoingFile } from "../src/inputs.js";
import {
  checkWebhook,
  isWebhookUrl,
  MAX_FILES_PER_MESSAGE,
  planBatches,
  redactWebhookTokens,
  resolveWebhookConfig,
  resolveWebhookUrl,
  sendFiles,
} from "../src/webhook.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/aBc_dEf-123";
const FORBIDDEN = /discord|webhook/i;

function file(name: string, bytes = 4): OutgoingFile {
  return { name, data: new Uint8Array(bytes), contentType: "text/plain" };
}

function sizedFile(name: string, byteLength: number): OutgoingFile {
  return { name, data: { byteLength } as unknown as Uint8Array, contentType: "text/plain" };
}

function ok(headers: Record<string, string> = { "x-ratelimit-remaining": "4" }, body: unknown = { id: "1" }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function rateLimited(retryAfterSeconds?: number): Response {
  const body =
    retryAfterSeconds === undefined
      ? "not json"
      : JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfterSeconds, global: false });
  return new Response(body, { status: 429 });
}

function queueFetch(...outcomes: Array<Response | Error>): {
  calls: Array<{ url: string; init: { method?: string; body?: unknown } }>;
  impl: FetchLike;
} {
  const calls: Array<{ url: string; init: { method?: string; body?: unknown } }> = [];
  const impl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({ url: String(url), init: init ?? {} });
    const outcome = outcomes.shift();
    if (outcome === undefined) {
      throw new Error("unexpected extra fetch call");
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }) as unknown as FetchLike;
  return { calls, impl };
}

function sleepRecorder(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
  );
}

describe("resolveWebhookUrl", () => {
  it("fails with setup instructions when nothing is configured", () => {
    expect(() => resolveWebhookUrl({})).toThrow(
      /dwh: error dwh\(not-configured\): no webhook configured help: .*DWH_WEBHOOK_URL/,
    );
  });

  it("prefers DWH_WEBHOOK_URL over DISCORD_WEBHOOK_URL", () => {
    const url = resolveWebhookUrl({
      DWH_WEBHOOK_URL: WEBHOOK,
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/999/other-token",
    });
    expect(url).toBe(WEBHOOK);
  });

  it("falls back to DISCORD_WEBHOOK_URL", () => {
    expect(resolveWebhookUrl({ DISCORD_WEBHOOK_URL: WEBHOOK })).toBe(WEBHOOK);
  });

  it("rejects URLs that are not Discord webhooks", () => {
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "https://example.com/api/webhooks/1/t" })).toThrow(
      /DWH_WEBHOOK_URL is not a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "http://discord.com/api/webhooks/1/t" })).toThrow(
      /is not a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/notanid/t" })).toThrow(
      /DISCORD_WEBHOOK_URL is not a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "not a url" })).toThrow(/DWH_WEBHOOK_URL is not a valid URL/);
  });

  it("words configuration errors neutrally when DWH_HIDE_DESTINATION is set", () => {
    const missing = rejectionOfSync(() => resolveWebhookUrl({ DWH_HIDE_DESTINATION: "1" }));
    expect(missing.message).toContain("dwh(not-configured)");
    expect(missing.message).not.toMatch(FORBIDDEN);
    const invalid = rejectionOfSync(() => resolveWebhookUrl({ DWH_HIDE_DESTINATION: "1", DWH_WEBHOOK_URL: "nope" }));
    expect(invalid.message).toContain("dwh(invalid-config)");
    expect(invalid.message).not.toMatch(FORBIDDEN);
  });
});

function rejectionOfSync(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the function to throw");
}

describe("resolveWebhookConfig", () => {
  it("reports the source variable and any thread id", () => {
    expect(resolveWebhookConfig({ DWH_WEBHOOK_URL: `${WEBHOOK}?thread_id=42` })).toEqual({
      url: `${WEBHOOK}?thread_id=42`,
      source: "DWH_WEBHOOK_URL",
      threadId: "42",
    });
    expect(resolveWebhookConfig({ DISCORD_WEBHOOK_URL: WEBHOOK })).toEqual({
      url: WEBHOOK,
      source: "DISCORD_WEBHOOK_URL",
      threadId: undefined,
    });
  });
});

describe("planBatches", () => {
  it("splits by file count and preserves order", () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`f${index}`));
    const batches = planBatches(files);
    expect(batches.map((batch) => batch.length)).toEqual([MAX_FILES_PER_MESSAGE, 1]);
    expect(batches.flat().map((entry) => entry.name)).toEqual(files.map((entry) => entry.name));
  });

  it("splits by cumulative size", () => {
    const tenMiB = 10 * 1024 * 1024;
    const batches = planBatches([sizedFile("a", tenMiB), sizedFile("b", tenMiB), sizedFile("c", tenMiB)]);
    expect(batches.map((batch) => batch.map((entry) => entry.name))).toEqual([["a", "b"], ["c"]]);
  });

  it("gives an oversized file a message of its own", () => {
    const batches = planBatches([sizedFile("big", 30 * 1024 * 1024), sizedFile("small", 1)]);
    expect(batches.map((batch) => batch.map((entry) => entry.name))).toEqual([["big"], ["small"]]);
  });
});

describe("sendFiles", () => {
  it("posts one multipart message and reports each file", async () => {
    const { calls, impl } = queueFetch(ok());
    const { sleep } = sleepRecorder();
    const sent: string[] = [];
    const result = await sendFiles(`${WEBHOOK}?thread_id=42`, [file("a.txt"), file("b.txt")], {
      fetchImpl: impl,
      sleep,
      onSent: (entry) => {
        sent.push(entry.name);
      },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toContain("wait=true");
    expect(call?.url).toContain("thread_id=42");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBeInstanceOf(FormData);
    expect(sent).toEqual(["a.txt", "b.txt"]);
    expect(result.messages).toBe(1);
    expect(result.deliveries.map((delivery) => delivery.file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns the message and attachment ids the destination reports, by position", async () => {
    const body = {
      id: "m1",
      channel_id: "c1",
      attachments: [
        { id: "a1", url: "https://cdn.discordapp.com/attachments/c1/a1/a.txt" },
        { id: "a2", url: "https://cdn.discordapp.com/attachments/c1/a2/b.txt" },
      ],
    };
    const { impl } = queueFetch(ok(undefined, body));
    const { sleep } = sleepRecorder();
    const deliveries: Array<{ name: string; message: number; messageId: string | undefined }> = [];
    const result = await sendFiles(WEBHOOK, [file("a.txt"), file("b.txt")], {
      fetchImpl: impl,
      sleep,
      onSent: (entry, delivery) => {
        deliveries.push({ name: entry.name, message: delivery.message, messageId: delivery.messageId });
      },
    });
    expect(deliveries).toEqual([
      { name: "a.txt", message: 1, messageId: "m1" },
      { name: "b.txt", message: 1, messageId: "m1" },
    ]);
    expect(result.deliveries[1]).toMatchObject({
      messageId: "m1",
      channelId: "c1",
      attachmentId: "a2",
      url: "https://cdn.discordapp.com/attachments/c1/a2/b.txt",
    });
  });

  it("tolerates a response body that is not the message object", async () => {
    const { impl } = queueFetch(new Response(null, { status: 204 }));
    const { sleep } = sleepRecorder();
    const result = await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(result.deliveries[0]).toMatchObject({ messageId: undefined, attachmentId: undefined, url: undefined });
  });

  it("numbers messages across batches", async () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`f${index}.txt`));
    const { impl } = queueFetch(ok(undefined, { id: "m1" }), ok(undefined, { id: "m2" }));
    const { sleep } = sleepRecorder();
    const result = await sendFiles(WEBHOOK, files, { fetchImpl: impl, sleep });
    expect(result.messages).toBe(2);
    expect(result.deliveries.map((delivery) => delivery.message)).toEqual([...Array.from({ length: 10 }, () => 1), 2]);
    expect(result.deliveries.at(-1)?.messageId).toBe("m2");
  });

  it("does nothing for an empty file list", async () => {
    const { calls, impl } = queueFetch();
    const result = await sendFiles(WEBHOOK, [], { fetchImpl: impl });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ deliveries: [], messages: 0 });
  });

  it("waits out a 429 and then delivers, without throwing", async () => {
    const { calls, impl } = queueFetch(rateLimited(2.5), ok());
    const { waits, sleep } = sleepRecorder();
    const notes: Diagnostic[] = [];
    await sendFiles(WEBHOOK, [file("a.txt")], {
      fetchImpl: impl,
      sleep,
      onDiagnostic: (diagnostic) => {
        notes.push(diagnostic);
      },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2750]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: "advice", code: "rate-limit" });
    expect(notes[0]?.message).toContain("rate limited by Discord");
  });

  it("uses a minimum wait when the 429 carries no retry_after", async () => {
    const { calls, impl } = queueFetch(rateLimited(), ok());
    const { waits, sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1250]);
  });

  it("caps a huge retry_after at one minute per wait", async () => {
    const { impl } = queueFetch(rateLimited(999), ok());
    const { waits, sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(waits).toEqual([60250]);
  });

  it("survives repeated 429s", async () => {
    const { calls, impl } = queueFetch(rateLimited(1), rateLimited(1), rateLimited(1), ok());
    const { waits, sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1250, 1250, 1250]);
  });

  it("retries 5xx with backoff and succeeds", async () => {
    const { calls, impl } = queueFetch(new Response("", { status: 500 }), new Response("", { status: 502 }), ok());
    const { waits, sleep } = sleepRecorder();
    const notes: Diagnostic[] = [];
    await sendFiles(WEBHOOK, [file("a.txt")], {
      fetchImpl: impl,
      sleep,
      onDiagnostic: (diagnostic) => {
        notes.push(diagnostic);
      },
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(notes.map((note) => note.code)).toEqual(["retry", "retry"]);
    expect(notes[0]?.message).toBe("Discord returned 500; retrying in 1.0s");
  });

  it("cancels unread 5xx bodies so connections are released", async () => {
    let cancelled = false;
    const failing = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("error page"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    const { impl } = queueFetch(failing, ok());
    const { sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(cancelled).toBe(true);
  });

  it("gives up after five 5xx attempts", async () => {
    const { calls, impl } = queueFetch(...Array.from({ length: 5 }, () => new Response("", { status: 500 })));
    const { waits, sleep } = sleepRecorder();
    const error = await rejectionOf(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep }));
    expect(error.message).toMatch(
      /^dwh: error dwh\(unavailable\): Discord kept failing \(500\) after 5 attempts help: /,
    );
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("gives up after five network failures and redacts the webhook token", async () => {
    const failure = (): Error => new Error(`fetch failed for ${WEBHOOK}`);
    const { calls, impl } = queueFetch(failure(), failure(), failure(), failure(), failure());
    const { sleep } = sleepRecorder();
    const error = await rejectionOf(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep }));
    expect(error.message).toContain("dwh(unreachable): could not reach Discord after 5 attempts");
    expect(error.message).toContain("<token>");
    expect(error.message).not.toContain("aBc_dEf-123");
    expect(error.cause).toBeUndefined();
    expect(calls).toHaveLength(5);
  });

  it("fails fast on a 4xx with the API message and a size hint naming the largest file for 40005", async () => {
    const body = JSON.stringify({ message: "Request entity too large", code: 40005 });
    const { calls, impl } = queueFetch(new Response(body, { status: 400 }));
    const { sleep } = sleepRecorder();
    const error = await rejectionOf(
      sendFiles(WEBHOOK, [file("small.txt", 1), file("huge.bin", 9), file("mid.txt", 5)], { fetchImpl: impl, sleep }),
    );
    expect(error.message).toBe(
      "dwh: error dwh(rejected): Discord rejected small.txt, huge.bin, mid.txt: 400 Request entity too large help: the largest file is huge.bin (9 B), over this server's upload limit (10 MiB per file by default, more when boosted); shrink or split it",
    );
    expect(calls).toHaveLength(1);
  });

  it("classifies an unknown webhook or token as a bad destination with the configuration hint", async () => {
    for (const [status, body] of [
      [404, { message: "Unknown Webhook", code: 10015 }],
      [401, { message: "Invalid Webhook Token", code: 50027 }],
      [403, { message: "Missing Access", code: 50001 }],
    ] as const) {
      const { impl } = queueFetch(new Response(JSON.stringify(body), { status }));
      const { sleep } = sleepRecorder();
      const error = await rejectionOf(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep }));
      expect(error.message).toContain("dwh(bad-destination)");
      expect(error.message).toContain("DWH_WEBHOOK_URL");
    }
  });

  it("points at the thread id for an unknown channel", async () => {
    const { impl } = queueFetch(
      new Response(JSON.stringify({ message: "Unknown Channel", code: 10003 }), { status: 404 }),
    );
    const { sleep } = sleepRecorder();
    const error = await rejectionOf(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep }));
    expect(error.message).toContain("dwh(bad-destination)");
    expect(error.message).toContain("thread_id");
  });

  it("uses neutral wording for every failure when the destination is hidden", async () => {
    const outcomes: Array<Array<Response | Error>> = [
      [new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 })],
      [new Response("Discord: webhook rejected", { status: 400 })],
      Array.from({ length: 5 }, () => new Error(`fetch failed for ${WEBHOOK}`)),
      Array.from({ length: 5 }, () => new Response("", { status: 503 })),
    ];
    for (const sequence of outcomes) {
      const { impl } = queueFetch(...sequence);
      const { sleep } = sleepRecorder();
      const notes: Diagnostic[] = [];
      const error = await rejectionOf(
        sendFiles(WEBHOOK, [file("a.txt")], {
          fetchImpl: impl,
          sleep,
          hideDestination: true,
          onDiagnostic: (diagnostic) => {
            notes.push(diagnostic);
          },
        }),
      );
      expect(error.message).not.toMatch(FORBIDDEN);
      for (const note of notes) {
        expect(`${note.message} ${note.help ?? ""}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("pauses between messages when the rate limit budget is spent", async () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`f${index}.txt`));
    const { calls, impl } = queueFetch(ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "3.2" }), ok());
    const { waits, sleep } = sleepRecorder();
    const sent: string[] = [];
    const notes: Diagnostic[] = [];
    await sendFiles(WEBHOOK, files, {
      fetchImpl: impl,
      sleep,
      onSent: (entry) => {
        sent.push(entry.name);
      },
      onDiagnostic: (diagnostic) => {
        notes.push(diagnostic);
      },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([3200]);
    expect(sent).toHaveLength(11);
    expect(notes[0]).toMatchObject({ code: "rate-limit", severity: "advice" });
  });

  it("does not pause after the final message", async () => {
    const { impl } = queueFetch(ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5" }));
    const { waits, sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(waits).toEqual([]);
  });
});

describe("checkWebhook", () => {
  const webhookObject = { id: "223", name: "build-bot", type: 1, channel_id: "199", guild_id: "56" };

  it("GETs the webhook without its query string and parses the object", async () => {
    const { calls, impl } = queueFetch(new Response(JSON.stringify(webhookObject), { status: 200 }));
    const { sleep } = sleepRecorder();
    const info = await checkWebhook(`${WEBHOOK}?thread_id=42`, { fetchImpl: impl, sleep });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.init.method).toBe("GET");
    expect(info).toEqual({ id: "223", name: "build-bot", type: 1, channelId: "199", guildId: "56" });
  });

  it("waits out a 429 and retries 5xx like delivery does", async () => {
    const { calls, impl } = queueFetch(
      rateLimited(1),
      new Response("", { status: 502 }),
      new Response(JSON.stringify(webhookObject), { status: 200 }),
    );
    const { waits, sleep } = sleepRecorder();
    const info = await checkWebhook(WEBHOOK, { fetchImpl: impl, sleep });
    expect(info.id).toBe("223");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1250, 1000]);
  });

  it("reports a deleted webhook as a bad destination", async () => {
    const { impl } = queueFetch(
      new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }),
    );
    const { sleep } = sleepRecorder();
    const error = await rejectionOf(checkWebhook(WEBHOOK, { fetchImpl: impl, sleep }));
    expect(error.message).toBe(
      "dwh: error dwh(bad-destination): Discord refused the configured URL: 404 Unknown Webhook help: the webhook URL is wrong or the webhook was deleted; copy a fresh one (Discord: channel settings > Integrations > Webhooks) into DWH_WEBHOOK_URL",
    );
  });

  it("copes with a body that is not JSON", async () => {
    const { impl } = queueFetch(new Response("<html>", { status: 200 }));
    const { sleep } = sleepRecorder();
    const info = await checkWebhook(WEBHOOK, { fetchImpl: impl, sleep });
    expect(info).toEqual({ id: undefined, name: undefined, type: undefined, channelId: undefined, guildId: undefined });
  });
});

describe("direct URLs", () => {
  it("rejects a malformed or foreign URL with an invalid-config diagnostic, before any request", async () => {
    for (const bad of ["garbage", "https://example.com/api/webhooks/1/t", "http://discord.com/api/webhooks/1/t"]) {
      const { calls, impl } = queueFetch();
      const { sleep } = sleepRecorder();
      const checkError = await rejectionOf(checkWebhook(bad, { fetchImpl: impl, sleep }));
      expect(checkError.message).toMatch(
        /^dwh: error dwh\(invalid-config\): the webhook URL is not a (valid|Discord webhook) URL help: /,
      );
      const sendError = await rejectionOf(sendFiles(bad, [file("a.txt")], { fetchImpl: impl, sleep }));
      expect(sendError.message).toContain("dwh(invalid-config)");
      expect(calls).toHaveLength(0);
    }
    const hidden = await rejectionOf(checkWebhook("garbage", { hideDestination: true }));
    expect(hidden.message).toContain("dwh(invalid-config)");
    expect(hidden.message).not.toMatch(FORBIDDEN);
  });

  it("recognizes webhook URLs", () => {
    expect(isWebhookUrl(WEBHOOK)).toBe(true);
    expect(isWebhookUrl(`${WEBHOOK}?thread_id=1`)).toBe(true);
    expect(isWebhookUrl("https://ptb.discord.com/api/v10/webhooks/1/t-t")).toBe(true);
    expect(isWebhookUrl("https://cdn.discordapp.com/attachments/1/2/a.png")).toBe(false);
    expect(isWebhookUrl("https://example.com/api/webhooks/1/t")).toBe(false);
    expect(isWebhookUrl("not a url")).toBe(false);
  });
});

describe("redactWebhookTokens", () => {
  it("keeps the id but hides the token", () => {
    const redacted = redactWebhookTokens(`error at ${WEBHOOK} and https://discord.com/api/v10/webhooks/9/tok-en_1`);
    expect(redacted).toBe(
      "error at https://discord.com/api/webhooks/123456789/<token> and https://discord.com/api/v10/webhooks/9/<token>",
    );
  });
});
