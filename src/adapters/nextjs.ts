import { createAgentScoreGate } from './web';
import type { AgentScoreGateOptions as WebAgentScoreGateOptions } from './web';
import type { AgentScoreData, VerifyWalletSignerResult } from '../core';

export type AgentScoreGateOptions = WebAgentScoreGateOptions;

/**
 * Wrap a Next.js App Router route handler with the gate.
 *
 * Denied requests get a 403 JSON response; allowed requests reach `handler` with the
 * assess data on `gate.data`.
 *
 * ```ts
 * // app/api/purchase/route.ts
 * import { withAgentScoreGate } from '@agent-score/gate/nextjs';
 *
 * export const POST = withAgentScoreGate(
 *   { apiKey: process.env.AGENTSCORE_API_KEY!, requireKyc: true, minAge: 21 },
 *   async (req, { data }) => {
 *     // ... purchase logic
 *     return Response.json({ ok: true });
 *   },
 * );
 * ```
 *
 * Works with any Request type, including Next's `NextRequest`.
 */
export function withAgentScoreGate<TReq extends Request = Request, TCtx = unknown>(
  options: AgentScoreGateOptions,
  handler: (
    req: TReq,
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
): (req: TReq, ctx?: TCtx) => Promise<Response> {
  const guard = createAgentScoreGate(options);
  return async (req, ctx) => {
    const result = await guard(req as Request);
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

/**
 * Build a Next.js middleware function. Returns a `Response` when the request is denied;
 * returns `undefined` when the request should continue down the middleware chain.
 *
 * ```ts
 * // middleware.ts
 * import { NextResponse, type NextRequest } from 'next/server';
 * import { agentscoreMiddleware } from '@agent-score/gate/nextjs';
 *
 * const gate = agentscoreMiddleware({ apiKey: process.env.AGENTSCORE_API_KEY!, requireKyc: true });
 *
 * export async function middleware(req: NextRequest) {
 *   const denied = await gate(req);
 *   if (denied) return denied;
 *   return NextResponse.next();
 * }
 *
 * export const config = { matcher: '/api/purchase/:path*' };
 * ```
 */
export function agentscoreMiddleware(options: AgentScoreGateOptions): (req: Request) => Promise<Response | undefined> {
  const guard = createAgentScoreGate(options);
  return async (req: Request) => {
    const result = await guard(req);
    return result.allowed ? undefined : result.response;
  };
}
