import { createAgentScoreCore } from '../core';
import type { AgentIdentity, AgentScoreCore, AgentScoreCoreOptions, DenialReason } from '../core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const GATE_STATE_KEY = '__agentscoreGate';

interface GateState {
  core: AgentScoreCore;
  operatorToken?: string;
}

export interface AgentScoreGateOptions extends AgentScoreCoreOptions {
  /** Custom function to extract agent identity from a Fastify request. */
  extractIdentity?: (req: FastifyRequest) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: FastifyRequest, reply: FastifyReply, reason: DenialReason) => void | Promise<void>;
}

function defaultExtractIdentity(req: FastifyRequest): AgentIdentity | undefined {
  const token = req.headers['x-operator-token'];
  const addr = req.headers['x-wallet-address'];
  const identity: AgentIdentity = {};
  if (typeof token === 'string' && token.length > 0) identity.operatorToken = token;
  if (typeof addr === 'string' && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: FastifyRequest, reply: FastifyReply, reason: DenialReason): void {
  const body: Record<string, unknown> = { error: reason.code };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  if (reason.verify_url) body.verify_url = reason.verify_url;
  if (reason.session_id) body.session_id = reason.session_id;
  if (reason.poll_secret) body.poll_secret = reason.poll_secret;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  reply.code(403).send(body);
}

/**
 * Fastify plugin that gates requests using AgentScore. Register scoped to a prefix or
 * globally; assess data is attached to `request.agentscore` on allow.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { agentscoreGate } from '@agent-score/gate/fastify';
 *
 * const app = Fastify();
 * await app.register(agentscoreGate, {
 *   apiKey: 'as_live_...',
 *   requireKyc: true,
 *   minAge: 21,
 * });
 *
 * app.post('/purchase', async (req, reply) => {
 *   // req.agentscore has the assess data
 *   return { ok: true };
 * });
 * ```
 */
const agentscoreGatePlugin: FastifyPluginAsync<AgentScoreGateOptions> = async (fastify, options) => {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  const core = createAgentScoreCore(coreOptions);

  fastify.addHook('preHandler', async (request, reply) => {
    const identity = extractIdentity(request);
    (request as unknown as Record<string, unknown>)[GATE_STATE_KEY] = {
      core,
      operatorToken: identity?.operatorToken,
    } satisfies GateState;

    const outcome = await core.evaluate(identity);

    if (outcome.kind === 'allow') {
      if (outcome.data) (request as unknown as Record<string, unknown>).agentscore = outcome.data;
      return;
    }

    await onDenied(request, reply, outcome.reason);
  });
};

/**
 * Report a wallet that paid under the operator_token extracted by the gate on this request.
 * Fire-and-forget: no-ops silently if the gate didn't run, the request was wallet-authenticated,
 * or the API call fails.
 */
export async function captureWallet(
  request: FastifyRequest,
  options: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string },
): Promise<void> {
  const state = (request as unknown as Record<string, GateState | undefined>)[GATE_STATE_KEY];
  if (!state?.operatorToken) return;
  await state.core.captureWallet({
    operatorToken: state.operatorToken,
    walletAddress: options.walletAddress,
    network: options.network,
    idempotencyKey: options.idempotencyKey,
  });
}

// Escape Fastify's plugin encapsulation so the preHandler hook applies to routes
// registered at the parent scope (the common case: `app.register(agentscoreGate, ...)`
// followed by `app.get(...)` at the root). Equivalent to fastify-plugin without the
// extra dependency.
(agentscoreGatePlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export const agentscoreGate = agentscoreGatePlugin;
export default agentscoreGatePlugin;
