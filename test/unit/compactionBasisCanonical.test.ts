import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { OllamaCloudChatProvider } from '../../src/provider.js';
import { sha256ShortHex } from '../../src/visionTwoPhase.js';
import type { OpenAICompatibleMessage } from '../../src/protocolTypes.js';

/**
 * v0220-t (CC review P3-3 / P4-1) — unit pins for the vision-state-
 * INDEPENDENT canonical form `renderCompactionBasis` produces for the
 * compaction projection key/basis. The function is private (an internal
 * render), so these tests reach it through a minimal typed cast — the
 * alternative (a full provider dispatch per assertion) would pin the
 * same property far more expensively and less precisely.
 */

/** Minimal context — the AuthManager wiring needs `secrets`; nothing here touches disk or network. */
function bareContext(): vscode.ExtensionContext {
  const secrets = new Map<string, string | undefined>();
  return {
    subscriptions: [],
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose: () => undefined }),
    },
    globalStorageUri: { toString: () => 'file:///unused', fsPath: '/unused' },
  } as unknown as vscode.ExtensionContext;
}

type BasisRenderer = (m: OpenAICompatibleMessage) => string;

function basisRenderer(): BasisRenderer {
  const provider = new OllamaCloudChatProvider(bareContext());
  // Private-method cast: the canonical form is an internal contract of
  // the provider's compaction wiring, pinned here directly.
  return (provider as unknown as { renderCompactionBasis: BasisRenderer })
    .renderCompactionBasis.bind(provider);
}

/** The `visionHistory.ts` marker for a committed repeat of a hash. */
function duplicateMarker(hash: string): string {
  return `[Image ${hash} — duplicate of an image already sent in this session; if you cannot find its analysis in the history above, ask the user to re-attach it]`;
}

describe('compaction basis canonical form (v0220-t P3-3 / P4-1)', () => {
  let render: BasisRenderer;
  before(() => {
    render = basisRenderer();
  });

  // v0220-t P3-3 — a zero-byte image hashes to the `no-image` sentinel,
  // and its marker form reads `[Image no-image — …]`. Before the
  // IMAGE_MARKER_RE alternation the marker was NOT stripped and the
  // sentinel NOT pushed, so the raw and marker forms of the SAME
  // zero-byte image canonicalized differently — the projection basis
  // flipped on the vision-state transition (the exact whiplash class
  // the canonical form exists to prevent).
  it('zero-byte image: raw and marker forms collapse to the SAME canonical fingerprint', () => {
    const raw: OpenAICompatibleMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this empty file' },
        // Zero-byte data URL — empty base64 payload, the shape the
        // vision lifecycle hashes to 'no-image'.
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' } },
      ],
    };
    const markerized: OpenAICompatibleMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this empty file' },
        { type: 'text', text: duplicateMarker('no-image') },
      ],
    };
    const rawBasis = render(raw);
    const markerBasis = render(markerized);
    assert.strictEqual(rawBasis, markerBasis);
    // Not vacuous: the collapsed form actually carries the sentinel
    // identity (marker stripped, not left in the text half).
    assert.ok(rawBasis.includes('no-image'), 'sentinel identity present');
    assert.ok(
      !markerBasis.includes('duplicate of an image'),
      'no-image marker stripped from the text half',
    );
  });

  // Sanity neighbor: the ordinary 16-hex path keeps collapsing too (the
  // alternation must not disturb the hex capture). The marker carries
  // the sha the vision lifecycle computed over the RAW bytes — mirrored
  // here via the same helper.
  it('regular image: raw and marker forms still collapse (16-hex capture intact)', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = sha256ShortHex(bytes);
    const raw: OpenAICompatibleMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` } },
      ],
    };
    const markerized: OpenAICompatibleMessage = {
      role: 'user',
      // The lifecycle substitutes the image PART with a marker text
      // part — no added separator (mirrors the real wire shape).
      content: [
        { type: 'text', text: 'look' },
        { type: 'text', text: duplicateMarker(hash) },
      ],
    };
    assert.strictEqual(render(raw), render(markerized));
  });
});
