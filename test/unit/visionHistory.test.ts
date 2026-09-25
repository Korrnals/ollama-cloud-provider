/**
 * ADR 0013 lifecycle extension (2026-09-15) — tests for the native
 * vision image-resend lifecycle (src/visionHistory.ts).
 *
 * RCA (mnemos 1731bef7): repeat raw base64 re-sends (~2M chars per
 * screenshot per turn) inflated sessions to 2.46M chars and killed
 * subagent delegations. Lifecycle: first send RAW, repeats → marker.
 */

import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  applyVisionHistoryLifecycle,
  resolveVisionHistoryMode,
} from '../../src/visionHistory.js';

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

describe('visionHistory lifecycle (ADR 0013 extension)', () => {
  beforeEach(() => {
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      'visionHistory.mode': 'marker',
    });
  });

  it('first send of an image passes through RAW and is recorded into PENDING (commit-on-success)', () => {
    const sent = new Set<string>();
    const pending = new Set<string>();
    const out = applyVisionHistoryLifecycle([userMsg([imagePart(PNG_A)])], sent, pending);
    assert.equal(out.length, 1);
    const parts = out[0]!.content;
    assert.equal(parts.length, 1);
    assert.ok(parts[0] instanceof vscode.LanguageModelDataPart, 'raw image forwarded');
    assert.equal(pending.size, 1, 'hash recorded into PENDING');
    assert.equal(sent.size, 0, 'NOT committed into seen yet (commit-on-success)');
  });

  it('second send of the SAME image is replaced with a marker (~100 chars, not ~2M)', () => {
    const sent = new Set<string>();
    // Turn 1: raw + record into pending; the caller commits on success.
    const pending1 = new Set<string>();
    applyVisionHistoryLifecycle([userMsg([imagePart(PNG_A)])], sent, pending1);
    for (const h of pending1) sent.add(h);
    // Turn 2: the history re-sends the same image — marker instead.
    const out = applyVisionHistoryLifecycle([userMsg([imagePart(PNG_A)])], sent, new Set());
    const parts = out[0]!.content;
    assert.equal(parts.length, 1);
    assert.ok(parts[0] instanceof vscode.LanguageModelTextPart, 'marker is text');
    const marker = (parts[0] as vscode.LanguageModelTextPart).value;
    assert.ok(marker.includes('[Image'), marker);
    assert.ok(marker.length < 200, `marker must be short, got ${marker.length}`);
  });

  it('a NEW image pasted this turn is still sent raw (multi-image history)', () => {
    const sent = new Set<string>();
    const pending = new Set<string>();
    applyVisionHistoryLifecycle([userMsg([imagePart(PNG_A)])], sent, pending);
    for (const h of pending) sent.add(h);
    // History repeats A, user adds B — B must go raw, A must marker.
    const out = applyVisionHistoryLifecycle(
      [userMsg([imagePart(PNG_A), imagePart(PNG_B)])],
      sent,
      new Set(),
    );
    const parts = out[0]!.content;
    assert.equal(parts.length, 2);
    assert.ok(parts[0] instanceof vscode.LanguageModelTextPart, 'old image → marker');
    assert.ok(parts[1] instanceof vscode.LanguageModelDataPart, 'new image → raw');
  });

  it('does not touch messages without images and keeps turn structure', () => {
    const sent = new Set<string>();
    const msg = userMsg([new vscode.LanguageModelTextPart('plain question')]);
    const out = applyVisionHistoryLifecycle([msg], sent, new Set());
    assert.strictEqual(out[0], msg, 'untouched message shared by reference');
    assert.equal(sent.size, 0);
  });

  it('assistant-role image parts are left alone (native path only sends user images anyway)', () => {
    const seen = new Set<string>();
    const msg = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [imagePart(PNG_A)],
      name: undefined,
    } as vscode.LanguageModelChatRequestMessage;
    const out = applyVisionHistoryLifecycle([msg], seen, new Set());
    assert.strictEqual(out[0], msg);
    assert.equal(seen.size, 0, 'no hashes recorded from assistant parts');
  });

  it('resolveVisionHistoryMode: marker default, raw opt-out', () => {
    assert.equal(resolveVisionHistoryMode(), 'marker');
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      'visionHistory.mode': 'raw',
    });
    assert.equal(resolveVisionHistoryMode(), 'raw');
    // Unknown values clamp to the safe default.
    vscode.workspace.getConfiguration('ollamaCloud')._replace({
      'visionHistory.mode': 'banana',
    });
    assert.equal(resolveVisionHistoryMode(), 'marker');
  });
});
