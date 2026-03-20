import { TTLCache } from './cache';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface AgentScoreGateOptions {
  /** AgentScore API key. Required. */
  apiKey: string;
  /** Minimum acceptable grade for the policy. */
  minGrade?: Grade;
  /** Minimum score for the policy (0-100). */
  minScore?: number;
  /** Require verified payment activity. */
  requireVerifiedActivity?: boolean;
  /** If true, allow the request through when the API is unreachable. Defaults to false. */
  failOpen?: boolean;
  /** How long to cache results, in seconds. Defaults to 300. */
  cacheSeconds?: number;
  /** AgentScore API base URL. Defaults to "https://api.agentscore.sh". */
  baseUrl?: string;
  /** Custom function to extract the wallet address from the request. */
  extractAddress?: (req: Request) => string | undefined;
  /** Custom function to extract the chain from the request. */
  extractChain?: (req: Request) => string | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: Request, res: Response, reason: DenialReason) => void;
}

export interface DenialReason {
  code: 'wallet_not_trusted' | 'missing_wallet_address' | 'api_error' | 'payment_required';
  decision?: string;
  reasons?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AssessResult {
  allow: boolean;
  decision?: string;
  reasons?: string[];
  raw?: unknown;
}

function defaultExtractAddress(req: Request): string | undefined {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.length > 0) return header;
  return undefined;
}

function defaultOnDenied(_req: Request, res: Response, reason: DenialReason): void {
  const body: Record<string, unknown> = { error: reason.code };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  res.status(403).json(body);
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function agentscoreGate(options: AgentScoreGateOptions) {
  if (!options.apiKey) {
    throw new Error('AgentScore API key is required. Get one at https://agentscore.sh/sign-up');
  }

  const {
    apiKey,
    minGrade,
    minScore,
    requireVerifiedActivity,
    failOpen = false,
    cacheSeconds = 300,
    baseUrl = 'https://api.agentscore.sh',
    extractAddress = defaultExtractAddress,
    extractChain,
    onDenied = defaultOnDenied,
  } = options;

  const cache = new TTLCache<AssessResult>(cacheSeconds * 1000);

  return async function agentscoreMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // 1. Extract wallet address
    const address = extractAddress(req);

    if (!address) {
      const reason: DenialReason = { code: 'missing_wallet_address' };
      if (failOpen) {
        next();
        return;
      }
      onDenied(req, res, reason);
      return;
    }

    const chain = extractChain?.(req) ?? 'base';
    const cacheKey = `${chain}:${address.toLowerCase()}`;

    // 2. Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.allow) {
        (req as unknown as Record<string, unknown>).agentscore = cached.raw;
        next();
        return;
      }
      const reason: DenialReason = {
        code: 'wallet_not_trusted',
        decision: cached.decision,
        reasons: cached.reasons,
      };
      onDenied(req, res, reason);
      return;
    }

    // 3. Call POST /v1/assess with policy
    try {
      const body: Record<string, unknown> = { address, chain };

      const policy: Record<string, unknown> = {};
      if (minGrade) policy.min_grade = minGrade;
      if (minScore != null) policy.min_score = minScore;
      if (requireVerifiedActivity != null) policy.require_verified_payment_activity = requireVerifiedActivity;
      if (Object.keys(policy).length > 0) body.policy = policy;

      const url = `${baseUrl}/v1/assess`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': '@agent-score/gate/1.0.0',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 402) {
        // API key is not paid tier
        if (failOpen) {
          next();
          return;
        }
        const reason: DenialReason = { code: 'payment_required' };
        onDenied(req, res, reason);
        return;
      }

      if (!response.ok) {
        throw new Error(`AgentScore API returned ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const decision = data.decision as string | null | undefined;
      const decisionReasons = (data.decision_reasons as string[]) ?? [];
      const allow = decision === 'allow' || decision == null;

      const result: AssessResult = { allow, decision: decision ?? undefined, reasons: decisionReasons, raw: data };
      cache.set(cacheKey, result);

      if (allow) {
        (req as unknown as Record<string, unknown>).agentscore = data;
        next();
        return;
      }

      const reason: DenialReason = {
        code: 'wallet_not_trusted',
        decision: decision ?? undefined,
        reasons: decisionReasons,
      };
      onDenied(req, res, reason);
    } catch {
      if (failOpen) {
        next();
        return;
      }
      const reason: DenialReason = { code: 'api_error' };
      onDenied(req, res, reason);
    }
  };
}
