import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  adviceDiagnostic,
  DiagnosticError,
  diagnosticsOf,
  errorDiagnostic,
  scrubDiagnostic,
  type Diagnostic,
} from "./diagnostics.js";
import {
  defaultSleep,
  describeFetchError,
  formatSeconds,
  MAX_TRANSIENT_ATTEMPTS,
  proxyAwareFetch,
  transientDelayMs,
  type FetchLike,
} from "./http.js";
import { formatMiB, shellQuote } from "./text.js";
import { isWebhookUrl } from "./webhook.js";
import { wordingFor, type Wording } from "./wording.js";

/** A file ready to be attached to a message. */
export interface OutgoingFile {
  name: string;
  data: Uint8Array;
  contentType: string;
  /** The input spec this came from (a path, a URL, or "-" for stdin), when known. */
  source?: string | undefined;
}

export interface ResolveOptions {
  /** Filename to show instead of the derived one. Only meaningful with a single input. */
  nameOverride?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  readStdin?: (() => Promise<Uint8Array>) | undefined;
  /** Progress notes worth relaying (download retries). Always severity "advice", never an error. */
  onDiagnostic?: ((diagnostic: Diagnostic) => void) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Word every message so that it never names the service files are delivered to. */
  hideDestination?: boolean | undefined;
}

/** The ceiling at the highest server boost tier; nothing larger can ever be accepted. */
export const MAX_FILE_BYTES: number = 100 * 1024 * 1024;

/** Everything is buffered in memory before sending, so one run caps the combined input bytes. */
export const MAX_TOTAL_BYTES: number = 512 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FILENAME_LENGTH = 180;
const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const STDIN_LOCATION = "stdin";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
  json: "application/json",
  jsonl: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  xml: "application/xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "text/html": "html",
  "application/json": "json",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "text/css": "css",
  "text/javascript": "js",
  "text/yaml": "yaml",
  "text/tab-separated-values": "tsv",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function isUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

/**
 * Turn CLI input specs (local paths, http(s) URLs, "-" for stdin) into files ready to send.
 * All inputs are resolved before anything is sent, so a bad input never leaves a half-delivered set.
 * Every failing input is reported (one diagnostic each), not just the first one.
 */
export async function resolveInputs(specs: readonly string[], options: ResolveOptions = {}): Promise<OutgoingFile[]> {
  const wording = wordingFor(options.hideDestination);
  const onDiagnostic = options.onDiagnostic;
  const context: ResolveContext = {
    options,
    wording,
    budget: { used: 0 },
    // Notes and thrown diagnostics alike reach the caller scrubbed: an input that is itself a
    // webhook URL must not leak its token, and in hidden mode it must not name the service.
    emit:
      onDiagnostic === undefined
        ? () => undefined
        : (diagnostic) => onDiagnostic(scrubDiagnostic(diagnostic, wording.scrub)),
  };
  const results = await allSettledBounded(
    specs.map((spec) => () => resolveOne(spec, context)),
    CONCURRENT_INPUT_RESOLVERS,
  );
  const failures: Diagnostic[] = [];
  const files: OutgoingFile[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      files.push(result.value);
    } else {
      for (const diagnostic of diagnosticsOf(result.reason, locationOf(specs[index] ?? ""))) {
        failures.push(scrubDiagnostic(diagnostic, wording.scrub));
      }
    }
  }
  if (failures.length > 0) {
    throw new DiagnosticError(failures);
  }
  return files;
}

interface ResolveContext {
  readonly options: ResolveOptions;
  readonly wording: Wording;
  readonly budget: BufferBudget;
  readonly emit: (diagnostic: Diagnostic) => void;
}

function locationOf(spec: string): string {
  return spec === "-" ? STDIN_LOCATION : spec;
}

async function resolveOne(spec: string, context: ResolveContext): Promise<OutgoingFile> {
  if (spec === "-") {
    return resolveStdin(context);
  }
  if (isUrl(spec)) {
    if (isWebhookUrl(spec)) {
      // Downloading the webhook itself would fetch the webhook object, token included, and
      // post it into the channel as a file. Nobody means that.
      throw new DiagnosticError([
        errorDiagnostic(
          spec,
          "download-failed",
          "refusing to download this URL: it is the delivery destination itself, not a file to deliver",
          "pass the file you want delivered, e.g. dwh ./report.md",
        ),
      ]);
    }
    return download(spec, context);
  }
  return readLocalFile(spec, context);
}

