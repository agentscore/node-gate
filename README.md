# @agent-score/gate

[![npm version](https://img.shields.io/npm/v/@agent-score/gate.svg)](https://www.npmjs.com/package/@agent-score/gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Express middleware for identity-gating requests using [AgentScore](https://agentscore.sh).

## Install

```bash
npm install @agent-score/gate
# or
bun add @agent-score/gate
```

## Quick Start

```typescript
import express from "express";
import { agentscoreGate } from "@agent-score/gate";

const app = express();

app.use(agentscoreGate({
  apiKey: "as_live_...",
  requireKyc: true,
  minAge: 21,
}));
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | --- | API key from [agentscore.sh](https://agentscore.sh) |
| `requireKyc` | `boolean` | --- | Require KYC verification |
| `requireSanctionsClear` | `boolean` | --- | Require clean sanctions status |
| `minAge` | `number` | --- | Minimum age bracket (18 or 21) |
| `blockedJurisdictions` | `string[]` | --- | ISO country codes to block |
| `allowedJurisdictions` | `string[]` | --- | ISO country codes to allow (only these pass) |
| `requireEntityType` | `string` | --- | Required operator type (`individual` or `entity`) |
| `chain` | `string` | --- | Optional chain filter |
| `failOpen` | `boolean` | `false` | Allow requests when API is unreachable |
| `cacheSeconds` | `number` | `300` | Cache TTL for results |
| `baseUrl` | `string` | `https://api.agentscore.sh` | API base URL |
| `extractIdentity` | `(req) => AgentIdentity` | Reads headers | Custom identity extraction |
| `createSessionOnMissing` | `CreateSessionOnMissing` | --- | Auto-create session when no identity |
| `onDenied` | `(req, res, reason) => void` | Returns 403 JSON | Custom denial handler |

## Identity

The gate checks `X-Operator-Token` first, then `X-Wallet-Address`:

```typescript
// Custom extraction
app.use(agentscoreGate({
  apiKey: "as_live_...",
  extractIdentity: (req) => ({
    operatorToken: req.headers["x-operator-token"] as string,
    address: req.headers["x-wallet-address"] as string,
  }),
}));
```

### Auto-Create Session

When no identity is found, create a verification session automatically:

```typescript
app.use(agentscoreGate({
  apiKey: "as_live_...",
  requireKyc: true,
  createSessionOnMissing: {
    apiKey: "as_live_...",
    context: "wine purchase",
    returnUrl: "https://example.com/callback",
    paymentMethods: ["stripe"],
    productName: "Cabernet Reserve 2021",
  },
}));
// 403 response includes: verify_url, session_id, poll_secret, agent_instructions
```

## Documentation

- [API Reference](https://docs.agentscore.sh)

## License

[MIT](LICENSE)
