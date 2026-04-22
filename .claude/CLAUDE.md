# @agent-score/gate

Trust-gating middleware for Node.js web frameworks using AgentScore. Ships framework adapters for Hono, Express, Fastify, Next.js App Router, and Web Fetch (Cloudflare Workers / Deno / Bun / edge). Each adapter is imported from its own subpath (`@agent-score/gate/hono`, `/express`, `/fastify`, `/nextjs`, `/web`); framework packages are optional peer deps so consumers only install what they use. A shared `src/core.ts` holds the framework-agnostic assess/session/cache/captureWallet logic — adapters are thin wrappers that translate framework request/response types.

## Identity Model

The gate supports two identity types via the `extractIdentity` option (backwards compatible with `extractAddress`):

- **Wallet address** — `X-Wallet-Address` header (existing)
- **Operator token** — `X-Operator-Token` header (new)

Default behavior checks `X-Operator-Token` first, then `X-Wallet-Address`. The extracted identity is sent to AgentScore's `/v1/assess` endpoint as either `address` or `operator_token`.

New types: `AgentIdentity`, `CreateSessionOnMissing`, updated `DenialReason` (adds `missing_identity` code).

`createSessionOnMissing` option: when set and no identity found, creates a verification session and returns 403 with verify_url + poll instructions instead of a bare denial. Two optional hooks let merchants bring per-request context: `getSessionOptions(ctx)` overrides `context`/`productName` per request (sync or async), and `onBeforeSession(ctx, session)` runs a side effect after the session mints with its return dict merged into `DenialReason.extra` (surfaces in the 403 body). Both receive the framework-native context (Hono `Context`, Express `Request`, etc.). Hook errors are swallowed with a log.

## Architecture

Single-package TypeScript library published to npm with subpath exports per adapter.

| File | Purpose |
|------|---------|
| `src/core.ts` | Framework-agnostic: TTLCache, identity extraction, `/v1/assess`, `/v1/sessions`, `captureWallet` |
| `src/adapters/express.ts` | Express middleware (`agentscoreGate` + `captureWallet`) |
| `src/adapters/hono.ts` | Hono middleware + `getAgentScoreData(c)` helper |
| `src/adapters/fastify.ts` | Fastify plugin (escapes encapsulation via `Symbol.for('skip-override')`) |
| `src/adapters/web.ts` | Web Fetch handler (`createAgentScoreGate` returns `GuardResult`); runtime-agnostic |
| `src/adapters/nextjs.ts` | `withAgentScoreGate` route-handler wrapper + `agentscoreMiddleware` for `middleware.ts` |
| `src/index.ts` | Type-only re-exports from core for shared typing |
| `tests/` | One file per adapter + `edge-cases.test.ts` (Vitest) |
| `dist/` | tsup output — `.js` CJS + `.mjs` ESM + `.d.ts` per entry |

### Captured wallets (TEC-189)

Every adapter exposes a `captureWallet(ctx, { walletAddress, network, idempotencyKey? })` helper.
The gate middleware stashes the extracted `operator_token` on the framework context during
gating; the helper reads it back and calls `POST /v1/credentials/wallets` fire-and-forget.
No-ops silently if the gate didn't run, the request was wallet-authenticated (no credential
to link), or the API call fails. `idempotencyKey` lets merchants pass a stable per-payment
key (PI id, tx hash) so agent retries of the same payment don't inflate transaction_count.

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