const CONCURRENT_INPUT_RESOLVERS = 8;

/**
 * Run tasks with bounded concurrency, keeping result order. Hundreds of inputs must not
 * open every file descriptor and connection at once just because they were listed together.
 */
async function allSettledBounded<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (task === undefined) {
        return;
      }
      try {
        results[index] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Bytes retained in memory across all concurrently resolving inputs of one run. */
interface BufferBudget {
  used: number;
}

function claimBufferBytes(budget: BufferBudget, bytes: number, location: string): void {
  if (budget.used + bytes > MAX_TOTAL_BYTES) {
    throw new DiagnosticError([
      errorDiagnostic(
        location,
        "memory-budget",
        `combined inputs exceed the ${formatMiB(MAX_TOTAL_BYTES)} dwh holds in memory per run`,
        "send fewer or smaller files per run; split the list across several dwh invocations",
      ),
    ]);
  }
  budget.used += bytes;
}

function tooLarge(location: string, actual: number, wording: Wording, splitSource?: string): DiagnosticError {
  let help = "shrink it, or split it into parts under the destination's per-file limit";
  if (splitSource !== undefined) {
    const stem = shellQuote(basename(splitSource) || "file");
    help = `shrink it or split it, e.g. split -b 9M ${shellQuote(splitSource)} ${stem}.part- && dwh ${stem}.part-*`;
  }
  return new DiagnosticError([
    errorDiagnostic(location, "too-large", wording.tooLarge(formatMiB(actual), formatMiB(MAX_FILE_BYTES)), help),
  ]);
}

/** A path that could not be stat'ed or read: a vanished path is `not-found`, anything else `unreadable`. */
function readFailure(path: string, error: unknown): DiagnosticError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new DiagnosticError(
      [
        errorDiagnostic(
          path,
          "not-found",
          "no such file",
          `check the path (ls -la ${shellQuote(dirname(path))}); a URL must start with http:// or https://`,
        ),
      ],
      { cause: error },
    );
  }
  return new DiagnosticError(
    [
      errorDiagnostic(
        path,
        "unreadable",
        `cannot read (${code ?? describeFetchError(error)})`,
        `check permissions: ls -la ${shellQuote(path)}`,
      ),
    ],
    { cause: error },
  );
}

async function readLocalFile(path: string, context: ResolveContext): Promise<OutgoingFile> {
  const { budget, wording } = context;
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw readFailure(path, error);
  }
  if (info.isDirectory()) {
    const archive = `${basename(path) || "archive"}.zip`;
    throw new DiagnosticError([
      errorDiagnostic(
        path,
        "is-directory",
        "is a directory",
        `archive it first, e.g. zip -r ${shellQuote(archive)} ${shellQuote(path)} && dwh ${shellQuote(archive)}`,
      ),
    ]);
  }
  if (!info.isFile()) {
    // A FIFO blocks readFile until a writer closes it and a device like /dev/zero never ends,
    // so only regular files are read from a path; streams go through stdin, which is capped.
    throw new DiagnosticError([
      errorDiagnostic(
        path,
        "not-regular-file",
        "not a regular file (device, socket, or pipe)",
        `pipe it through stdin instead: cat ${shellQuote(path)} | dwh - --name ${shellQuote(basename(path) || "file")}`,
      ),
    ]);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw tooLarge(path, info.size, wording, path);
  }
  claimBufferBytes(budget, info.size, path);
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    // stat() succeeding says nothing about the contents being readable (mode 000, a file
    // that vanished in between, an I/O error), so this failure is classified the same way.
    budget.used -= info.size;
    throw readFailure(path, error);
  }
  if (data.byteLength !== info.size) {
    // The file changed between stat() and the read (say, a log still being written);
    // the limits must hold for the bytes actually in memory, not the stale stat size.
    budget.used -= info.size;
    if (data.byteLength > MAX_FILE_BYTES) {
      throw tooLarge(path, data.byteLength, wording, path);
    }
    claimBufferBytes(budget, data.byteLength, path);
  }
  const name = sanitizeFilename(context.options.nameOverride ?? basename(path)) || "file";
  return { name, data, contentType: contentTypeForName(name), source: path };
}

