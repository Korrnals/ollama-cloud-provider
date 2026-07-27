/**
 * ADR 0006 Phase 3 — structured reasoning type augmentation.
 *
 * `vscode.LanguageModelThinkingPart` ships in @types/vscode from VS
 * Code 1.103+. When the pinned @types/vscode in this repo predates
 * that release, the production code in `provider.ts` and
 * `visionFallback.ts` reaches the class via a `typeof` probe + cast
 * (no compile-time dependency). The tests, however, assert
 * `part instanceof vscode.LanguageModelThinkingPart` directly —
 * which requires the type to be visible to `tsc`.
 *
 * This ambient declaration merges with the `vscode` module so the
 * test assertions type-check. It mirrors the runtime stub in
 * `test/_vscode-stub.mjs` (which defines the class) and the real
 * VS Code 1.103+ API shape.
 */
declare module 'vscode' {
  export class LanguageModelThinkingPart {
    constructor(value: string);
    readonly value: string;
  }
}
