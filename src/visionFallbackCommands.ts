import * as vscode from 'vscode';
import type { OllamaCloudChatProvider } from './provider.js';
import { loadConnections } from './connections.js';
import { logger } from './logger.js';

/**
 * Command handlers for the Vision Fallback Pass-through (ADR 0004).
 *
 * Two commands:
 *   - `ollamaCloud.setVisionFallbackModel` — QuickPick from the
 *     vision-capable models in the catalog (`capabilities.imageInput
 *     === true`). Saves the selection to `visionFallback.model`.
 *   - `ollamaCloud.setVisionFallbackConnection` — QuickPick from the
 *     configured connections. Saves to `visionFallback.connection`.
 *
 * Both settings are `scope: application` (registered in package.json)
 * — the QuickPick writes to the application scope explicitly so a
 * workspace folder cannot override them (security invariant).
 */

/** Item shown in the model QuickPick — carries the model id. */
interface ModelQuickPickItem extends vscode.QuickPickItem {
  readonly modelId: string;
}

/** Item shown in the connection QuickPick — carries the connection id. */
interface ConnectionQuickPickItem extends vscode.QuickPickItem {
  readonly connectionId: string;
}

 /**
 * QuickPick from the catalog's vision-capable models. Refreshes the
 * catalog first (so newly added models appear), filters by
 * `capabilities.imageInput === true`, and saves the chosen model id
 * to `ollamaCloud.visionFallback.model`.
 */
export async function pickVisionFallbackModel(
  provider: OllamaCloudChatProvider,
): Promise<void> {
  // Refresh so the picker reflects the current catalog. The cooldown
  // in `syncModelCatalog` prevents hammering the endpoint.
  await provider.syncModelCatalog();

  const models = provider.modelCatalogList().filter(
    (model) => model.capabilities.imageInput === true,
  );

  if (models.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      'No vision-capable models found in the catalog. Refresh the model list and try again, or set a model id manually in settings.',
      'Sync Model List',
    );
    if (choice === 'Sync Model List') {
      await provider.syncModelCatalog(true);
    }
    return;
  }

  const items: ModelQuickPickItem[] = models.map((model) => ({
    label: `${model.origin}:${model.name}`,
    description: model.family,
    detail: `id: ${model.id}`,
    modelId: model.id,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Ollama Cloud: Vision Fallback Model',
    placeHolder: 'Select a vision-capable model for fallback',
  });

  if (!selected) {
    return;
  }

  await vscode.workspace
    .getConfiguration('ollamaCloud')
    .update(
      'visionFallback.model',
      selected.modelId,
      vscode.ConfigurationTarget.Global,
    );
  logger.info(`vision fallback model set to ${selected.modelId}`);
  void vscode.window.showInformationMessage(
    `Vision fallback model set to ${selected.label}.`,
  );
}

/**
 * QuickPick from the configured connections. Saves the chosen
 * connection id to `ollamaCloud.visionFallback.connection`.
 */
export async function pickVisionFallbackConnection(): Promise<void> {
  const connections = loadConnections();

  if (connections.length === 0) {
    void vscode.window.showWarningMessage(
      'No connections configured. Configure `ollamaCloud.connections` or the legacy `ollamaCloud.baseUrl` first.',
    );
    return;
  }

  const items: ConnectionQuickPickItem[] = connections.map((connection) => ({
    label: connection.label,
    description: connection.type,
    detail: connection.baseUrl,
    connectionId: connection.id,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Ollama Cloud: Vision Fallback Connection',
    placeHolder: 'Select a connection for vision fallback (optional — defaults to primary)',
  });

  if (!selected) {
    return;
  }

  await vscode.workspace
    .getConfiguration('ollamaCloud')
    .update(
      'visionFallback.connection',
      selected.connectionId,
      vscode.ConfigurationTarget.Global,
    );
  logger.info(`vision fallback connection set to ${selected.connectionId}`);
  void vscode.window.showInformationMessage(
    `Vision fallback connection set to ${selected.label}.`,
  );
}