async function download(url: string, context: ResolveContext): Promise<OutgoingFile> {
  const { options, budget, wording, emit } = context;
  const fetchImpl = options.fetchImpl ?? proxyAwareFetch;
  const sleep = options.sleep ?? defaultSleep;
  const checkHelp = `check the URL (curl -sSI ${shellQuote(url)}); it must be reachable without credentials from this machine`;
  const giveUpHelp = `the server may be down; retry later, or download it yourself and send the file`;
  let transientFailures = 0;
  // The whole GET (connect, status, and body) sits inside one retry boundary, with the same
  // bounded transient-failure policy the delivery uses.
  for (;;) {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: { "user-agent": "dwh" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      transientFailures += 1;
      const description = describeFetchError(error);
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        throw new DiagnosticError(
          [
            errorDiagnostic(
              url,
              "download-failed",
              `GET failed after ${MAX_TRANSIENT_ATTEMPTS} attempts: ${description}`,
              giveUpHelp,
            ),
          ],
          { cause: error },
        );
      }
      const delayMs = transientDelayMs(transientFailures);
      emit(adviceDiagnostic(url, "retry", `GET failed (${description}); retrying in ${formatSeconds(delayMs)}`));
      await sleep(delayMs);
      continue;
    }
    if (response.status >= 500) {
      // Cancel the unread body so the connection is released between attempts.
      await response.body?.cancel().catch(() => undefined);
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        throw new DiagnosticError([
          errorDiagnostic(
            url,
            "download-failed",
            `GET failed: ${describeStatus(response)} (after ${MAX_TRANSIENT_ATTEMPTS} attempts)`,
            giveUpHelp,
          ),
        ]);
      }
      const delayMs = transientDelayMs(transientFailures);
      emit(adviceDiagnostic(url, "retry", `GET returned ${response.status}; retrying in ${formatSeconds(delayMs)}`));
      await sleep(delayMs);
      continue;
    }
    if (!response.ok) {
      throw new DiagnosticError([
        errorDiagnostic(url, "download-failed", `GET failed: ${describeStatus(response)}`, checkHelp),
      ]);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
      throw tooLarge(url, declaredLength, wording);
    }
    let data: Uint8Array;
    try {
      data = await readBodyCapped(response, url, budget, wording);
    } catch (error) {
      if (error instanceof DiagnosticError) {
        // A limit was hit; a retry would hit it again.
        throw error;
      }
      // A body that dies mid-stream is as transient as a failed connect; a fresh GET restarts it
      // (readBodyCapped has already handed the failed attempt's bytes back to the budget).
      transientFailures += 1;
      const description = describeFetchError(error);
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
        throw new DiagnosticError(
          [
            errorDiagnostic(
              url,
              "download-failed",
              `GET failed while reading the response: ${description} (after ${MAX_TRANSIENT_ATTEMPTS} attempts)`,
              giveUpHelp,
            ),
          ],
          { cause: error },
        );
      }
      const delayMs = transientDelayMs(transientFailures);
      emit(
        adviceDiagnostic(
          url,
          "retry",
          `GET failed while reading the response (${description}); retrying in ${formatSeconds(delayMs)}`,
        ),
      );
      await sleep(delayMs);
      continue;
    }
    const headerType = normalizeContentType(response.headers.get("content-type"));
    const overrideName = sanitizeFilename(options.nameOverride ?? "");
    if (overrideName !== "") {
      // Like the local-file and stdin paths, --name also decides the content type when its extension is known.
      return { name: overrideName, data, contentType: extensionContentType(overrideName) ?? headerType, source: url };
    }
    const name = filenameForDownload(response.url || url, response.headers.get("content-disposition"), headerType);
    return { name, data, contentType: headerType, source: url };
  }
}

function describeStatus(response: Awaited<ReturnType<FetchLike>>): string {
  return `${response.status} ${response.statusText}`.trimEnd();
}

