import { createAgentScoreCore } from '../core';
import { denialReasonToBody } from '../_response';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../signer';
import type {
  AgentIdentity,
  AgentScoreCoreOptions,
  AgentScoreData,
  CreateSessionOnMissing,
  DenialReason,
  VerifyWalletSignerResult,
} from '../core';

export interface AgentScoreGateOptions extends Omit<AgentScoreCoreOptions, 'createSessionOnMissing'> {
  /** Custom function to extract agent identity from a Request. */
  extractIdentity?: (req: Request) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. Must return a Response. */
  onDenied?: (req: Request, reason: DenialReason) => Response | Promise<Response>;
  /** Auto-create a verification session on missing identity. Hooks receive the `Request`. */
  createSessionOnMissing?: CreateSessionOnMissing<Request>;
}

/**
 * Result of a gate check. `allowed: true` means the request passed; forward it to your
 * handler. `allowed: false` means it was denied; return `response` directly to the client.
 *
 * When the request was authenticated via `operator_token`, `captureWallet` is bound to the
 * identity and can be called after payment to report the signer wallet back to AgentScore.
 * When the request was wallet-authenticated (nothing to associate), `captureWallet` is
 * undefined. Always fire-and-forget.
 */
export type GuardResult =
  | {
      allowed: true;
      data?: AgentScoreData;
      captureWallet?: (opts: {
        walletAddress: string;
        network: 'evm' | 'solana';
        idempotencyKey?: string;
      }) => Promise<void>;
      /** Verify the payment signer matches the claimed X-Wallet-Address. Bound only when
       *  the request was wallet-authenticated. Pass `opts.signer` explicitly or omit to
       *  auto-extract from the original `Request`. */
      verifyWalletSignerMatch?: (opts?: {
        signer?: string | null;
        network?: 'evm' | 'solana';
      }) => Promise<VerifyWalletSignerResult>;
    }
  | { allowed: false; response: Response };

function defaultExtractIdentity(req: Request): AgentIdentity | undefined {
  const token = req.headers.get('x-operator-token');
  const addr = req.headers.get('x-wallet-address');
  const identity: AgentIdentity = {};
  if (token && token.length > 0) identity.operatorToken = token;
  if (addr && addr.length > 0) identity.address = addr;
  if (identity.operatorToken || identity.address) return identity;
  return undefined;
}

function defaultOnDenied(_req: Request, reason: DenialReason): Response {
  return new Response(JSON.stringify(denialReasonToBody(reason)), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Create a Web Fetch-compatible gate. Works with any runtime that speaks the standard
 * Request/Response API: Cloudflare Workers, Deno Deploy, Bun, Next.js App Router, etc.
 *
 * ```ts
 * const guard = createAgentScoreGate({ apiKey: 'as_live_...', requireKyc: true });
 *
 * export default {
 *   async fetch(req: Request) {
 *     const result = await guard(req);
 *     if (!result.allowed) return result.response;
 *     return handle(req, result.data);
 *   },
 * };
 * ```
 */
export function createAgentScoreGate(options: AgentScoreGateOptions): (req: Request) => Promise<GuardResult> {
  const { extractIdentity = defaultExtractIdentity, onDenied = defaultOnDenied, ...coreOptions } = options;
  const core = createAgentScoreCore(coreOptions as AgentScoreCoreOptions);

  return async (req: Request): Promise<GuardResult> => {
    const identity = extractIdentity(req);
    const outcome = await core.evaluate(identity, req);

    if (outcome.kind === 'allow') {
      const captureWallet = identity?.operatorToken
        ? (opts: { walletAddress: string; network: 'evm' | 'solana'; idempotencyKey?: string }) =>
            core.captureWallet({ operatorToken: identity.operatorToken!, ...opts })
        : undefined;
      // Section IV: token wins when both headers sent — bind helper only on strict wallet-auth.
      const verifyWalletSignerMatchBound = identity?.address && !identity?.operatorToken
        ? async (opts?: { signer?: string | null; network?: 'evm' | 'solana' }) => {
            const signer =
              opts?.signer !== undefined
                ? opts.signer
                : await extractPaymentSignerAddress(req, readX402PaymentHeader(req));
            return core.verifyWalletSignerMatch({
              claimedWallet: identity.address!,
              signer,
              network: opts?.network,
            });
          }
        : undefined;
      return {
        allowed: true,
        data: outcome.data,
        captureWallet,
        verifyWalletSignerMatch: verifyWalletSignerMatchBound,
      };
    }

    const response = await onDenied(req, outcome.reason);
    return { allowed: false, response };
  };
}

/**
 * Wrap a Web Fetch request handler with the gate. Denied requests are returned directly;
 * allowed requests are passed to `handler` along with the assess data.
 *
 * ```ts
 * export const POST = withAgentScoreGate(
 *   { apiKey: 'as_live_...', requireKyc: true },
 *   async (req, { data }) => Response.json({ ok: true }),
 * );
 * ```
 */
export function withAgentScoreGate<TCtx = unknown>(
  options: AgentScoreGateOptions,
  handler: (
    req: Request,
    gate: {
      data?: AgentScoreData;
      captureWallet?: (opts: {
        walletAddress: string;
        network: 'evm' | 'solana';
        idempotencyKey?: string;
      }) => Promise<void>;
      verifyWalletSignerMatch?: (opts?: {
        signer?: string | null;
        network?: 'evm' | 'solana';
      }) => Promise<VerifyWalletSignerResult>;
    },
    ctx?: TCtx,
  ) => Response | Promise<Response>,
): (req: Request, ctx?: TCtx) => Promise<Response> {
  const guard = createAgentScoreGate(options);
  return async (req, ctx) => {
    const result = await guard(req);
    if (!result.allowed) return result.response;
    return handler(
      req,
      {
        data: result.data,
        captureWallet: result.captureWallet,
        verifyWalletSignerMatch: result.verifyWalletSignerMatch,
      },
      ctx,
    );
  };
}

export { extractPaymentSignerAddress, readX402PaymentHeader };
