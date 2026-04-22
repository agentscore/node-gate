import { createAgentScoreCore } from '../core';
import type { AgentIdentity, AgentScoreCore, AgentScoreCoreOptions, CreateSessionOnMissing, DenialReason } from '../core';
import type { Request, Response, NextFunction } from 'express';

const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
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
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
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
