/**
 * Test-only stub for the `vscode` module.
 *
 * Production source imports `vscode` at runtime. The `@types/vscode`
 * package is types-only (its `main` field is empty), so importing it
 * under Node throws `ERR_MODULE_NOT_FOUND`. This stub provides the
 * minimal runtime surface the unit/integration tests exercise; the
 * ESM loader hook in `_loader.mjs` redirects the `vscode` specifier
 * here.
 *
 * The stub favours breadth over fidelity. Tests that need specific
 * behaviour swap individual methods with monkey-patches inside their
 * own `beforeEach`.
 */

export class EventEmitter {
  constructor() {
    // Use a closure-scoped Set so `event` can be detached from `this`
    // without losing the listener collection. The real VS Code
    // EventEmitter exposes `event` as a function property; consumers do
    // `emitter.event` and call it later, so the function must not rely on
    // `this` being the emitter instance at call time.
    const listeners = new Set();

    this.event = (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    };

    this.fire = (value) => {
      for (const listener of listeners) {
        listener(value);
      }
    };

    this.dispose = () => {
      listeners.clear();
    };
  }
}

export class OutputChannel {
  lines = [];

  appendLine(line) {
    this.lines.push(line);
  }

  show() {}

  dispose() {
    this.lines.length = 0;
  }
}

class SecretStorage {
  #map = new Map();
  #listeners = new Set();

  async store(key, value) {
    this.#map.set(key, value);
  }

  async get(key) {
    return this.#map.get(key);
  }

  async delete(key) {
    this.#map.delete(key);
    for (const listener of this.#listeners) {
      listener({ key });
    }
  }

  onDidChange(listener) {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }
}

class WorkspaceConfiguration {
  #store = {};

  get(section, defaultValue) {
    return section in this.#store ? this.#store[section] : defaultValue;
  }

  has(section) {
    return section in this.#store;
  }

  async update(section, value) {
    this.#store[section] = value;
  }

  inspect() {
    return undefined;
  }

  _replace(store) {
    this.#store = { ...store };
  }
}

const configSections = new Map();

export const window = {
  createOutputChannel: () => new OutputChannel(),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
};

export const workspace = {
  getConfiguration: (section) => {
    const key = section ?? '__global__';
    let cfg = configSections.get(key);
    if (!cfg) {
      cfg = new WorkspaceConfiguration();
      configSections.set(key, cfg);
    }
    return cfg;
  },
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
};

export const LanguageModelChatMessageRole = {
  System: 1,
  User: 2,
  Assistant: 3,
};

export class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

export class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

export class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

/**
 * Vision support stub — `vscode.LanguageModelDataPart`. Carries a
 * `mimeType` string and a `data` Uint8Array. The production code
 * checks `part.mimeType.toLowerCase().startsWith('image/')` and
 * `part.data instanceof Uint8Array`, so the stub mirrors that shape.
 *
 * The constructor signature matches the real `@types/vscode` class:
 * `(data: Uint8Array, mimeType: string)` — data first, mime second.
 * The static `image(data, mime)` factory is also provided so tests
 * can use either form.
 */
export class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }

  static image(data, mime) {
    return new LanguageModelDataPart(data, mime);
  }

  static json(value, mime) {
    return new LanguageModelDataPart(
      new TextEncoder().encode(JSON.stringify(value)),
      mime ?? 'application/json',
    );
  }

  static text(value, mime) {
    return new LanguageModelDataPart(
      new TextEncoder().encode(value),
      mime ?? 'text/plain',
    );
  }
}

export class CancellationToken {
  isCancellationRequested = false;
  _listeners = new Set();

  onCancellationRequested(listener) {
    this._listeners.add(listener);
    return {
      dispose: () => {
        this._listeners.delete(listener);
      },
    };
  }
}

export class CancellationTokenSource {
  token = new CancellationToken();
  cancel() {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.token.isCancellationRequested = true;
    for (const listener of this.token._listeners) {
      listener();
    }
  }
  dispose() {}
}

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
};

export const lm = {
  registerLanguageModelChatProvider: () => ({ dispose: () => undefined }),
};

export const ThemeIcon = {
  File: 'file',
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

export function createExtensionContext() {
  return {
    subscriptions: [],
    secrets: new SecretStorage(),
    extensionPath: '/test/extension-path',
    extensionUri: {
      toString: () => 'file:///test/extension-path',
      fsPath: '/test/extension-path',
    },
  };
}

/**
 * Test helper: replace a workspace configuration section's contents.
 * Returns the previous store so the caller can restore it.
 */
export function setWorkspaceConfig(section, values) {
  const cfg = workspace.getConfiguration(section);
  const previous = {};
  cfg._replace(previous);
  cfg._replace(values);
  return previous;
}

/**
 * Test helper: clear all cached configuration sections. Use in
 * `afterEach` to enforce test isolation.
 */
export function resetWorkspaceConfig() {
  configSections.clear();
}

export default {
  EventEmitter,
  OutputChannel,
  window,
  workspace,
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  CancellationToken,
  CancellationTokenSource,
  commands,
  lm,
  ThemeIcon,
  ConfigurationTarget,
  createExtensionContext,
  setWorkspaceConfig,
  resetWorkspaceConfig,
};