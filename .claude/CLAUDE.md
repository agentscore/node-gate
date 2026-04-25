# @agent-score/gate

Trust-gating middleware for Node.js web frameworks using AgentScore. Ships framework adapters for Hono, Express, Fastify, Next.js App Router, and Web Fetch (Cloudflare Workers / Deno / Bun / edge). Each adapter is imported from its own subpath (`@agent-score/gate/hono`, `/express`, `/fastify`, `/nextjs`, `/web`); framework packages are optional peer deps so consumers only install what they use. A shared `src/core.ts` holds the framework-agnostic assess/session/cache/captureWallet logic — adapters are thin wrappers that translate framework request/response types.

## Identity Model

The gate supports two identity types via the `extractIdentity` option (backwards compatible with `extractAddress`):

- **Wallet address** — `X-Wallet-Address` header
- **Operator token** — `X-Operator-Token` header

Default behavior checks `X-Operator-Token` first, then `X-Wallet-Address`. The extracted identity is sent to AgentScore's `/v1/assess` endpoint as either `address` or `operator_token`.

Types: `AgentIdentity`, `CreateSessionOnMissing`, `DenialReason` (with `missing_identity`, `token_expired`, `invalid_credential`, `wallet_signer_mismatch`, `wallet_auth_requires_wallet_signing` + the legacy codes — `token_expired` covers revoked + TTL-expired and carries an auto-session for recovery; `invalid_credential` covers tokens that never existed, no auto-session because the agent likely has another stored token to try), `VerifyWalletSignerMatchOptions`, `VerifyWalletSignerResult`. Address normalization is network-aware via `src/address.ts` (`normalizeAddress`): EVM lowercased, Solana base58 preserved verbatim — used for cache keys, wallet→operator resolves, and signer-match comparisons so cross-chain captured wallets resolve correctly.

`createSessionOnMissing` option: when set and no identity found, creates a verification session and returns 403 with verify_url + poll instructions instead of a bare denial. Two optional hooks let merchants bring per-request context: `getSessionOptions(ctx)` overrides `context`/`productName` per request (sync or async), and `onBeforeSession(ctx, session)` runs a side effect after the session mints with its return dict merged into `DenialReason.extra` (surfaces in the 403 body). Both receive the framework-native context (Hono `Context`, Express `Request`, etc.). Hook errors are swallowed with a log.

### Wallet-signer binding

Every adapter (Hono, Express, Fastify, Next.js, Web) exposes `verifyWalletSignerMatch(ctx, options?)`. Call AFTER the agent submits a payment credential, BEFORE settlement. Auto-extracts the signer from MPP (`Authorization: Payment`) or x402 (`payment-signature` / `x-payment`) headers; pass `options.signer` to override. Returns a `VerifyWalletSignerResult` with `kind: "pass" | "wallet_signer_mismatch" | "wallet_auth_requires_wallet_signing"`. Non-pass variants include `claimedOperator`, `actualSignerOperator`, `expectedSigner`, `actualSigner`, `linkedWallets` (same-operator sibling wallets that would also be accepted), plus `agentInstructions` — a JSON-encoded `{action, steps, user_message}` block merchants can spread directly into the 403 body. No-ops for operator-token requests or when both identity headers were sent. The shared body marshaller lives in `src/_response.ts`.

### Action copy on denials (agent_instructions convention)

Every gate-emitted denial carries an `agent_instructions` JSON string (`{action, steps, user_message}`) so agents see a concrete recovery path inside the response — no discovery-doc round trip. The canned copies live in `src/core.ts`:

- `missing_identity` → `probe_identity_then_session` (try wallet on signing rails, fall back to opc_..., fall back to session flow)
- `wallet_signer_mismatch` → `resign_or_switch_to_operator_token` (re-sign from `expectedSigner` / any `linkedWallets`, or drop the wallet header and use opc_...)
- `wallet_auth_requires_wallet_signing` → `switch_to_operator_token` (non-signing rail; drop wallet header)
- `token_expired` — the API emits an auto-minted session in the 401 body (verify_url + session_id + poll_secret + next_steps) and the gate forwards all of it into the DenialReason so the 403 body carries everything the agent needs to recover. Covers revoked + TTL-expired transparently.
- `invalid_credential` → `switch_token_or_restart_session` — token doesn't exist (typo, fabricated). Permanent: no auto-session is issued because the agent likely has another stored `opc_...` to try. If not, drop the header to bootstrap a fresh session via `createSessionOnMissing`. Distinct from `token_expired` so agents can correctly stop retrying instead of looping on a permanent state.

Silent fall-throughs in the gate's evaluate path (`} catch {}`) used to mask schema drift and unreachable-API issues for hours. Each catch now logs at warn level — same fall-through to `api_error`, just visible: `[gate] /v1/assess call failed`, `[gate] createSessionOnMissing path failed`, `[gate] /v1/assess 401 body parse failed`, `[gate] resolveWalletToOperator failed`.

Convention is consistent with the API's structured `next_steps` responses: same `{action, user_message}` shape, but the gate wraps it as a JSON string inside `agent_instructions`. `user_message` always lives INSIDE (never duplicated at top level).

### Cross-merchant agent memory

`DenialReason.agentMemory` carries the cross-merchant bootstrap hint (via `buildAgentMemoryHint(baseUrl)`). Emitted on `missing_identity` denials with no auto-session. The `_response.ts` marshaller serializes it as the `agent_memory` field in the 403 body.

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
