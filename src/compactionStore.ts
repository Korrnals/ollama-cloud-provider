/**
 * v0.13.0 Slice 2 — extension-local evicted-block store (spec:
 * docs/compaction-spec.md § Slice 2).
 *
 * Content-addressed file store under
 * `<globalStorage>/compaction/<sha256-hex>.txt`. The compaction core
 * (`compaction.ts`) persists each evicted block here and embeds the
 * returned pointer (`ocp-compaction://<hash>`) into the injected
 * summary message, so the full evicted history stays retrievable
 * after the context was compacted (slice 1.1: the summarizer prompt
 * may be capped, the store never is).
 *
 * Security posture:
 *   - Pointer scheme is fixed: `ocp-compaction://` + exactly 64
 *     lowercase hex chars. `resolve` validates the hash against
 *     `^[0-9a-f]{64}$` BEFORE touching the filesystem — this
 *     rejects every traversal vector (`..`, `/`, separators,
 *     non-hex junk) in one check, because a well-formed sha256 hex
 *     digest contains none of those characters.
 *   - Writes go to a directory derived solely from the constructor
 *     `storageUri`; user input never influences the path.
 *
 * Retention: `prune(keepCount = 200)` deletes the oldest files by
 * mtime beyond `keepCount` and is called opportunistically after
 * every `store`, so the directory cannot grow unbounded across a
 * long session. Prune failures are swallowed — retention is
 * best-effort and must never fail a compaction.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';

/** Pointer URL scheme prefix for compaction blocks. */
export const COMPACTION_POINTER_SCHEME = 'ocp-compaction://';

/** Default retention — number of newest blocks kept by `prune`. */
export const COMPACTION_PRUNE_KEEP_DEFAULT = 200;

/** sha256 hex digest — the only legal pointer payload. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class CompactionStore {
  private readonly dir: string;

  constructor(storageUri: vscode.Uri) {
    this.dir = path.join(storageUri.fsPath, 'compaction');
  }

  /**
   * Persists `text` content-addressed and returns its pointer
   * `ocp-compaction://<sha256-hex>`. Idempotent: storing already-known
   * content reuses the existing file (no rewrite, same pointer).
   * Prune runs opportunistically afterwards (best-effort, failures
   * swallowed).
   */
  async store(text: string): Promise<string> {
    const hash = sha256Hex(text);
    const file = path.join(this.dir, `${hash}.txt`);
    await fs.mkdir(this.dir, { recursive: true });
    try {
      await fs.access(file);
      // Idempotent: content-addressed — same hash means same bytes.
    } catch {
      await fs.writeFile(file, text, 'utf8');
    }
    try {
      await this.prune();
    } catch (error) {
      // Retention is best-effort — a prune failure must not fail the
      // compaction (the caller's fallback contract would degrade the
      // chat for a housekeeping problem).
      void error;
    }
    return `${COMPACTION_POINTER_SCHEME}${hash}`;
  }

  /**
   * Reads back the block for a pointer. Returns `null` for unknown
   * hashes, foreign schemes, and every malformed pointer — the hash
   * is validated against `^[0-9a-f]{64}$` BEFORE any filesystem
   * access, which rejects traversal payloads (`/`, `..`, non-hex).
   */
  async resolve(pointer: string): Promise<string | null> {
    if (!pointer.startsWith(COMPACTION_POINTER_SCHEME)) return null;
    const hash = pointer.slice(COMPACTION_POINTER_SCHEME.length);
    if (!SHA256_HEX.test(hash)) return null;
    try {
      return await fs.readFile(path.join(this.dir, `${hash}.txt`), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Deletes the oldest blocks (by mtime) beyond `keepCount` and
   * returns the number of files removed. A missing directory removes
   * nothing (returns 0).
   */
  async prune(keepCount: number = COMPACTION_PRUNE_KEEP_DEFAULT): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const statted: Array<{ file: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
      const file = path.join(this.dir, entry.name);
      try {
        const stat = await fs.stat(file);
        statted.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // Raced with a concurrent prune — skip the vanished file.
      }
    }
    statted.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const excess = statted.slice(0, Math.max(0, statted.length - keepCount));
    for (const { file } of excess) {
      try {
        await fs.unlink(file);
      } catch {
        // Already gone — nothing to do.
      }
    }
    return excess.length;
  }
}
