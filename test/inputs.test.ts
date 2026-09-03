import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticError, type Diagnostic } from "../src/diagnostics.js";
import type { FetchLike } from "../src/http.js";
import { filenameForDownload, isUrl, resolveInputs } from "../src/inputs.js";

const FORBIDDEN = /discord|webhook/i;

function fetchReturning(response: Response): FetchLike {
  return (async () => response) as unknown as FetchLike;
}

function fetchSequence(...outcomes: Array<Response | Error>): { calls: number[]; impl: FetchLike } {
  const calls: number[] = [];
  const impl = (async () => {
    calls.push(calls.length + 1);
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

function failingBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("terminated"));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dwh-test-"));
}

async function diagnosticsOfRejection(promise: Promise<unknown>): Promise<readonly Diagnostic[]> {
  return promise.then(
    () => {
      throw new Error("expected resolveInputs to reject");
    },
    (reason: unknown) => {
      if (reason instanceof DiagnosticError) {
        return reason.diagnostics;
      }
      throw new Error(`expected a DiagnosticError, got ${String(reason)}`);
    },
  );
}

describe("isUrl", () => {
  it("accepts http and https, rejects everything else", () => {
    expect(isUrl("https://example.com/a")).toBe(true);
    expect(isUrl("HTTP://example.com")).toBe(true);
    expect(isUrl("ftp://example.com")).toBe(false);
    expect(isUrl("./notes.md")).toBe(false);
  });
});

describe("resolveInputs with local files", () => {
  it("reads a file and derives name, content type, and source", async () => {
    const dir = await scratchDir();
    const path = join(dir, "notes.md");
    await writeFile(path, "# hello");
    const [resolved] = await resolveInputs([path]);
    expect(resolved?.name).toBe("notes.md");
    expect(resolved?.contentType).toBe("text/markdown");
    expect(resolved?.source).toBe(path);
    expect(Buffer.from(resolved?.data ?? new Uint8Array()).toString()).toBe("# hello");
  });

  it("applies --name to both the filename and the content type", async () => {
    const dir = await scratchDir();
    const path = join(dir, "raw.bin");
    await writeFile(path, "{}");
    const [resolved] = await resolveInputs([path], { nameOverride: "report.json" });
    expect(resolved?.name).toBe("report.json");
    expect(resolved?.contentType).toBe("application/json");
  });

  it("rejects a missing path with a located diagnostic and an exploration command", async () => {
    const dir = await scratchDir();
    const missing = join(dir, "nope.txt");
    await expect(resolveInputs([missing])).rejects.toThrow(missing);
    await expect(resolveInputs([missing])).rejects.toThrow(/no such file/);
    const [diagnostic] = await diagnosticsOfRejection(resolveInputs([missing]));
    expect(diagnostic).toEqual({
      location: missing,
      severity: "error",
      code: "not-found",
      message: "no such file",
      help: `check the path (ls -la ${dir}); a URL must start with http:// or https://`,
    });
  });

  it("rejects a directory with a copy-pasteable archive command", async () => {
    const dir = await scratchDir();
    const [diagnostic] = await diagnosticsOfRejection(resolveInputs([dir]));
    expect(diagnostic?.code).toBe("is-directory");
    expect(diagnostic?.message).toBe("is a directory");
    expect(diagnostic?.help).toContain(`zip -r`);
    expect(diagnostic?.help).toContain(`&& dwh`);
  });

  it("rejects non-regular files such as devices, pointing at stdin", async () => {
    const [diagnostic] = await diagnosticsOfRejection(resolveInputs(["/dev/null"]));
    expect(diagnostic?.code).toBe("not-regular-file");
    expect(diagnostic?.help).toBe("pipe it through stdin instead: cat /dev/null | dwh - --name null");
  });

  it("quotes paths that need it in example commands", async () => {
    const dir = await scratchDir();
    const missing = join(dir, "my report.txt");
    const [diagnostic] = await diagnosticsOfRejection(resolveInputs([missing]));
    expect(diagnostic?.help).toContain(`ls -la ${dir}`);
    const directory = join(dir, "my dir");
    await writeFile(join(dir, "placeholder"), "");
    const [dirDiagnostic] = await diagnosticsOfRejection(resolveInputs([dir]));
    expect(dirDiagnostic?.help).toContain(`zip -r`);
    expect(directory).toContain(" ");
  });

  it("reports every failing input, not just the first", async () => {
    const dir = await scratchDir();
    const first = join(dir, "one.txt");
    const second = join(dir, "two.txt");
    const diagnostics = await diagnosticsOfRejection(resolveInputs([first, second]));
    expect(diagnostics.map((diagnostic) => diagnostic.location)).toEqual([first, second]);
  });

  it("rejects a file over the absolute limit without reading it, branded or neutral", async () => {
    const dir = await scratchDir();
    const path = join(dir, "huge.bin");
    await writeFile(path, "");
    await truncate(path, 101 * 1024 * 1024);
    const [branded] = await diagnosticsOfRejection(resolveInputs([path]));
    expect(branded?.code).toBe("too-large");
    expect(branded?.message).toBe("101.0 MiB exceeds Discord's absolute limit of 100.0 MiB");
    expect(branded?.help).toContain("split -b 9M");
    const [neutral] = await diagnosticsOfRejection(resolveInputs([path], { hideDestination: true }));
    expect(neutral?.message).toBe("101.0 MiB exceeds the absolute per-file limit of 100.0 MiB");
    expect(`${neutral?.message} ${neutral?.help}`).not.toMatch(FORBIDDEN);
  });
});

describe("resolveInputs with URLs", () => {
  it("downloads and derives the filename from the URL path", async () => {
    const response = new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const [resolved] = await resolveInputs(["https://example.com/notes/todo.txt"], {
      fetchImpl: fetchReturning(response),
    });
    expect(resolved?.name).toBe("todo.txt");
    expect(resolved?.contentType).toBe("text/plain");
    expect(resolved?.source).toBe("https://example.com/notes/todo.txt");
    expect(Buffer.from(resolved?.data ?? new Uint8Array()).toString()).toBe("hello");
  });

  it("rejects a non-2xx response with the status, located at the URL", async () => {
    const response = new Response("gone", { status: 404, statusText: "Not Found" });
    const [diagnostic] = await diagnosticsOfRejection(
      resolveInputs(["https://example.com/missing"], { fetchImpl: fetchReturning(response) }),
    );
    expect(diagnostic).toEqual({
      location: "https://example.com/missing",
      severity: "error",
      code: "download-failed",
      message: "GET failed: 404 Not Found",
      help: "check the URL (curl -sSI https://example.com/missing); it must be reachable without credentials from this machine",
    });
  });

  it("lets --name decide the content type when its extension is known", async () => {
    const response = new Response("{}", { status: 200, headers: { "content-type": "text/plain" } });
    const [resolved] = await resolveInputs(["https://example.com/raw"], {
      nameOverride: "report.json",
      fetchImpl: fetchReturning(response),
    });
    expect(resolved?.name).toBe("report.json");
    expect(resolved?.contentType).toBe("application/json");
  });

  it("keeps the response content type when --name has no known extension", async () => {
    const response = new Response("data", { status: 200, headers: { "content-type": "text/plain" } });
    const [resolved] = await resolveInputs(["https://example.com/raw"], {
      nameOverride: "weird.unknownext",
      fetchImpl: fetchReturning(response),
    });
    expect(resolved?.contentType).toBe("text/plain");
  });

  it("retries a body that dies mid-stream with a fresh GET, noting it as advice", async () => {
    const { calls, impl } = fetchSequence(
      failingBodyResponse(),
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const { waits, sleep } = sleepRecorder();
    const notes: Diagnostic[] = [];
    const [resolved] = await resolveInputs(["https://example.com/flaky.txt"], {
      fetchImpl: impl,
      sleep,
      onDiagnostic: (diagnostic) => {
        notes.push(diagnostic);
      },
    });
    expect(Buffer.from(resolved?.data ?? new Uint8Array()).toString()).toBe("hello");
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ location: "https://example.com/flaky.txt", severity: "advice", code: "retry" });
  });

  it("names the URL when the response body keeps failing mid-read", async () => {
    const { calls, impl } = fetchSequence(...Array.from({ length: 5 }, () => failingBodyResponse()));
    const { waits, sleep } = sleepRecorder();
    await expect(resolveInputs(["https://example.com/flaky.txt"], { fetchImpl: impl, sleep })).rejects.toThrow(
      /^https:\/\/example\.com\/flaky\.txt: error dwh\(download-failed\): GET failed while reading the response: .* \(after 5 attempts\) help: /,
    );
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("retries transient download failures with backoff, like delivery does", async () => {
    const { calls, impl } = fetchSequence(
      new Error("socket hang up"),
      new Response("", { status: 502 }),
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const { waits, sleep } = sleepRecorder();
    const [resolved] = await resolveInputs(["https://example.com/flappy.txt"], { fetchImpl: impl, sleep });
    expect(resolved?.name).toBe("flappy.txt");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("gives up on a download after five transient failures", async () => {
    const { calls, impl } = fetchSequence(...Array.from({ length: 5 }, () => new Response("", { status: 500 })));
    const { sleep } = sleepRecorder();
    await expect(resolveInputs(["https://example.com/down.txt"], { fetchImpl: impl, sleep })).rejects.toThrow(
      /after 5 attempts/,
    );
    expect(calls).toHaveLength(5);
  });

  it("rejects a download whose declared size can never fit", async () => {
    const response = new Response("tiny", {
      status: 200,
      headers: { "content-length": String(200 * 1024 * 1024) },
    });
    await expect(
      resolveInputs(["https://example.com/huge.bin"], { fetchImpl: fetchReturning(response) }),
    ).rejects.toThrow(/exceeds Discord's absolute limit/);
    const [neutral] = await diagnosticsOfRejection(
      resolveInputs(["https://example.com/huge.bin"], { fetchImpl: fetchReturning(response), hideDestination: true }),
    );
    expect(neutral?.code).toBe("too-large");
    expect(`${neutral?.message} ${neutral?.help}`).not.toMatch(FORBIDDEN);
  });
});

describe("filenameForDownload", () => {
  it("uses the last path segment when it has an extension", () => {
    expect(filenameForDownload("https://example.com/docs/guide.md", null, "text/markdown")).toBe("guide.md");
  });

  it("decodes percent-encoded names", () => {
    const url = "https://example.com/%E3%81%BB%E3%81%92%E3%81%B5%E3%81%8C.md";
    expect(filenameForDownload(url, null, "text/markdown")).toBe("ほげふが.md");
  });

  it("appends an extension from the content type when the segment has none", () => {
    expect(filenameForDownload("https://example.com/api/data", null, "application/json")).toBe("data.json");
    expect(filenameForDownload("https://example.com/blog/", null, "text/html")).toBe("blog.html");
  });

  it("falls back to the hostname for a bare origin", () => {
    expect(filenameForDownload("https://example.com/", null, "text/html")).toBe("example.com.html");
    expect(filenameForDownload("https://example.com/", null, "application/octet-stream")).toBe("example.com");
  });

  it("appends extensions for the whole reverse content-type map", () => {
    expect(filenameForDownload("https://example.com/media", null, "video/mp4")).toBe("media.mp4");
    expect(filenameForDownload("https://example.com/dump", null, "application/gzip")).toBe("dump.gz");
  });

  it("parses Content-Disposition parameter names case-insensitively", () => {
    expect(filenameForDownload("https://example.com/x", 'attachment; Filename="report.pdf"', "application/pdf")).toBe(
      "report.pdf",
    );
  });

  it("accepts an RFC 5987 language tag in extended filenames", () => {
    expect(
      filenameForDownload(
        "https://example.com/x",
        "attachment; filename*=UTF-8'en'%E2%82%ACrates.pdf",
        "application/pdf",
      ),
    ).toBe("€rates.pdf");
  });

  it("prefers the content-disposition filename", () => {
    expect(
      filenameForDownload("https://example.com/x", 'attachment; filename="report final.pdf"', "application/pdf"),
    ).toBe("report final.pdf");
    expect(
      filenameForDownload(
        "https://example.com/x",
        "attachment; filename*=UTF-8''%E3%81%BB%E3%81%92.md",
        "text/markdown",
      ),
    ).toBe("ほげ.md");
  });

  it("never returns a path, only a basename", () => {
    expect(filenameForDownload("https://example.com/x", 'attachment; filename="../../etc/passwd"', "text/plain")).toBe(
      "passwd.txt",
    );
  });
});

describe("aggregate memory bound", () => {
  it("fails fast when the combined inputs exceed the per-run total", async () => {
    const dir = await scratchDir();
    const paths = [];
    // Six sparse files of 90 MiB each: every one passes the 100 MiB per-file check,
    // but the 540 MiB total crosses the 512 MiB per-run budget.
    for (const name of ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin", "f.bin"]) {
      const path = join(dir, name);
      await writeFile(path, "");
      await truncate(path, 90 * 1024 * 1024);
      paths.push(path);
    }
    const diagnostics = await diagnosticsOfRejection(resolveInputs(paths));
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe("memory-budget");
      expect(diagnostic.message).toContain("combined inputs exceed");
    }
  });
});

describe("bounded concurrent resolution", () => {
  it("preserves input order with more inputs than workers", async () => {
    const dir = await scratchDir();
    const names = Array.from({ length: 20 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    for (const name of names) {
      await writeFile(join(dir, name), name);
    }
    const resolved = await resolveInputs(names.map((name) => join(dir, name)));
    expect(resolved.map((entry) => entry.name)).toEqual(names);
  });
});

describe("filename truncation", () => {
  it("keeps the extension when shortening very long names", async () => {
    const longName = `${"a".repeat(200)}.json`;
    const [resolved] = await resolveInputs(["-"], {
      nameOverride: longName,
      readStdin: () => Promise.resolve(new Uint8Array([1])),
    });
    expect(resolved?.name.length).toBe(180);
    expect(resolved?.name.endsWith(".json")).toBe(true);
    expect(resolved?.contentType).toBe("application/json");
  });

  it("never splits a surrogate pair at the truncation boundary", async () => {
    const longName = `${"🎉".repeat(120)}.png`;
    const [resolved] = await resolveInputs(["-"], {
      nameOverride: longName,
      readStdin: () => Promise.resolve(new Uint8Array([1])),
    });
    const name = resolved?.name ?? "";
    expect(name.endsWith(".png")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(180);
    const stem = name.slice(0, -".png".length);
    const lastUnit = stem.charCodeAt(stem.length - 1);
    const endsOnLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
    expect(endsOnLoneHighSurrogate).toBe(false);
    expect(resolved?.contentType).toBe("image/png");
  });
});

describe("resolveInputs with stdin", () => {
  it("names piped bytes stdin.txt by default and records the source", async () => {
    const [resolved] = await resolveInputs(["-"], {
      readStdin: () => Promise.resolve(new TextEncoder().encode("piped")),
    });
    expect(resolved?.name).toBe("stdin.txt");
    expect(resolved?.contentType).toBe("text/plain");
    expect(resolved?.source).toBe("-");
    expect(Buffer.from(resolved?.data ?? new Uint8Array()).toString()).toBe("piped");
  });

  it("honors --name for stdin, including non-ASCII names", async () => {
    const [resolved] = await resolveInputs(["-"], {
      nameOverride: "ほげふが.md",
      readStdin: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    });
    expect(resolved?.name).toBe("ほげふが.md");
    expect(resolved?.contentType).toBe("text/markdown");
  });

  it("locates stdin failures at stdin", async () => {
    const [diagnostic] = await diagnosticsOfRejection(
      resolveInputs(["-"], { readStdin: () => Promise.reject(new Error("closed")) }),
    );
    expect(diagnostic).toEqual({ location: "stdin", severity: "error", code: "internal", message: "closed" });
  });
});
