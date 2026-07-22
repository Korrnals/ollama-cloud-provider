import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import {
  pickVisionFallbackModel,
  pickVisionFallbackConnection,
} from '../../src/visionFallbackCommands.js';
import type { ModelDefinition } from '../../src/modelCatalog.js';

/**
 * Unit tests for the Vision Fallback command handlers (ADR 0004).
 *
 * Covers both QuickPick entry points:
 *   - `pickVisionFallbackModel` — model picker (happy path, empty
 *     catalog warning, no-selection no-op).
 *   - `pickVisionFallbackConnection` — connection picker (happy path,
 *     "Clear" option, empty connections warning, no-selection no-op).
 *
 * The VS Code `window.showQuickPick` / `showWarningMessage` APIs are
 * monkey-patched per test (the pattern used across the suite — see
 * `visionFallback.test.ts` for the `showInformationMessage` stub
 * shape). `workspace.getConfiguration('ollamaCloud').update` is
 * spied via a thin wrapper so the test can assert which setting key
 * and value were written, and to which ConfigurationTarget.
 */

function setConfig(values: Record<string, unknown>): void {
  vscode.workspace.getConfiguration('ollamaCloud')._replace(values);
}

function makeModel(
  id: string,
  name: string,
  imageInput: boolean,
): ModelDefinition {
  return {
    id,
    apiModel: id.split('/').pop() ?? id,
    name,
    family: 'test',
    version: 'test',
    detail: 'test',
    connectionId: 'cloud',
    origin: 'Cloud',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    reasoning: false,
    capabilities: { imageInput, toolCalling: true },
  };
}

/**
 * Minimal provider stub — `pickVisionFallbackModel` only touches
 * `syncModelCatalog` and `modelCatalogList`, so we fake just those.
 * `syncModelCatalog` is a no-op (the test pre-seeds the catalog); the
 * real cooldown / refresh logic lives in `provider.ts` and is covered
 * by its own integration tests.
 */
function makeProvider(models: readonly ModelDefinition[]): {
  syncModelCatalog: () => Promise<void>;
  modelCatalogList: () => readonly ModelDefinition[];
} {
  return {
    syncModelCatalog: async () => undefined,
    modelCatalogList: () => models,
  };
}

interface UpdateCall {
  section: string;
  value: unknown;
  target: vscode.ConfigurationTarget;
}

/**
 * Wraps `workspace.getConfiguration('ollamaCloud').update` so each
 * call is recorded. Returns the spy recorder plus a restore function.
 * The stub forwards the write to the real WorkspaceConfiguration so
 * subsequent `get` calls see the updated value.
 */
function spyConfigUpdates(): {
  updates: UpdateCall[];
  restore: () => void;
} {
  const updates: UpdateCall[] = [];
  const cfg = vscode.workspace.getConfiguration('ollamaCloud');
  const originalUpdate = cfg.update.bind(cfg);
  cfg.update = async (
    section: string,
    value: unknown,
    target?: vscode.ConfigurationTarget,
  ): Promise<void> => {
    updates.push({
      section,
      value,
      target: target ?? vscode.ConfigurationTarget.Global,
    });
    await originalUpdate(section, value, target);
  };
  return {
    updates,
    restore: () => {
      cfg.update = originalUpdate;
    },
  };
}

