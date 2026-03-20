# @agent-score/gate

[![npm version](https://img.shields.io/npm/v/@agent-score/gate.svg)](https://www.npmjs.com/package/@agent-score/gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Express middleware for trust-gating requests using [AgentScore](https://agentscore.sh). Verify AI agent wallet reputation before allowing requests through, built for the [x402](https://github.com/coinbase/x402) payment ecosystem and [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent registry.

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

// Gate all routes — require trusted wallet
app.use(agentscoreGate({ apiKey: "ask_...", minGrade: "B" }));
```

### Route-Level

```typescript
const gate = agentscoreGate({ apiKey: "ask_...", minGrade: "C" });

app.post("/api/transfer", gate, (req, res) => {
  res.json({ ok: true, score: (req as any).agentscore });
});
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `AGENTSCORE_API_KEY` env var | API key from [agentscore.sh](https://agentscore.sh) |
| `minGrade` | `"A" \| "B" \| "C" \| "D" \| "F"` | `"C"` | Minimum acceptable grade |
| `minTransactions` | `number` | — | Minimum on-chain transaction count |
| `failOpen` | `boolean` | `false` | Allow requests when API is unreachable |
| `cacheSeconds` | `number` | `300` | Cache TTL for lookup results |
| `baseUrl` | `string` | `https://api.agentscore.sh` | API base URL |
| `extractAddress` | `(req) => string \| undefined` | Reads `x-wallet-address` header | Custom address extraction |
| `onDenied` | `(req, res, reason) => void` | Returns 403 JSON | Custom denial handler |

## Documentation

- [API Reference](https://docs.agentscore.sh)
- [ERC-8004 Standard](https://eips.ethereum.org/EIPS/eip-8004)
- [x402 Protocol](https://github.com/coinbase/x402)

## License

[MIT](LICENSE)
