# @agent-score/gate

[![npm version](https://img.shields.io/npm/v/@agent-score/gate.svg)](https://www.npmjs.com/package/@agent-score/gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Trust-gating middleware for Node.js web frameworks using [AgentScore](https://agentscore.sh). Drop-in identity gate that handles KYC, sanctions, age, jurisdiction, and operator-credential policy — and automatically creates verification sessions when an agent lacks identity.

## Install

```bash
npm install @agent-score/gate
# or
bun add @agent-score/gate
```

## Adapters

Pick the subpath for your framework. Framework packages are optional peer deps — install only the one you use.

| Framework | Import | Peer dep |
|---|---|---|
| Hono | `@agent-score/gate/hono` | `hono` |
| Express | `@agent-score/gate/express` | `express` |
| Fastify | `@agent-score/gate/fastify` | `fastify` |
| Next.js | `@agent-score/gate/nextjs` | — |
| Web Fetch (Workers/Deno/Bun/edge) | `@agent-score/gate/web` | — |

## Quick Start

### Hono

```typescript
import { Hono } from "hono";
import { agentscoreGate, getAgentScoreData } from "@agent-score/gate/hono";

const app = new Hono();

app.use("/purchase", agentscoreGate({
  apiKey: "as_live_...",
  userAgent: "my-app/1.0.0",
  requireKyc: true,
  minAge: 21,
  allowedJurisdictions: ["US"],
  createSessionOnMissing: { apiKey: "as_live_...", context: "wine-purchase" },
}));

app.post("/purchase", async (c) => {
  const assess = getAgentScoreData(c); // present on allow
  return c.json({ ok: true });
});
```

Report an agent's signer wallet after a successful payment to build the cross-merchant credential↔wallet profile. Fire-and-forget; no-ops silently when the gate didn't run, the request was wallet-authenticated, or the API call fails.

```typescript
import { captureWallet } from "@agent-score/gate/hono";

app.post("/purchase", async (c) => {
  // ... run payment, recover signer wallet from the payload ...
  await captureWallet(c, {
    walletAddress: signer,
    network: "evm",
    idempotencyKey: paymentIntentId, // optional — retries of the same payment no-op
  });
  return c.json({ ok: true });
});
```

The same `captureWallet` helper is exported from `/express`, `/fastify`, `/web`, and `/nextjs` with framework-native signatures.

Verify the payment signer matches the claimed wallet. Call after the agent submits a payment credential, before settlement. Auto-extracts the signer from MPP `Authorization: Payment` or x402 `payment-signature` / `x-payment` headers; pass `options.signer` to override. No-ops on operator-token requests.

```typescript
import { verifyWalletSignerMatch } from "@agent-score/gate/hono";

app.post("/purchase", async (c) => {
  const match = await verifyWalletSignerMatch(c);
  if (match.kind !== "pass") {
    return c.json({ error: match.kind, ...match }, 403);
  }
  // ... settle payment ...
});
```

`match.kind` is `"pass" | "wallet_signer_mismatch" | "wallet_auth_requires_wallet_signing" | "api_error"`. Non-pass / non-api_error variants include `claimedOperator`, `actualSignerOperator`, `expectedSigner`, `actualSigner`, `linkedWallets`, and `agentInstructions` (JSON-encoded action copy merchants spread directly into the 403 body).

Exported from `/hono`, `/express`, `/fastify`. On `/nextjs` and `/web`, access via `gate.verifyWalletSignerMatch?.()` on the handler's gate argument (request-scoped adapters bind helpers into the handler callback rather than exposing module-level functions).

### Express

```typescript
import express from "express";
import { agentscoreGate } from "@agent-score/gate/express";

const app = express();
app.use("/purchase", agentscoreGate({ apiKey: "as_live_...", requireKyc: true }));
```

### Fastify

```typescript
import Fastify from "fastify";
import { agentscoreGate } from "@agent-score/gate/fastify";

const app = Fastify();
await app.register(agentscoreGate, { apiKey: "as_live_...", requireKyc: true });

app.post("/purchase", async (req) => {
  // req.agentscore has the assess data on allow
  return { ok: true };
});
```

### Next.js — App Router route handler

```typescript
// app/api/purchase/route.ts
import { withAgentScoreGate } from "@agent-score/gate/nextjs";

export const POST = withAgentScoreGate(
  { apiKey: process.env.AGENTSCORE_API_KEY!, requireKyc: true },
  async (req, { data }) => {
    // data is the assess response
    return Response.json({ ok: true });
  },
);
```

### Next.js — middleware.ts

```typescript
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { agentscoreMiddleware } from "@agent-score/gate/nextjs";

const gate = agentscoreMiddleware({
  apiKey: process.env.AGENTSCORE_API_KEY!,
  requireKyc: true,
});

export async function middleware(req: NextRequest) {
  const denied = await gate(req);
  if (denied) return denied;
  return NextResponse.next();
}

export const config = { matcher: "/api/purchase/:path*" };
```

> **Note:** `captureWallet` is not available from `agentscoreMiddleware` because Next.js edge middleware does not share state with route handlers — they're separate executions. If you need to capture an agent's wallet after payment, use `withAgentScoreGate` on the route handler instead. Using both middleware.ts AND `withAgentScoreGate` on the same route would run the gate twice.

### Web Fetch (Cloudflare Workers, Deno, Bun, edge)

```typescript
import { createAgentScoreGate } from "@agent-score/gate/web";

const guard = createAgentScoreGate({ apiKey: "as_live_...", requireKyc: true });

export default {
  async fetch(req: Request) {
    const result = await guard(req);
    if (!result.allowed) return result.response;
    // result.data is the assess response
    return new Response("ok");
  },
};
```

## Options

All adapters share the same core options:

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | --- | API key from [agentscore.sh](https://agentscore.sh) |
| `requireKyc` | `boolean` | --- | Require KYC verification |
| `requireSanctionsClear` | `boolean` | --- | Require clean sanctions status |
| `minAge` | `number` | --- | Minimum age bracket (18 or 21) |
| `blockedJurisdictions` | `string[]` | --- | ISO country codes to block |
| `allowedJurisdictions` | `string[]` | --- | ISO country codes to allow (only these pass) |
| `chain` | `string` | --- | Optional chain filter |
| `failOpen` | `boolean` | `false` | Allow requests when API is unreachable |
| `cacheSeconds` | `number` | `300` | Cache TTL for results |
| `baseUrl` | `string` | `https://api.agentscore.sh` | API base URL |
| `userAgent` | `string` | --- | Prepended to the default `User-Agent` as `"{userAgent} (@agent-score/gate@{version})"`. Use to attribute API calls to your app. |
| `extractIdentity` | framework-specific | Reads headers | Custom identity extraction |
| `createSessionOnMissing` | `CreateSessionOnMissing` | --- | Auto-create verification session when identity is missing |
| `onDenied` | framework-specific | Returns 403 JSON | Custom denial handler |

## Identity

By default, each adapter checks `X-Operator-Token` first, then `X-Wallet-Address`. You can override with a custom `extractIdentity` that matches your framework's request shape.

## Denial bodies

Every 403 body carries `agent_instructions` — a JSON-encoded `{action, steps, user_message}` block so agents act from the response itself, no discovery-doc round trip. Actions:

| Code | `action` |
|---|---|
| `missing_identity` | `probe_identity_then_session` (try wallet on signing rails → stored opc_... → session flow) |
| `wallet_signer_mismatch` | `resign_or_switch_to_operator_token` (body also carries `claimed_operator`, `actual_signer_operator`, `expected_signer`, `actual_signer`, `linked_wallets`) |
| `wallet_auth_requires_wallet_signing` | `switch_to_operator_token` |
| `token_expired` | `mint_new_credential` |
| `token_revoked` | `contact_support` |

## Auto-Create Session

When no identity is found and `createSessionOnMissing` is set, the gate creates a verification session and returns a 403 with `verify_url`, `session_id`, `poll_secret`, `poll_url`, `agent_instructions`, and `agent_memory` (cross-merchant pattern hint). The agent polls `poll_url` with `X-Poll-Secret: {poll_secret}` to completion, then retries with the resulting `operator_token`.

```typescript
createSessionOnMissing: {
  apiKey: "as_live_...",
  context: "wine purchase",
  productName: "Cabernet Reserve 2021",
}
```

### Per-request hooks

For per-wine (or per-user-tier, or per-anything) session context, use the `getSessionOptions` callback. It receives the framework context so you can inspect the request body or state a prior middleware stashed:

```typescript
createSessionOnMissing: {
  apiKey: "as_live_...",
  getSessionOptions: async (c) => {
    const body = await c.req.json();
    const product = await lookupProduct(body.product_id);
    return { productName: product.name };
  },
  // Optional side-effect hook — create a pending row in your DB, return the id
  // so the 403 body carries it back to the agent for resume.
  onBeforeSession: async (c, session) => {
    const orderId = await createPendingOrder(await c.req.json(), session.session_id);
    return { order_id: orderId }; // merged into DenialReason.extra
  },
}
```

## Documentation

- [API Reference](https://docs.agentscore.sh)

## License

[MIT](LICENSE)
