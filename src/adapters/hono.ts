import { createAgentScoreCore } from '../core';
import type { AgentIdentity, AgentScoreCore, AgentScoreCoreOptions, AgentScoreData, CreateSessionOnMissing, DenialReason } from '../core';
import type { Context, MiddlewareHandler } from 'hono';

const CONTEXT_KEY = 'agentscore';
const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
}

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity (wallet address and/or operator token). */
  extractIdentity?: (c: Context) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. Must return a Hono `Response`. */
  onDenied?: (c: Context, reason: DenialReason) => Response | Promise<Response>;
  /** Auto-create a verification session when no identity is present. The `getSessionOptions`
   *  and `onBeforeSession` hooks receive the Hono `Context` so they can read the request body,
   *  look up product metadata, and pre-create merchant-specific resume tokens. */
  createSessionOnMissing?: CreateSessionOnMissing<Context>;
}

function defaultExtractIdentity(c: Context): AgentIdentity | undefined {
  const token = c.req.header('x-operator-token');
  const addr = c.req.header('x-wallet-address');
  const identity: AgentIdentity = {};
  if (token && token.length > 0) identity.operatorToken = token;
  if (addr && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(c: Context, reason: DenialReason): Response {
  const body: Record<string, unknown> = { error: reason.code };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  if (reason.verify_url) body.verify_url = reason.verify_url;
  if (reason.session_id) body.session_id = reason.session_id;
  if (reason.poll_secret) body.poll_secret = reason.poll_secret;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  // Merchant-supplied fields from createSessionOnMissing.onBeforeSession.
  if (reason.extra) Object.assign(body, reason.extra);
  return c.json(body, 403);
}

/**
 * Hono middleware that gates requests using AgentScore trust and policy evaluation.
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { agentscoreGate } from '@agent-score/gate/hono';
 *
 * const app = new Hono();
 * app.use('/purchase', agentscoreGate({ apiKey: 'as_live_...', requireKyc: true, minAge: 21 }));
 * ```
 */
export function agentscoreGate(options: AgentScoreGateOptions): MiddlewareHandler {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async (c, next) => {
    const identity = extractIdentity(c);
    c.set(GATE_STATE_KEY, { core, operatorToken: identity?.operatorToken } satisfies GateState);

    const outcome = await core.evaluate(identity, c);

    if (outcome.kind === 'allow') {
      if (outcome.data) c.set(CONTEXT_KEY, outcome.data);
      await next();
      return;
    }

    return onDenied(c, outcome.reason);
  };
}

/**
 * Retrieve AgentScore assess data from a Hono `Context`. Returns `undefined` if the gate
 * did not run (e.g. in fail-open mode with a missing identity, or on a route without the
 * gate middleware).
 */
export function getAgentScoreData(c: Context): AgentScoreData | undefined {
  return c.get(CONTEXT_KEY) as AgentScoreData | undefined;
}

/**
 * Report a wallet that paid under the operator_token the gate extracted on this request.
 * Call this after a successful payment to build AgentScore's cross-merchant credential↔wallet
 * profile. No-ops silently if the gate never ran, the request was wallet-authenticated (no
 * operator_token to associate), or the API call fails — capture is fire-and-forget by design.
 *
 * ```ts
 * app.post('/purchase', async (c) => {
 *   const assess = getAgentScoreData(c);
 *   // ... run payment, recover signer wallet from the payload ...
 *   await captureWallet(c, { walletAddress: signer, network: 'evm' });
 *   return c.json({ ok: true });
 * });
 * ```
 */
export async function captureWallet(
  c: Context,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}
