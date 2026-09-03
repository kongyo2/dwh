/** Small formatting helpers shared by the resolver, the sender, and the CLI. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  for (const unit of ["KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") {
      return `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Quote a word for a POSIX shell only when it needs it, so example commands stay copy-pasteable. */
export function shellQuote(word: string): string {
  if (word !== "" && /^[\w./@:=+,%-]+$/.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", "'\\''")}'`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
