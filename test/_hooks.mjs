/**
 * ESM loader hooks — redirect bare `vscode` specifier to the test stub.
 *
 * This file is registered via `module.register()` in `_loader.mjs`.
 * Exporting `resolve` and `load` from a real module file (not a data
 * URL) avoids the quoting headaches of inline hook source.
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const stubUrl = pathToFileURL(
  fileURLToPath(import.meta.url).replace(/_hooks\.mjs$/, '_vscode-stub.mjs'),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return {
      shortCircuit: true,
      url: stubUrl,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}