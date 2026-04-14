import { TTLCache } from './cache';
import type { Request, Response, NextFunction } from 'express';

declare const __VERSION__: string;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export interface AgentIdentity {
  address?: string;
  operatorToken?: string;
}

export interface CreateSessionOnMissing {
  apiKey: string;
  baseUrl?: string;
}

export interface AgentScoreGateOptions {
  /** AgentScore API key. Required. */
  apiKey: string;
  /** Require KYC verification. */
  requireKyc?: boolean;
  /** Require operator to be clear of sanctions. */
  requireSanctionsClear?: boolean;
  /** Minimum operator age bracket (18 or 21). */
  minAge?: number;
  /** List of blocked jurisdictions (blocklist). */
  blockedJurisdictions?: string[];
  /** List of allowed jurisdictions (allowlist — only these pass). */
  allowedJurisdictions?: string[];
  /** Require a specific entity type. */
  requireEntityType?: string;
  /** If true, allow the request through when the API is unreachable. Defaults to false. */
  failOpen?: boolean;
  /** How long to cache results, in seconds. Defaults to 300. */
  cacheSeconds?: number;
  /** AgentScore API base URL. Defaults to "https://api.agentscore.sh". */
  baseUrl?: string;
  /** Optional chain to filter scoring to. */
  chain?: string;
  /** Custom function to extract agent identity (wallet address and/or operator token). */
  extractIdentity?: (req: Request) => AgentIdentity | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: Request, res: Response, reason: DenialReason) => void;
  /** When set and no identity is found, create a verification session instead of denying immediately. */
  createSessionOnMissing?: CreateSessionOnMissing;
}

export interface DenialReason {
  code: 'wallet_not_trusted' | 'missing_identity' | 'api_error' | 'payment_required' | 'identity_verification_required';
  decision?: string;
  reasons?: string[];
  verify_url?: string;
  session_id?: string;
  poll_secret?: string;
  agent_instructions?: string;
}

export interface AgentScoreData {
  decision: string | null;
  decision_reasons: string[];
  identity_method?: string;
  operator_verification?: {
    level: string;
    operator_type: string | null;
    verified_at: string | null;
  };
  resolved_operator?: string | null;
  verify_url?: string;
  policy_result?: {
    all_passed: boolean;
    checks: Array<{
      rule: string;
      passed: boolean;
      required?: unknown;
      actual?: unknown;
    }>;
  } | null;
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
    requireKyc,
    requireSanctionsClear,
    minAge,
    blockedJurisdictions,
    allowedJurisdictions,
    requireEntityType,
    failOpen = false,
    cacheSeconds = 300,
    baseUrl = 'https://api.agentscore.sh',
    chain: gateChain,
    extractIdentity = defaultExtractIdentity,
    onDenied = defaultOnDenied,
    createSessionOnMissing,
  } = options;

  const resolveIdentity = extractIdentity;

  const cache = new TTLCache<AssessResult>(cacheSeconds * 1000);

  return async function agentscoreMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // 1. Extract identity (wallet address and/or operator token)
    const identity = resolveIdentity(req);

    if (!identity) {
      if (failOpen) {
        next();
        return;
      }

      if (createSessionOnMissing) {
        try {
          let sessionBaseUrl = createSessionOnMissing.baseUrl ?? 'https://api.agentscore.sh';
          while (sessionBaseUrl.endsWith('/')) { sessionBaseUrl = sessionBaseUrl.slice(0, -1); }
          const sessionRes = await fetch(`${sessionBaseUrl}/v1/sessions`, {
            method: 'POST',
            headers: {
              'X-API-Key': createSessionOnMissing.apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': `agentscore-gate-node/${__VERSION__}`,
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(10_000),
          });

          if (sessionRes.ok) {
            const data = (await sessionRes.json()) as Record<string, unknown>;
            const reason: DenialReason = {
              code: 'identity_verification_required',
              verify_url: data.verify_url as string | undefined,
              session_id: data.session_id as string | undefined,
              poll_secret: data.poll_secret as string | undefined,
              agent_instructions: data.agent_instructions as string | undefined,
            };
            onDenied(req, res, reason);
            return;
          }
        } catch {
          // Fall through to default missing_identity denial
        }
      }

      const reason: DenialReason = { code: 'missing_identity' };
      onDenied(req, res, reason);
      return;
    }

    const cacheKey = identity.operatorToken?.toLowerCase() ?? identity.address?.toLowerCase() ?? '';

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
        verify_url: (cached.raw as Record<string, unknown> | undefined)?.verify_url as string | undefined,
      };
      onDenied(req, res, reason);
      return;
    }

    // 3. Call POST /v1/assess with policy
    try {
      const body: Record<string, unknown> = {};
      if (identity.address) body.address = identity.address;
      if (identity.operatorToken) body.operator_token = identity.operatorToken;
      if (gateChain) body.chain = gateChain;

      const policy: Record<string, unknown> = {};
      if (requireKyc != null) policy.require_kyc = requireKyc;
      if (requireSanctionsClear != null) policy.require_sanctions_clear = requireSanctionsClear;
      if (minAge != null) policy.min_age = minAge;
      if (blockedJurisdictions != null) policy.blocked_jurisdictions = blockedJurisdictions;
      if (allowedJurisdictions != null) policy.allowed_jurisdictions = allowedJurisdictions;
      if (requireEntityType != null) policy.require_entity_type = requireEntityType;
      if (Object.keys(policy).length > 0) body.policy = policy;

      const url = `${baseUrl}/v1/assess`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `agentscore-gate-node/${__VERSION__}`,
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
        verify_url: data.verify_url as string | undefined,
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
