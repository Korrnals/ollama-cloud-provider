/**
 * Rework P2-1 (fix-then-ship, 2026-10-02) — per-turn pending
 * isolation regression pin for src/turnLedger.ts.
 *
 * The pre-extraction code kept `pendingImageHashes` as a fresh LOCAL
 * per `provideLanguageModelChatResponse` call; the first TurnLedger
 * extraction regressed it to ONE shared per-instance container reset
 * by beginTurn(). Under VS Code's PARALLEL provider calls
 * (multi-participant chats, background title generation) a concurrent
 * request's beginTurn() wiped the in-flight turn's pending set
 * (under-commit → raw re-send amplifier, the exact D-3 RCA class of
 * 2026-09-25) and the in-flight turn's commit committed the
 * concurrent request's not-yet-sent hashes (broken commit-on-success).
 *
 * The fix mints a call-local TurnHandle per request. This test pins
 * the isolation at the UNIT seam with two interleaved turns on ONE
 * ledger. Why unit and not integration: the sequential integration
 * suite can never produce the interleaving (its harness awaits one
 * request at a time), so the concurrent corruption class is only
 * observable by driving the ledger's turn lifecycle directly.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { TurnLedger } from '../../src/turnLedger.js';

function imagePart(bytes: Uint8Array): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(bytes, 'image/png');
}

function userMsg(
  content: Array<vscode.LanguageModelInputPart | unknown>,
): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content,
    name: undefined,
  } as vscode.LanguageModelChatRequestMessage;
}

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02]);

describe('TurnLedger — per-turn pending isolation (rework P2-1)', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      'visionHistory.mode': 'marker',
      'visionHistory.rawResendCap': 3,
    });
  });

  it('two interleaved turns on one ledger do not cross-contaminate (concurrent-request pin)', () => {
    const ledger = new TurnLedger();
    // Two concurrent requests each open their own turn — B begins
    // while A is still mid-flight. Under the regressed shared
    // container, B's beginTurn() already wiped A's pending here.
    const turnA = ledger.beginTurn();
    const turnB = ledger.beginTurn();

    // A's lifecycle records image A; B's records image B — each into
    // its OWN pending container, both first sends RAW.
    const outA = ledger.applyLifecycle([userMsg([imagePart(PNG_A)])], turnA);
    assert.ok(
      (outA[0]!.content[0] instanceof vscode.LanguageModelDataPart),
      'A first send raw',
    );
    const outB = ledger.applyLifecycle([userMsg([imagePart(PNG_B)])], turnB);
    assert.ok(
      (outB[0]!.content[0] instanceof vscode.LanguageModelDataPart),
      'B first send raw',
    );

    // A's stream resolves FIRST: commitTurn(turnA) must commit ONLY
    // image A. The regressed shape committed B's pending too (a
    // not-yet-sent hash recorded as sent — broken commit-on-success).
    ledger.commitTurn(turnA);

    // B's turn then fails: its leftover pending (image B) routes into
    // the failed-send counter of B's OWN handle — it must NOT have
    // been silently committed by A above.
    ledger.recordFailedTurn(turnB);

    // A later turn re-sends BOTH images. Image A (committed by A)
    // must be a marker; image B (failed on B, never committed) must
    // go RAW again — commit-on-success survived the interleaving.
    const turnC = ledger.beginTurn();
    const outC = ledger.applyLifecycle(
      [userMsg([imagePart(PNG_A), imagePart(PNG_B)])],
      turnC,
    );
    const parts = outC[0]!.content;
    assert.equal(parts.length, 2);
    assert.ok(
      parts[0] instanceof vscode.LanguageModelTextPart,
      'A (committed by the interleaved turn A) → marker',
    );
    assert.ok(
      parts[1] instanceof vscode.LanguageModelDataPart,
      'B (failed on turn B, never committed by A) → raw re-send',
    );
    // And the failed-send accounting landed on B only: one failed
    // attempt, below the cap — observable as the raw re-send above
    // (a capped hash would have degraded to the never-sent marker).
    const markerA = (parts[0] as vscode.LanguageModelTextPart).value;
    assert.ok(markerA.includes('[Image'), markerA);
  });
});
