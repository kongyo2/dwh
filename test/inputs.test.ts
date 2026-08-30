import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/http.js";
import { filenameForDownload, isUrl, resolveInputs } from "../src/inputs.js";

function fetchReturning(response: Response): FetchLike {
  return (async () => response) as unknown as FetchLike;
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dwh-test-"));
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
  it("reads a file and derives name and content type", async () => {
    const dir = await scratchDir();
    const path = join(dir, "notes.md");
    await writeFile(path, "# hello");
    const [resolved] = await resolveInputs([path]);
    expect(resolved?.name).toBe("notes.md");
    expect(resolved?.contentType).toBe("text/markdown");
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

  it("rejects a missing path with the path in the message", async () => {
    const dir = await scratchDir();
    const missing = join(dir, "nope.txt");
    await expect(resolveInputs([missing])).rejects.toThrow(missing);
    await expect(resolveInputs([missing])).rejects.toThrow(/no such file/);
  });

  it("rejects a directory with advice to archive it", async () => {
    const dir = await scratchDir();
    await expect(resolveInputs([dir])).rejects.toThrow(/is a directory/);
  });

  it("reports every failing input, not just the first", async () => {
    const dir = await scratchDir();
    const first = join(dir, "one.txt");
    const second = join(dir, "two.txt");
    const error = await resolveInputs([first, second]).then(
      () => {
        throw new Error("expected resolveInputs to reject");
      },
      (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
    );
    expect(error.message).toContain("one.txt");
    expect(error.message).toContain("two.txt");
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
    expect(Buffer.from(resolved?.data ?? new Uint8Array()).toString()).toBe("hello");
  });

  it("rejects a non-2xx response with the status", async () => {
    const response = new Response("gone", { status: 404, statusText: "Not Found" });
    await expect(
      resolveInputs(["https://example.com/missing"], { fetchImpl: fetchReturning(response) }),
    ).rejects.toThrow(/GET https:\/\/example\.com\/missing failed: 404/);
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

  it("names the URL when the response body fails mid-read", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("terminated"));
      },
    });
    const response = new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    await expect(
      resolveInputs(["https://example.com/flaky.txt"], { fetchImpl: fetchReturning(response) }),
    ).rejects.toThrow(/GET https:\/\/example\.com\/flaky\.txt failed while reading the response/);
  });

  it("rejects a download whose declared size can never fit in Discord", async () => {
    const response = new Response("tiny", {
      status: 200,
      headers: { "content-length": String(200 * 1024 * 1024) },
    });
    await expect(
      resolveInputs(["https://example.com/huge.bin"], { fetchImpl: fetchReturning(response) }),
    ).rejects.toThrow(/exceeds Discord's absolute limit/);
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

describe("resolveInputs with stdin", () => {
  it("names piped bytes stdin.txt by default", async () => {
    const [resolved] = await resolveInputs(["-"], {
      readStdin: () => Promise.resolve(new TextEncoder().encode("piped")),
    });
    expect(resolved?.name).toBe("stdin.txt");
    expect(resolved?.contentType).toBe("text/plain");
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
});
