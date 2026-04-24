import { createAgentScoreCore } from '../core';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCore,
  AgentScoreCoreOptions,
  AgentScoreData,
  CreateSessionOnMissing,
  DenialReason,
  VerifyWalletSignerResult,
} from '../core';
import type { Context, MiddlewareHandler } from 'hono';

const CONTEXT_KEY = 'agentscore';
const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
  walletAddress?: string;
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
  if (reason.poll_url) body.poll_url = reason.poll_url;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  if (reason.agent_memory) body.agent_memory = reason.agent_memory;
  // TEC-226 wallet-signer-match fields
  if (reason.claimed_operator) body.claimed_operator = reason.claimed_operator;
  if (reason.actual_signer_operator !== undefined) body.actual_signer_operator = reason.actual_signer_operator;
  if (reason.expected_signer) body.expected_signer = reason.expected_signer;
  if (reason.actual_signer) body.actual_signer = reason.actual_signer;
  if (reason.linked_wallets && reason.linked_wallets.length > 0) body.linked_wallets = reason.linked_wallets;
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
    c.set(GATE_STATE_KEY, {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState);

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

/**
 * Verify the payment signer resolves to the same operator as the claimed `X-Wallet-Address` (TEC-226).
 *
 * Call this AFTER the agent submits a payment credential, BEFORE settling. Returns:
 *
 *   - `pass` — signer matches (byte-equal or same-operator)
 *   - `wallet_signer_mismatch` — signer resolves to a different operator (or is unlinked)
 *   - `wallet_auth_requires_wallet_signing` — payment rail has no wallet signer (SPT/card);
 *     agent should switch to `X-Operator-Token`
 *
 * No-ops (returns `pass` with `claimedOperator: null`) when the request was operator-token
 * authenticated — signer-match only applies to wallet-auth.
 *
 * The helper auto-extracts the signer from MPP (`Authorization: Payment`) or x402
 * (`payment-signature` / `x-payment`) headers. Pass `options.signer` explicitly to override.
 *
 * ```ts
 * app.post('/purchase', async (c) => {
 *   const result = await verifyWalletSignerMatch(c);
 *   if (result.kind !== 'pass') return c.json({ error: result.kind, ...result }, 403);
 *   // ... proceed with settlement ...
 * });
 * ```
 */
export async function verifyWalletSignerMatch(
  c: Context,
  options?: { signer?: string | null; network?: 'evm' | 'solana' },
): Promise<VerifyWalletSignerResult> {
  const state = c.get(GATE_STATE_KEY) as GateState | undefined;
  if (!state?.walletAddress) {
    // Not a wallet-auth request — no check applies.
    return { kind: 'pass', claimedOperator: null, signerOperator: null };
  }

  const signer =
    options?.signer !== undefined
      ? options.signer
      : await extractPaymentSignerAddress(c.req.raw, readX402PaymentHeader(c.req.raw));

  return state.core.verifyWalletSignerMatch({
    claimedWallet: state.walletAddress,
    signer,
    network: options?.network,
  });
}
