/**
 * ESM loader registration entry point.
 *
 * Mocha loads this via `--import ./test/_loader.mjs`. We register
 * `_hooks.mjs` (which exports `resolve`/`load`) so the bare `vscode`
 * specifier resolves to `test/_vscode-stub.mjs`.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const hooksUrl = pathToFileURL(
  fileURLToPath(import.meta.url).replace(/_loader\.mjs$/, '_hooks.mjs'),
).href;

register(hooksUrl, pathToFileURL(import.meta.url).href);