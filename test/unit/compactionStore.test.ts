import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  COMPACTION_POINTER_SCHEME,
  CompactionStore,
} from '../../src/compactionStore.js';

/**
 * v0.13.0 Slice 2 — CompactionStore unit tests (spec:
 * docs/compaction-spec.md § Slice 2 tests).
 *
 * Uses a real tmp directory via node:fs — the store is a thin,
 * content-addressed file layer and its contract (idempotent pointers,
 * traversal-proof resolve, mtime-based prune) is inherently
 * filesystem-shaped. The vscode.Uri is faked with the stub pattern
 * from test/_vscode-stub.mjs (`{ fsPath }` plain object), the same
 * way provider tests fake `extensionUri`.
 */

function tmpUri(): { uri: vscode.Uri; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocp-compaction-store-'));
  const uri = {
    fsPath: dir,
    toString: () => `file://${dir}`,
  } as unknown as vscode.Uri;
  return { uri, dir };
}

describe('CompactionStore (v0.13.0 slice 2)', () => {
  it('store → resolve roundtrip returns the exact text', async () => {
    const { uri } = tmpUri();
    const store = new CompactionStore(uri);
    const pointer = await store.store('evicted block #1');

    assert.ok(
      pointer.startsWith(COMPACTION_POINTER_SCHEME),
      `pointer uses the ${COMPACTION_POINTER_SCHEME} scheme`,
    );
    const hash = pointer.slice(COMPACTION_POINTER_SCHEME.length);
    assert.match(hash, /^[0-9a-f]{64}$/, 'pointer payload is sha256 hex');

    assert.equal(await store.resolve(pointer), 'evicted block #1');
  });

  it('store is idempotent — same text returns the same pointer and writes one file', async () => {
    const { uri, dir } = tmpUri();
    const store = new CompactionStore(uri);

    const p1 = await store.store('same content');
    const p2 = await store.store('same content');
    assert.equal(p1, p2, 'identical content → identical pointer');

    const files = (await fs.readdir(path.join(dir, 'compaction'))).filter((f) =>
      f.endsWith('.txt'),
    );
    assert.equal(files.length, 1, 'exactly one file for identical content');
  });

  it('resolve rejects traversal and malformed pointers with null', async () => {
    const { uri } = tmpUri();
    const store = new CompactionStore(uri);
    await store.store('real block');

    const badPointers = [
      `${COMPACTION_POINTER_SCHEME}../secrets`,
      `${COMPACTION_POINTER_SCHEME}..%2F..%2Fetc%2Fpasswd`,
      `${COMPACTION_POINTER_SCHEME}abc/def`,
      `${COMPACTION_POINTER_SCHEME}sub/dir/hash`,
      `${COMPACTION_POINTER_SCHEME}`,
      `${COMPACTION_POINTER_SCHEME}ZZZZzzzz not hex!`,
      // Wrong length (63 hex chars — a traversal by truncation probe).
      `${COMPACTION_POINTER_SCHEME}${'a'.repeat(63)}`,
      // Foreign scheme.
      'file:///etc/passwd',
      'http://evil.example/hash',
      '',
    ];
    for (const pointer of badPointers) {
      assert.equal(
        await store.resolve(pointer),
        null,
        `malformed pointer must resolve to null: ${JSON.stringify(pointer)}`,
      );
    }
  });

  it('resolve returns null for a well-formed but unknown hash', async () => {
    const { uri } = tmpUri();
    const store = new CompactionStore(uri);
    const unknown = `${COMPACTION_POINTER_SCHEME}${'0'.repeat(64)}`;
    assert.equal(await store.resolve(unknown), null);
  });

  it('prune keeps the newest N blocks by mtime and drops the oldest', async () => {
    const { uri, dir } = tmpUri();
    const store = new CompactionStore(uri);

    // Five distinct blocks with strictly increasing mtimes (forced via
    // utimes so filesystem timestamp granularity cannot reorder them).
    const pointers: string[] = [];
    for (let i = 0; i < 5; i++) {
      pointers.push(await store.store(`block number ${i}`));
    }
    const compactionDir = path.join(dir, 'compaction');
    for (let i = 0; i < pointers.length; i++) {
      const hash = pointers[i]!.slice(COMPACTION_POINTER_SCHEME.length);
      const file = path.join(compactionDir, `${hash}.txt`);
      // 2020-01-01 + i days — deterministic ascending mtimes.
      const t = new Date(Date.UTC(2020, 0, 1 + i));
      await fs.utimes(file, t, t);
    }

    const removed = await store.prune(2);
    assert.equal(removed, 3, 'prune deletes 3 oldest of 5');

    // Oldest three are gone, newest two survive and still resolve.
    for (let i = 0; i < 3; i++) {
      assert.equal(await store.resolve(pointers[i]!), null, `block ${i} pruned`);
    }
    for (let i = 3; i < 5; i++) {
      assert.equal(
        await store.resolve(pointers[i]!),
        `block number ${i}`,
        `block ${i} survives`,
      );
    }
  });

  it('prune on a missing directory is a no-op returning 0', async () => {
    const { uri } = tmpUri();
    const store = new CompactionStore(uri);
    assert.equal(await store.prune(10), 0);
  });

  it('prune(0) removes every block', async () => {
    const { uri } = tmpUri();
    const store = new CompactionStore(uri);
    const p1 = await store.store('one');
    const p2 = await store.store('two');
    const removed = await store.prune(0);
    assert.equal(removed, 2);
    assert.equal(await store.resolve(p1), null);
    assert.equal(await store.resolve(p2), null);
  });
});
