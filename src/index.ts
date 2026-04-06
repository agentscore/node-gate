import { TTLCache } from './cache';
import type { Request, Response, NextFunction } from 'express';

declare const __VERSION__: string;

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
  /** Require KYC verification. */
  requireKyc?: boolean;
  /** Require the wallet to be clear of sanctions. */
  requireSanctionsClear?: boolean;
  /** Minimum wallet age in days. */
  minAge?: number;
  /** List of blocked jurisdictions. */
  blockedJurisdictions?: string[];
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
  /** Custom function to extract the wallet address from the request. */
  extractAddress?: (req: Request) => string | undefined;
  /** Custom handler invoked when a request is denied. */
  onDenied?: (req: Request, res: Response, reason: DenialReason) => void;
}

export interface DenialReason {
  code: 'wallet_not_trusted' | 'missing_wallet_address' | 'api_error' | 'payment_required';
  decision?: string;
  reasons?: string[];
}

export interface EvidenceSummary {
  metadata_kind: string | null;
  has_a2a_agent_card: boolean;
  website_url: string | null;
  website_reachable: boolean;
  website_mentions_mcp: boolean;
  website_mentions_x402: boolean;
  github_url: string | null;
  github_stars: number | null;
}

export interface AgentScoreChainEntry {
  chain: string;
  score: { value: number | null; grade: string | null; confidence?: number; dimensions?: Record<string, number> | null; scored_at: string | null; status: string; version: string };
  classification: { entity_type: string; confidence?: number; is_known?: boolean; is_known_erc8004_agent?: boolean; has_candidate_payment_activity?: boolean; has_verified_payment_activity?: boolean; reasons?: string[] };
  identity?: { ens_name: string | null; website_url: string | null; github_url: string | null };
  activity?: { total_candidate_transactions: number; total_verified_transactions: number; as_candidate_payer: number; as_candidate_payee: number; as_verified_payer: number; as_verified_payee: number; counterparties_count: number; active_days: number; active_months: number; first_candidate_tx_at: string | null; last_candidate_tx_at: string | null; first_verified_tx_at: string | null; last_verified_tx_at: string | null };
  evidence_summary?: EvidenceSummary;
}

export interface AgentScoreData {
  subject?: { address: string; chains: string[] };
  score?: {
    value: number | null;
    grade: string | null;
    scored_at: string | null;
    status: string;
    version: string;
  };
  chains?: AgentScoreChainEntry[];
  operator_score?: {
    score: number;
    grade: string;
    agent_count?: number;
    chains_active?: string[];
  };
  agents?: Array<{
    token_id: number;
    chain: string;
    name: string | null;
    score: number;
    grade: string;
  }>;
  reputation?: {
    feedback_count: number;
    client_count: number;
    trust_avg: number | null;
    uptime_avg: number | null;
    activity_avg: number | null;
    last_feedback_at: string | null;
  };
  decision: string | null;
  decision_reasons: string[];
  on_the_fly: boolean;
  updated_at: string | null;
  data_semantics: string;
  caveats: string[];
  operator_verification?: {
    level: string;
    operator_type: string | null;
    claimed_at: string | null;
    verified_at: string | null;
  };
  resolved_operator?: string;
  verify_url?: string;
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
    requireKyc,
    requireSanctionsClear,
    minAge,
    blockedJurisdictions,
    requireEntityType,
    failOpen = false,
    cacheSeconds = 300,
    baseUrl = 'https://api.agentscore.sh',
    chain: gateChain,
    extractAddress = defaultExtractAddress,
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

    const cacheKey = address.toLowerCase();

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
      const body: Record<string, unknown> = { address };
      if (gateChain) body.chain = gateChain;

      const policy: Record<string, unknown> = {};
      if (minGrade) policy.min_grade = minGrade;
      if (minScore != null) policy.min_score = minScore;
      if (requireVerifiedActivity != null) policy.require_verified_payment_activity = requireVerifiedActivity;
      if (requireKyc != null) policy.require_kyc = requireKyc;
      if (requireSanctionsClear != null) policy.require_sanctions_clear = requireSanctionsClear;
      if (minAge != null) policy.min_age = minAge;
      if (blockedJurisdictions != null) policy.blocked_jurisdictions = blockedJurisdictions;
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
