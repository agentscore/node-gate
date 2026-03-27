# @agent-score/gate

[![npm version](https://img.shields.io/npm/v/@agent-score/gate.svg)](https://www.npmjs.com/package/@agent-score/gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Express middleware for trust-gating requests using [AgentScore](https://agentscore.sh). Verify AI agent wallet reputation before allowing requests through.

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
app.use(agentscoreGate({ apiKey: "as_live_...", minGrade: "B" }));
```

### Route-Level

```typescript
const gate = agentscoreGate({ apiKey: "as_live_...", minScore: 35 });

app.post("/api/transfer", gate, (req, res) => {
  res.json({ ok: true, score: (req as any).agentscore });
});
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | --- | API key from [agentscore.sh](https://agentscore.sh) |
| `minGrade` | `"A" \| "B" \| "C" \| "D" \| "F"` | --- | Minimum acceptable grade |
| `minScore` | `number` | --- | Minimum score (0-100) |
| `requireVerifiedActivity` | `boolean` | --- | Require verified payment activity |
| `chain` | `string` | --- | Optional chain filter for scoring |
| `failOpen` | `boolean` | `false` | Allow requests when API is unreachable |
| `cacheSeconds` | `number` | `300` | Cache TTL for lookup results |
| `baseUrl` | `string` | `https://api.agentscore.sh` | API base URL |
| `extractAddress` | `(req) => string \| undefined` | Reads `x-wallet-address` header | Custom address extraction |
| `onDenied` | `(req, res, reason) => void` | Returns 403 JSON | Custom denial handler |

## Documentation

- [API Reference](https://docs.agentscore.sh)

## License

[MIT](LICENSE)