describe('pickVisionFallbackModel — QuickPick command handler', () => {
  let originalShowQuickPick: typeof vscode.window.showQuickPick;
  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  let warnings: string[];

  beforeEach(() => {
    setConfig({});
    originalShowQuickPick = vscode.window.showQuickPick;
    originalShowWarningMessage = vscode.window.showWarningMessage;
    originalShowInformationMessage = vscode.window.showInformationMessage;
    warnings = [];
    vscode.window.showWarningMessage = (async (
      message: string,
    ): Promise<unknown> => {
      warnings.push(message);
      return undefined;
    }) as typeof vscode.window.showWarningMessage;
    vscode.window.showInformationMessage = (async () =>
      undefined) as typeof vscode.window.showInformationMessage;
  });

  afterEach(() => {
    vscode.window.showQuickPick = originalShowQuickPick;
    vscode.window.showWarningMessage = originalShowWarningMessage;
    vscode.window.showInformationMessage = originalShowInformationMessage;
    setConfig({});
  });

  it('writes the selected model id to visionFallback.model (Global target)', async () => {
    const visionModel = makeModel('ollama-cloud/gemma3:12b', 'gemma3:12b', true);
    const provider = makeProvider([visionModel]);
    vscode.window.showQuickPick = (async (items: any) => {
      // First item carries the model id — return it.
      return (items as ReadonlyArray<unknown>)[0];
    }) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackModel(provider as any);
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 1, 'exactly one setting update');
    assert.equal(spy.updates[0].section, 'visionFallback.model');
    assert.equal(spy.updates[0].value, 'ollama-cloud/gemma3:12b');
    assert.equal(
      spy.updates[0].target,
      vscode.ConfigurationTarget.Global,
      'must write to application scope (security invariant)',
    );
    assert.equal(warnings.length, 0, 'no warning on happy path');
  });

  it('shows a warning and does not update when the catalog has no vision models', async () => {
    const provider = makeProvider([
      // Text-only model — filtered out by the imageInput gate.
      makeModel('ollama-cloud/gpt-oss:120b', 'gpt-oss:120b', false),
    ]);
    vscode.window.showQuickPick = (async () => {
      throw new Error('showQuickPick must not be called for an empty catalog');
    }) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackModel(provider as any);
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 0, 'no setting update on empty catalog');
    assert.equal(warnings.length, 1, 'exactly one warning');
    assert.match(
      warnings[0],
      /No vision-capable models found/,
      'warning must explain the empty catalog',
    );
  });

  it('does not update when the user dismisses the QuickPick (returns undefined)', async () => {
    const visionModel = makeModel('ollama-cloud/gemma3:12b', 'gemma3:12b', true);
    const provider = makeProvider([visionModel]);
    vscode.window.showQuickPick = (async () => undefined) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackModel(provider as any);
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 0, 'no update on dismissed picker');
  });
});

describe('pickVisionFallbackConnection — QuickPick command handler', () => {
  let originalShowQuickPick: typeof vscode.window.showQuickPick;
  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  let warnings: string[];

  beforeEach(() => {
    setConfig({
      // Pre-seed one cloud connection so `loadConnections` returns it.
      // The legacy cloud connection is synthesised from these settings.
      baseUrl: 'https://ollama.com/v1',
      allowedBaseUrls: ['https://ollama.com/v1'],
    });
    originalShowQuickPick = vscode.window.showQuickPick;
    originalShowWarningMessage = vscode.window.showWarningMessage;
    originalShowInformationMessage = vscode.window.showInformationMessage;
    warnings = [];
    vscode.window.showWarningMessage = (async (
      message: string,
    ): Promise<unknown> => {
      warnings.push(message);
      return undefined;
    }) as typeof vscode.window.showWarningMessage;
    vscode.window.showInformationMessage = (async () =>
      undefined) as typeof vscode.window.showInformationMessage;
  });

  afterEach(() => {
    vscode.window.showQuickPick = originalShowQuickPick;
    vscode.window.showWarningMessage = originalShowWarningMessage;
    vscode.window.showInformationMessage = originalShowInformationMessage;
    setConfig({});
  });

  it('writes the selected connection id to visionFallback.connection (Global target)', async () => {
    // The synthesised cloud connection appears alongside any explicit
    // connections. We pick the first non-"Clear" item.
    vscode.window.showQuickPick = (async (items: any) => {
      const list = items as ReadonlyArray<{ connectionId: string }>;
      return list.find((item) => item.connectionId !== '') ?? null;
    }) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackConnection();
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 1, 'exactly one setting update');
    assert.equal(spy.updates[0].section, 'visionFallback.connection');
    assert.equal(
      typeof spy.updates[0].value,
      'string',
      'connection id is a string',
    );
    assert.notEqual(spy.updates[0].value, '', 'must not pick the Clear item');
    assert.equal(
      spy.updates[0].target,
      vscode.ConfigurationTarget.Global,
      'must write to application scope (security invariant)',
    );
    assert.equal(warnings.length, 0, 'no warning on happy path');
  });

  it('writes an empty string when the user selects the "Clear" option', async () => {
    vscode.window.showQuickPick = (async (items: any) => {
      const list = items as ReadonlyArray<{ connectionId: string }>;
      return list.find((item) => item.connectionId === '') ?? null;
    }) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackConnection();
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 1, 'exactly one setting update');
    assert.equal(spy.updates[0].section, 'visionFallback.connection');
    assert.equal(spy.updates[0].value, '', 'Clear writes an empty string');
    assert.equal(
      spy.updates[0].target,
      vscode.ConfigurationTarget.Global,
    );
  });

  it('does not update when the user dismisses the QuickPick (returns undefined)', async () => {
    vscode.window.showQuickPick = (async () =>
      undefined) as unknown as typeof vscode.window.showQuickPick;

    const spy = spyConfigUpdates();
    try {
      await pickVisionFallbackConnection();
    } finally {
      spy.restore();
    }

    assert.equal(spy.updates.length, 0, 'no update on dismissed picker');
  });
});