import { existsSync, statSync, renameSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Rotate the log when it grows past this size (keeps one `.1` backup). */
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Keep recent diagnostics and every log with a corresponding daemon record. */
export function pruneOrphanLogs(directory: string, retentionMs = 7 * 86400_000): void {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const match = /^([a-f0-9]{16})\.log(?:\.1)?$/.exec(entry.name);
      if (!entry.isFile() || !match || existsSync(join(directory, `${match[1]}.json`))) continue;
      const file = join(directory, entry.name);
      try {
        if (Date.now() - statSync(file).mtimeMs >= retentionMs) rmSync(file, { force: true });
      } catch {
        // Another host may have reclaimed the same orphan.
      }
    }
  } catch {
    // Diagnostic cleanup must not prevent starting a browser.
  }
}

/**
 * Rotate `<log>` to `<log>.1` if it has grown past the limit. Meant to be called
 * before each (re)start, since a detached child appends to an inherited fd and
 * can't rotate itself mid-run. Best-effort: a failure here must not block startup.
 */
export function rotateLogIfNeeded(logFile: string, maxBytes = DEFAULT_MAX_LOG_BYTES): void {
  try {
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size < maxBytes) return;
    renameSync(logFile, `${logFile}.1`);
  } catch {
    // ignore
  }
}

/** Return the trailing `lines` lines of a log file (empty string if absent). */
export function tailFile(logFile: string, lines: number): string {
  try {
    if (!existsSync(logFile)) return '';
    const content = readFileSync(logFile, 'utf-8');
    return content.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}
