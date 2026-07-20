# Contributing

## Development setup

```bash
git clone https://github.com/Korrnals/ollama-cloud-provider.git
cd ollama-cloud-provider
npm ci
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Workflow

This project follows trunk-based development with conventional commits.

1. Create a feature branch: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
2. Make changes. Run `npm run verify` (lint + compile + test) before committing.
3. Commit with conventional commit format:
   ```
   feat(provider): add health check command
   fix(logger): redact Bearer tokens before stringify
   docs(adr): document signing strategy
   ```
4. Open a pull request to `main`. CI must pass. At least one review required.
5. Squash-merge on approval.

See [ADR-0001](docs/adr/0001-security-goals.md) for the project's security goals and non-goals.

## Versioning

Semantic Versioning 2.0.0. During 0.x.x, breaking changes bump MINOR.

## Security changes

Any change to `src/ollamaClient.ts`, `src/provider.ts`, `src/auth.ts`, or `src/logger.ts` requires review by the security reviewer. Tag the PR with `security`.
