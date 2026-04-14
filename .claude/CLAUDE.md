# @agent-score/gate

Express middleware for trust-gating requests using AgentScore. Peer dependency on `express`.

## Identity Model

The gate supports two identity types via the `extractIdentity` option (backwards compatible with `extractAddress`):

- **Wallet address** — `X-Wallet-Address` header (existing)
- **Operator token** — `X-Operator-Token` header (new)

Default behavior checks `X-Operator-Token` first, then `X-Wallet-Address`. The extracted identity is sent to AgentScore's `/v1/assess` endpoint as either `address` or `operator_token`.

New types: `AgentIdentity`, `CreateSessionOnMissing`, updated `DenialReason` (adds `missing_identity` code).

`createSessionOnMissing` option: when set and no identity found, creates a verification session and returns 403 with verify_url + poll instructions instead of a bare denial.

## Architecture

Single-package TypeScript library published to npm.

| File | Purpose |
|------|---------|
| `src/` | Source code |
| `tests/` | Vitest tests |
| `dist/` | Build output (tsup) |

## Tooling

- **Bun** — package manager. Use `bun install`, `bun run <script>`.
- **ESLint 9** — linting. `bun run lint`.
- **tsup** — builds CJS + ESM. `bun run build`.
- **Vitest** — tests. `bun run test`.
- **Lefthook** — git hooks. Pre-commit: lint. Pre-push: typecheck.

## Key Commands

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## Workflow

1. Create a branch
2. Make changes
3. Lefthook runs lint on commit, typecheck on push
4. Open a PR — CI runs automatically
5. Merge (squash)

## Rules

- **No silent refactors**
- **Never commit .env files or secrets**
- **Use PRs** — never push directly to main

## Releasing

1. Update `version` in `package.json`
2. Commit: `git commit -am "chore: bump to vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push && git push origin vX.Y.Z`

The publish workflow runs on `ubuntu-latest` (required for npm trusted publishing), builds, publishes to npm with provenance, and creates a GitHub Release.

npm scope is `@agent-score`. User-Agent header uses `@agentscore` (brand name).
