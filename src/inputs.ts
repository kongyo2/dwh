import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { describeFetchError, proxyAwareFetch, type FetchLike } from "./http.js";

/** A file ready to be attached to a Discord message. */
export interface OutgoingFile {
  name: string;
  data: Uint8Array;
  contentType: string;
}

export interface ResolveOptions {
  /** Filename to use in Discord instead of the derived one. Only meaningful with a single input. */
  nameOverride?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  readStdin?: (() => Promise<Uint8Array>) | undefined;
}

/** Discord's ceiling at the highest server boost tier; nothing larger can ever be accepted. */
export const MAX_FILE_BYTES: number = 100 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FILENAME_LENGTH = 180;
const FALLBACK_CONTENT_TYPE = "application/octet-stream";

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
 * Every failing input is reported, not just the first one.
 */
export async function resolveInputs(specs: readonly string[], options: ResolveOptions = {}): Promise<OutgoingFile[]> {
  const results = await Promise.allSettled(specs.map((spec) => resolveOne(spec, options)));
  const failures: string[] = [];
  const files: OutgoingFile[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      files.push(result.value);
    } else {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return files;
}

async function resolveOne(spec: string, options: ResolveOptions): Promise<OutgoingFile> {
  if (spec === "-") {
    return resolveStdin(options);
  }
  if (isUrl(spec)) {
    return download(spec, options);
  }
  return readLocalFile(spec, options.nameOverride);
}

async function readLocalFile(path: string, nameOverride: string | undefined): Promise<OutgoingFile> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`${path}: no such file (URLs must start with http:// or https://)`, { cause: error });
    }
    throw new Error(`${path}: cannot read (${code ?? describeFetchError(error)})`, { cause: error });
  }
  if (info.isDirectory()) {
    throw new Error(`${path}: is a directory — archive it first (for example: zip -r out.zip ${path})`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `${path}: ${formatMiB(info.size)} exceeds Discord's absolute limit of ${formatMiB(MAX_FILE_BYTES)}`,
    );
  }
  const data = await readFile(path);
  const name = sanitizeFilename(nameOverride ?? basename(path)) || "file";
  return { name, data, contentType: contentTypeForName(name) };
}

async function download(url: string, options: ResolveOptions): Promise<OutgoingFile> {
  const fetchImpl = options.fetchImpl ?? proxyAwareFetch;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": "dwh" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`GET ${url} failed: ${describeFetchError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`.trimEnd());
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    throw new Error(
      `${url}: ${formatMiB(declaredLength)} exceeds Discord's absolute limit of ${formatMiB(MAX_FILE_BYTES)}`,
    );
  }
  const data = await readBodyCapped(response, url);
  const headerType = normalizeContentType(response.headers.get("content-type"));
  const overrideName = sanitizeFilename(options.nameOverride ?? "");
  if (overrideName !== "") {
    // Like the local-file and stdin paths, --name also decides the content type when its extension is known.
    return { name: overrideName, data, contentType: extensionContentType(overrideName) ?? headerType };
  }
  const name = filenameForDownload(response.url || url, response.headers.get("content-disposition"), headerType);
  return { name, data, contentType: headerType };
}

async function resolveStdin(options: ResolveOptions): Promise<OutgoingFile> {
  const read = options.readStdin ?? readProcessStdin;
  const data = await read();
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `stdin: ${formatMiB(data.byteLength)} exceeds Discord's absolute limit of ${formatMiB(MAX_FILE_BYTES)}`,
    );
  }
  const name = sanitizeFilename(options.nameOverride ?? "") || "stdin.txt";
  return { name, data, contentType: contentTypeForName(name) };
}

async function readProcessStdin(): Promise<Uint8Array> {
  if (process.stdin.isTTY) {
    throw new Error(
      '"-" reads the file from stdin, but stdin is a terminal — pipe something in (for example: git diff | dwh - --name changes.diff)',
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
    total += bytes.byteLength;
    if (total > MAX_FILE_BYTES) {
      throw new Error(`stdin: exceeds Discord's absolute limit of ${formatMiB(MAX_FILE_BYTES)}`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

class SizeLimitError extends Error {}

async function readBodyCapped(response: Awaited<ReturnType<FetchLike>>, url: string): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_FILE_BYTES) {
        throw new SizeLimitError(`${url}: response exceeds Discord's absolute limit of ${formatMiB(MAX_FILE_BYTES)}`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SizeLimitError) {
      throw error;
    }
    throw new Error(`GET ${url} failed while reading the response: ${describeFetchError(error)}`, { cause: error });
  }
  return Buffer.concat(chunks);
}

/** Derive the filename Discord will show for a downloaded URL. Exported for tests. */
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
  const star = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
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
  return visible.trim().slice(0, MAX_FILENAME_LENGTH);
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

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
