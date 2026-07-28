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

// Test-only seam: tell `src/httpClient.ts` to delegate to
// `global.fetch` instead of using the native node:https/node:http
// transport. The existing 342 tests stub `global.fetch`; without this
// flag the proxy-aware client would bypass those stubs and hit the
// network. Production never sets this env var, so the native transport
// (which bypasses VS Code's `global.fetch()` interception) runs in the
// extension host. The httpClient integration test in
// `test/integration/httpClient.test.ts` unsets this per-suite when it
// needs to exercise the native path.
process.env.OLLAMA_HTTP_TEST_DELEGATE = '1';

const hooksUrl = pathToFileURL(
  fileURLToPath(import.meta.url).replace(/_loader\.mjs$/, '_hooks.mjs'),
).href;

register(hooksUrl, pathToFileURL(import.meta.url).href);