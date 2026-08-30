import { describe, expect, it } from "vitest";
import { FormData } from "undici";
import type { FetchLike } from "../src/http.js";
import type { OutgoingFile } from "../src/inputs.js";
import {
  MAX_FILES_PER_MESSAGE,
  planBatches,
  redactWebhookTokens,
  resolveWebhookUrl,
  sendFiles,
} from "../src/webhook.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/aBc_dEf-123";

function file(name: string, bytes = 4): OutgoingFile {
  return { name, data: new Uint8Array(bytes), contentType: "text/plain" };
}

function sizedFile(name: string, byteLength: number): OutgoingFile {
  return { name, data: { byteLength } as unknown as Uint8Array, contentType: "text/plain" };
}

function ok(headers: Record<string, string> = { "x-ratelimit-remaining": "4" }): Response {
  return new Response(JSON.stringify({ id: "1" }), { status: 200, headers });
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

describe("resolveWebhookUrl", () => {
  it("fails with setup instructions when nothing is configured", () => {
    expect(() => resolveWebhookUrl({})).toThrow(/DWH_WEBHOOK_URL/);
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
      /does not look like a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "http://discord.com/api/webhooks/1/t" })).toThrow(
      /does not look like a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "https://discord.com/api/webhooks/notanid/t" })).toThrow(
      /does not look like a Discord webhook URL/,
    );
    expect(() => resolveWebhookUrl({ DWH_WEBHOOK_URL: "not a url" })).toThrow(/not a valid URL/);
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
    await sendFiles(`${WEBHOOK}?thread_id=42`, [file("a.txt"), file("b.txt")], {
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
  });

  it("does nothing for an empty file list", async () => {
    const { calls, impl } = queueFetch();
    await sendFiles(WEBHOOK, [], { fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });

  it("waits out a 429 and then delivers, without throwing", async () => {
    const { calls, impl } = queueFetch(rateLimited(2.5), ok());
    const { waits, sleep } = sleepRecorder();
    const notes: string[] = [];
    await sendFiles(WEBHOOK, [file("a.txt")], {
      fetchImpl: impl,
      sleep,
      onNote: (note) => {
        notes.push(note);
      },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2750]);
    expect(notes.some((note) => note.includes("rate limited"))).toBe(true);
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
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
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
    await expect(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep })).rejects.toThrow(/after 5 attempts/);
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("gives up after five network failures and redacts the webhook token", async () => {
    const failure = (): Error => new Error(`fetch failed for ${WEBHOOK}`);
    const { calls, impl } = queueFetch(failure(), failure(), failure(), failure(), failure());
    const { sleep } = sleepRecorder();
    const error = await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep }).then(
      () => {
        throw new Error("expected sendFiles to reject");
      },
      (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
    );
    expect(error.message).toContain("could not reach Discord");
    expect(error.message).toContain("<token>");
    expect(error.message).not.toContain("aBc_dEf-123");
    expect(calls).toHaveLength(5);
  });

  it("fails fast on a 4xx with Discord's message and a size hint for 40005", async () => {
    const body = JSON.stringify({ message: "Request entity too large", code: 40005 });
    const { calls, impl } = queueFetch(new Response(body, { status: 400 }));
    const { sleep } = sleepRecorder();
    await expect(sendFiles(WEBHOOK, [file("huge.bin")], { fetchImpl: impl, sleep })).rejects.toThrow(
      /huge\.bin.*upload limit/s,
    );
    expect(calls).toHaveLength(1);
  });

  it("hints at DWH_WEBHOOK_URL for an unknown webhook", async () => {
    const body = JSON.stringify({ message: "Unknown Webhook", code: 10015 });
    const { impl } = queueFetch(new Response(body, { status: 404 }));
    const { sleep } = sleepRecorder();
    await expect(sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep })).rejects.toThrow(
      /check DWH_WEBHOOK_URL/,
    );
  });

  it("pauses between messages when the rate limit budget is spent", async () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`f${index}.txt`));
    const { calls, impl } = queueFetch(ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "3.2" }), ok());
    const { waits, sleep } = sleepRecorder();
    const sent: string[] = [];
    await sendFiles(WEBHOOK, files, {
      fetchImpl: impl,
      sleep,
      onSent: (entry) => {
        sent.push(entry.name);
      },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([3200]);
    expect(sent).toHaveLength(11);
  });

  it("does not pause after the final message", async () => {
    const { impl } = queueFetch(ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5" }));
    const { waits, sleep } = sleepRecorder();
    await sendFiles(WEBHOOK, [file("a.txt")], { fetchImpl: impl, sleep });
    expect(waits).toEqual([]);
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