async function resolveStdin(context: ResolveContext): Promise<OutgoingFile> {
  const { options, budget, wording } = context;
  const read = options.readStdin ?? readProcessStdin;
  const data = await read();
  if (data.byteLength > MAX_FILE_BYTES) {
    throw tooLarge(STDIN_LOCATION, data.byteLength, wording);
  }
  claimBufferBytes(budget, data.byteLength, STDIN_LOCATION);
  const name = sanitizeFilename(options.nameOverride ?? "") || "stdin.txt";
  return { name, data, contentType: contentTypeForName(name), source: "-" };
}

async function readProcessStdin(): Promise<Uint8Array> {
  if (process.stdin.isTTY) {
    throw new DiagnosticError([
      errorDiagnostic(
        STDIN_LOCATION,
        "stdin-is-tty",
        '"-" reads the file from stdin, but stdin is a terminal',
        "pipe something in, e.g. git diff | dwh - --name changes.diff",
      ),
    ]);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_FILE_BYTES) {
      throw new DiagnosticError([
        errorDiagnostic(
          STDIN_LOCATION,
          "too-large",
          `stdin exceeds the absolute per-file limit of ${formatMiB(MAX_FILE_BYTES)}`,
          "shrink it, or split it into parts under the destination's per-file limit",
        ),
      ]);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readBodyCapped(
  response: Awaited<ReturnType<FetchLike>>,
  url: string,
  budget: BufferBudget,
  wording: Wording,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let claimed = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_FILE_BYTES) {
        throw tooLarge(url, total, wording);
      }
      claimBufferBytes(budget, chunk.byteLength, url);
      claimed += chunk.byteLength;
      chunks.push(chunk);
    }
    // Concatenating briefly doubles this download's bytes, so that peak counts against the
    // run budget too; the chunk copies' share is handed back once the result buffer exists.
    claimBufferBytes(budget, total, url);
    const data = Buffer.concat(chunks);
    budget.used -= total;
    return data;
  } catch (error) {
    // A failed attempt retains nothing, so its claim goes back (a retry claims afresh).
    budget.used -= claimed;
    throw error;
  }
}

/** Derive the filename to show for a downloaded URL. Exported for tests. */
export function filenameForDownload(finalUrl: string, contentDisposition: string | null, contentType: string): string {
  let name = "";
  let fromHostname = false;
  if (contentDisposition !== null) {
    name = sanitizeFilename(filenameFromContentDisposition(contentDisposition) ?? "");
  }
  if (name === "") {
    name = sanitizeFilename(pathBasename(finalUrl));
  }
  if (name === "") {
    // A hostname's dots are not a file extension, so the content-type extension is always appended below.
    name = sanitizeFilename(hostnameOf(finalUrl)) || "download";
    fromHostname = true;
  }
  if (fromHostname || !/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    if (extension !== undefined) {
      name = `${name}.${extension}`;
    }
  }
  return name;
}

function filenameFromContentDisposition(header: string): string | undefined {
  const star = /filename\*\s*=\s*utf-8'[^']*'([^;]+)/i.exec(header);
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain filename parameter
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1] !== undefined) {
    return quoted[1].replace(/\\(.)/g, "$1");
  }
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  const value = bare?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function pathBasename(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  const segment = pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sanitizeFilename(name: string): string {
  const lastSegment = name.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";
  let visible = "";
  for (const char of lastSegment) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > 0x1f && codePoint !== 0x7f) {
      visible += char;
    }
  }
  const trimmed = visible.trim();
  if (trimmed.length <= MAX_FILENAME_LENGTH) {
    return trimmed;
  }
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(trimmed)?.[0] ?? "";
  const stemBudget = MAX_FILENAME_LENGTH - extension.length;
  // Cut between code points, not UTF-16 units: a split surrogate pair would corrupt the name.
  let stem = "";
  for (const char of trimmed) {
    if (stem.length + char.length > stemBudget) {
      break;
    }
    stem += char;
  }
  return stem + extension;
}

function extensionContentType(name: string): string | undefined {
  const parts = name.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  return CONTENT_TYPE_BY_EXTENSION[(parts.at(-1) ?? "").toLowerCase()];
}

function contentTypeForName(name: string): string {
  return extensionContentType(name) ?? FALLBACK_CONTENT_TYPE;
}

function normalizeContentType(header: string | null): string {
  const bare = header?.split(";")[0]?.trim().toLowerCase();
  return bare === undefined || bare === "" ? FALLBACK_CONTENT_TYPE : bare;
}
