import * as vscode from 'vscode';

const API_KEY_SECRET = 'ollamaCloud.apiKey';
const DEFAULT_BASE_URL = 'https://ollama.com/v1';

export class AuthManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    const secret = await this.context.secrets.get(API_KEY_SECRET);
    if (secret?.trim()) {
      return secret.trim();
    }

    const configured = vscode.workspace
      .getConfiguration('ollamaCloud')
      .get<string>('apiKey');
    if (configured?.trim()) {
      return configured.trim();
    }

    const fromEnv = process.env.OLLAMA_API_KEY;
    if (fromEnv?.trim()) {
      return fromEnv.trim();
    }

    return undefined;
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(API_KEY_SECRET, apiKey);
  }

  async deleteApiKey(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET);
  }

  async hasApiKey(): Promise<boolean> {
    const apiKey = await this.getApiKey();
    return typeof apiKey === 'string' && apiKey.length > 0;
  }

  async promptForApiKey(): Promise<boolean> {
    const existingApiKey = (await this.context.secrets.get(API_KEY_SECRET))?.trim();
    const value = await vscode.window.showInputBox({
      prompt: existingApiKey
        ? 'Update your Ollama Cloud API key'
        : 'Enter your Ollama Cloud API key',
      value: existingApiKey,
      valueSelection: existingApiKey ? [0, existingApiKey.length] : undefined,
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => {
        if (!input.trim()) {
          return 'API key cannot be empty.';
        }
        return undefined;
      },
    });

    if (!value) {
      return false;
    }

    await this.setApiKey(value.trim());
    vscode.window.showInformationMessage('Ollama Cloud API key saved.');
    return true;
  }

  getBaseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration('ollamaCloud')
      .get<string>('baseUrl');
    return normalizeBaseUrl(configured || DEFAULT_BASE_URL);
  }

  getRootUrl(): string {
    const baseUrl = this.getBaseUrl();

    try {
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/v1\/?$/, '') || '/';
      return url.toString().replace(/\/$/, '');
    } catch {
      return baseUrl.replace(/\/v1\/?$/, '');
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
