import { createAgentScoreCore } from '../core';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCore,
  AgentScoreCoreOptions,
  CreateSessionOnMissing,
  DenialReason,
  VerifyWalletSignerResult,
} from '../core';
import type { Request, Response, NextFunction } from 'express';

const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
  walletAddress?: string;
}

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity (wallet address and/or operator token). */
  extractIdentity?: (req: Request) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: Request, res: Response, reason: DenialReason) => void;
  /** Auto-create a verification session on missing identity. Hooks receive the Express `Request`. */
  createSessionOnMissing?: CreateSessionOnMissing<Request>;
}

function defaultExtractIdentity(req: Request): AgentIdentity | undefined {
  const token = req.headers['x-operator-token'];
  const addr = req.headers['x-wallet-address'];
  const identity: AgentIdentity = {};
  if (typeof token === 'string' && token.length > 0) identity.operatorToken = token;
  if (typeof addr === 'string' && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: Request, res: Response, reason: DenialReason): void {
  const body: Record<string, unknown> = { error: reason.code };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  if (reason.verify_url) body.verify_url = reason.verify_url;
  if (reason.session_id) body.session_id = reason.session_id;
  if (reason.poll_secret) body.poll_secret = reason.poll_secret;
  if (reason.poll_url) body.poll_url = reason.poll_url;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  if (reason.agent_memory) body.agent_memory = reason.agent_memory;
  if (reason.claimed_operator) body.claimed_operator = reason.claimed_operator;
  if (reason.actual_signer_operator !== undefined) body.actual_signer_operator = reason.actual_signer_operator;
  if (reason.expected_signer) body.expected_signer = reason.expected_signer;
  if (reason.actual_signer) body.actual_signer = reason.actual_signer;
  if (reason.linked_wallets && reason.linked_wallets.length > 0) body.linked_wallets = reason.linked_wallets;
  if (reason.extra) Object.assign(body, reason.extra);
  res.status(403).json(body);
}

export function agentscoreGate(options: AgentScoreGateOptions) {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  // Adapter's CreateSessionOnMissing<Request> is narrower than core's CreateSessionOnMissing<unknown>;
  // the cast is safe because core passes whatever ctx the adapter hands it to the hook.
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async function agentscoreMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const identity = extractIdentity(req);
    (req as unknown as Record<string, unknown>)[GATE_STATE_KEY] = {
      core,
      operatorToken: identity?.operatorToken,
      walletAddress: identity?.address,
    } satisfies GateState;

    const outcome = await core.evaluate(identity, req);

    if (outcome.kind === 'allow') {
      if (outcome.data) (req as unknown as Record<string, unknown>).agentscore = outcome.data;
      next();
      return;
    }

    onDenied(req, res, outcome.reason);
  };
}

/**
 * Report a wallet that paid under the operator_token extracted by the gate on this request.
 * Fire-and-forget: no-ops silently if the gate didn't run, the request was wallet-authenticated,
 * or the API call fails.
 */
export async function captureWallet(
  req: Request,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}

/**
 * Verify the payment signer resolves to the same operator as the claimed X-Wallet-Address.
 * See hono adapter for the full contract.
 *
 * Because Express `Request` isn't a web `Request`, the caller must pass both the original
 * Fetch-style `Request` (if available — e.g. middleware upstream) and/or the x402 header value.
 * Simpler pattern: pass `options.signer` directly after extracting it yourself.
 */
export async function verifyWalletSignerMatch(
  req: Request,
  options: { signer: string | null; network?: 'evm' | 'solana' },
): Promise<VerifyWalletSignerResult> {
  const state = (req as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  // Operator-token wins when both headers sent — signer-match must no-op on non-strict-wallet-auth.
  if (!state?.walletAddress || state.operatorToken) {
    return { kind: 'pass', claimedOperator: null, signerOperator: null };
  }
  return state.core.verifyWalletSignerMatch({
    claimedWallet: state.walletAddress,
    signer: options.signer,
    network: options.network,
  });
}

// Re-export shared signer helpers so Express consumers can extract from Fetch-style Requests
// if they have one on hand (e.g. edge proxies forwarding the raw Request).
export { extractPaymentSignerAddress, readX402PaymentHeader };
