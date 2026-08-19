import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUTPUT_CHANNEL_NAME = 'Ollama Cloud';
const OUTPUT_CHANNEL_NAME_DEBUG = 'Ollama Cloud (Debug)';

/**
 * Redacts sensitive material from any string before it reaches the
 * OutputChannel log. This is the single choke point for Issue 8 — every
 * log method funnels through `format`, which calls this function once.
 *
 * Patterns redacted (order matters — most specific first):
 *   1. `Authorization: Bearer <token>`      → `Authorization: Bearer [REDACTED]`
 *   2. `Bearer <alphanumeric token>`         → `Bearer [REDACTED]`
 *   3. `"api_key":"<value>"` (JSON)          → `"api_key":"[REDACTED]"`
 *   4. `"apiKey":"<value>"`  (JSON)          → `"apiKey":"[REDACTED]"`
 *   5. `api_key=<value>` (query/CLI form)    → `api_key=[REDACTED]`
 *   6. `sk-<20+ alphanumeric chars>`         → `sk-[REDACTED]`
 *   7. `data:image/<mime>;base64,<payload>` → `data:image/[mime];base64,[REDACTED]`
 *
 * Why: a naive logger calls `JSON.stringify(detail)` unconditionally. If
 * a detail object carried an `Authorization` header or an `api_key` field,
 * the secret landed in the output channel log in cleartext. This layer
 * guarantees no secret pattern reaches the log, regardless of caller.
 *
 * Pattern 7 is defense-in-depth for the v0.4.0 security audit finding #1.
 * No active leak exists today (converted messages are not logged), but the
 * upcoming vision fallback feature will forward base64 image data URLs,
 * expanding the surface that could reach this logger.
 */
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // 1. Full Authorization header — most specific, apply before generic Bearer.
  // LOW-1 — `\s*` (not `\s+`) after both `:` and `Bearer` so the
  // no-space form `Authorization:Bearer<token>` is also redacted. Some
  // clients emit the header with no whitespace, and the old `\s+`
  // missed that form.
  { pattern: /Authorization:\s*Bearer\s*[^\s"']+/gi, replacement: 'Authorization: Bearer [REDACTED]' },
  // 2. Standalone "Bearer <token>" without the Authorization: prefix.
  { pattern: /Bearer\s*[A-Za-z0-9._-]{4,}/gi, replacement: 'Bearer [REDACTED]' },
  // 3. JSON "api_key":"..." (double quotes).
  { pattern: /"api_key"\s*:\s*"[^"]*"/gi, replacement: '"api_key":"[REDACTED]"' },
  // 4. JSON "apiKey":"..." (camelCase variant).
  { pattern: /"apiKey"\s*:\s*"[^"]*"/gi, replacement: '"apiKey":"[REDACTED]"' },
  // 5. Query-string / CLI form: api_key=<value> (stop at whitespace, &, or quote).
  { pattern: /api_key=[^\s&"']+/gi, replacement: 'api_key=[REDACTED]' },
  // 6. OpenAI-style key prefix sk- followed by 20+ alphanumeric chars.
  { pattern: /sk-[A-Za-z0-9]{20,}/gi, replacement: 'sk-[REDACTED]' },
  // 7. Base64 image data URLs (data:image/<mime>;base64,<payload>).
  // Defense-in-depth for v0.4.0 audit finding #1 — masks the entire base64
  // payload so vision-bound image bytes never reach the output channel,
  // regardless of the mime type (png, jpeg, webp, gif, svg+xml).
  { pattern: /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, replacement: 'data:image/[mime];base64,[REDACTED]' },
];

export function redactSensitive(input: string): string {
  let result = input;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

class Logger {
  private channel =
    vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private debugMode = false;
  /**
   * ArchCom 0011c Fix 5 — ring buffer of the most recent warn/error
   * entries. Capped at 100 so the diagnostics snapshot stays bounded.
   * Entries are the already-redacted, formatted log lines.
   */
  private readonly recentErrors: string[] = [];
  private static readonly RECENT_ERRORS_CAP = 100;

  /**
   * v0.12.0 — file-based debug log path (inside `globalStorageUri` so
   * it is accessible from distrobox/sandbox and survives across
   * sessions). Set once at activation via `logger.setDebugLogPath()`.
   * When set, every log line (INFO/WARN/ERROR/DEBUG) is ALSO appended
   * to this file — not just the OutputChannel. This makes logs
   * readable from a terminal (the OutputChannel is not readable from
   * shell, and distrobox isolates the extension host process).
   */
  private debugLogPath: string | undefined;

  /**
   * Sets the file path for file-based logging. Called once at
   * activation with `<globalStorageUri>/debug.log`. When set, every
   * log line is appended to this file in addition to the OutputChannel.
   * The file is rotated manually (not automatically) — it grows
   * unbounded; `collectDiagnostics` can surface its tail if needed.
   */
  setDebugLogPath(fsPath: string | undefined): void {
    this.debugLogPath = fsPath;
    if (fsPath) {
      try {
        // Ensure parent dir exists (globalStorageUri may not exist yet).
        fs.mkdirSync(path.dirname(fsPath), { recursive: true });
        // Touch the file so it exists even before the first log line.
        if (!fs.existsSync(fsPath)) {
          fs.writeFileSync(fsPath, '');
        }
      } catch {
        // best-effort — if globalStorage is unavailable, file logging
        // silently degrades to OutputChannel-only (the original path).
        this.debugLogPath = undefined;
      }
    }
  }

  setDebugMode(enabled: boolean): void {
    // ArchCom 0011c Fix 5b — when debug mode is toggled, recreate the
    // output channel under the discoverable "Ollama Cloud (Debug)" name
    // (or revert to the standard name). The old channel is disposed to
    // avoid a stale panel lingering in the Output dropdown.
    const desiredName = enabled
      ? OUTPUT_CHANNEL_NAME_DEBUG
      : OUTPUT_CHANNEL_NAME;
    if (this.channel.name !== desiredName) {
      // Preserve recent errors across the swap — they belong to the
      // session, not the channel instance.
      this.channel.dispose();
      this.channel = vscode.window.createOutputChannel(desiredName);
    }
    this.debugMode = enabled;
    if (enabled) {
      // Auto-show the panel (pinned, not focused) so the user does not
      // have to hunt for it in the Output dropdown when they enable
      // debug logging.
      this.channel.show(true);
    }
  }

  debug(message: string): void {
    if (this.debugMode) {
      this.channel.appendLine(this.format('DEBUG', message, []));
    }
  }

  info(message: string, ...details: unknown[]): void {
    this.channel.appendLine(this.format('INFO', message, details));
  }

  warn(message: string, ...details: unknown[]): void {
    const formatted = this.format('WARN', message, details);
    this.channel.appendLine(formatted);
    this.pushRecentError(formatted);
  }

  error(message: string, ...details: unknown[]): void {
    const formatted = this.format('ERROR', message, details);
    this.channel.appendLine(formatted);
    this.pushRecentError(formatted);
  }

  /**
   * Returns the most recent warn/error log lines (oldest-first), capped
   * at 100 entries. Used by the `ollamaCloud.collectDiagnostics`
   * command to attach recent errors to a bug-report snapshot. Values are
   * already redacted via {@link redactSensitive}.
   */
  getRecentErrors(): string[] {
    return [...this.recentErrors];
  }

  private pushRecentError(formatted: string): void {
    this.recentErrors.push(formatted);
    if (this.recentErrors.length > Logger.RECENT_ERRORS_CAP) {
      this.recentErrors.shift();
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private format(level: string, message: string, details: unknown[]): string {
    const suffix = details
      .map((detail) => {
        if (detail instanceof Error) {
          return detail.stack || detail.message;
        }
        if (typeof detail === 'string') {
          return detail;
        }
        try {
          return JSON.stringify(detail);
        } catch {
          return String(detail);
        }
      })
      .filter(Boolean)
      .join(' ');

    // Redact sensitive material from both the caller's message and the
    // serialized details. This is the single entry-point call — no other
    // log path bypasses it.
    const formatted = redactSensitive(
      `[${new Date().toISOString()}] [${level}] ${message}${suffix ? ` ${suffix}` : ''}`,
    );

    // v0.12.0 — also append to the file-based debug log when configured.
    // This makes logs readable from a terminal (OutputChannel is not
    // readable from shell, and distrobox isolates the extension host).
    // Best-effort: a write failure does NOT break the OutputChannel path.
    if (this.debugLogPath) {
      try {
        fs.appendFileSync(this.debugLogPath, formatted + '\n');
      } catch {
        // Deactivate file logging after a persistent failure to avoid
        // retrying on every line (e.g. disk full, permissions revoked).
        this.debugLogPath = undefined;
      }
    }

    return formatted;
  }
}

export const logger = new Logger();
