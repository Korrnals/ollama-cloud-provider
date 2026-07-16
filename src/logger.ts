import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Ollama Cloud';

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
 *
 * Why: upstream called `JSON.stringify(detail)` unconditionally. If a
 * detail object carried an `Authorization` header or an `api_key` field,
 * the secret landed in the output channel log in cleartext. This layer
 * guarantees no secret pattern reaches the log, regardless of caller.
 */
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // 1. Full Authorization header — most specific, apply before generic Bearer.
  { pattern: /Authorization:\s*Bearer\s+[^\s"']+/gi, replacement: 'Authorization: Bearer [REDACTED]' },
  // 2. Standalone "Bearer <token>" without the Authorization: prefix.
  { pattern: /Bearer\s+[A-Za-z0-9._-]{4,}/gi, replacement: 'Bearer [REDACTED]' },
  // 3. JSON "api_key":"..." (double quotes).
  { pattern: /"api_key"\s*:\s*"[^"]*"/gi, replacement: '"api_key":"[REDACTED]"' },
  // 4. JSON "apiKey":"..." (camelCase variant).
  { pattern: /"apiKey"\s*:\s*"[^"]*"/gi, replacement: '"apiKey":"[REDACTED]"' },
  // 5. Query-string / CLI form: api_key=<value> (stop at whitespace, &, or quote).
  { pattern: /api_key=[^\s&"']+/gi, replacement: 'api_key=[REDACTED]' },
  // 6. OpenAI-style key prefix sk- followed by 20+ alphanumeric chars.
  { pattern: /sk-[A-Za-z0-9]{20,}/gi, replacement: 'sk-[REDACTED]' },
];

function redactSensitive(input: string): string {
  let result = input;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

class Logger {
  private readonly channel =
    vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  info(message: string, ...details: unknown[]): void {
    this.channel.appendLine(this.format('INFO', message, details));
  }

  warn(message: string, ...details: unknown[]): void {
    this.channel.appendLine(this.format('WARN', message, details));
  }

  error(message: string, ...details: unknown[]): void {
    this.channel.appendLine(this.format('ERROR', message, details));
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
    return redactSensitive(
      `[${new Date().toISOString()}] [${level}] ${message}${suffix ? ` ${suffix}` : ''}`,
    );
  }
}

export const logger = new Logger();
