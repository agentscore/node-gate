import { TTLCache } from './cache';

// Character-based trim avoids a CodeQL polynomial-redos false positive on
// `/\/+$/` patterns that report library-input strings.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

declare const __VERSION__: string;

// ---------------------------------------------------------------------------
// Public types (framework-agnostic)
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  address?: string;
  operatorToken?: string;
}

/**
 * Session metadata returned from `POST /v1/sessions`. Surfaced to the `onBeforeSession`
 * hook so merchants can correlate an AgentScore session with their own resume token
 * (e.g. a pending-order id).
 */
export interface SessionMetadata {
  session_id: string;
  verify_url: string;
  poll_secret: string;
  expires_at?: string;
}

/**
 * Configuration for auto-creating a verification session when no identity is present.
 *
 * The static `context` / `productName` options are sent on every session request. For
 * per-request context (e.g. the specific product the agent was trying to buy), pass
 * a `getSessionOptions` callback that returns dynamic values; its return is merged
 * over the static defaults.
 *
 * `onBeforeSession` is a side-effect hook that runs after the session is minted but
 * before the 403 is built. Use it to pre-create a reservation/draft/pending-order
 * row in your DB so agents can resume via a merchant-specific id. Return value is
 * merged into `DenialReason.extra`, so it surfaces in both the default 403 body and
 * in a custom `onDenied` handler.
 */
export interface CreateSessionOnMissing<TCtx = unknown> {
  apiKey: string;
  baseUrl?: string;
  context?: string;
  productName?: string;
  /** Per-request override of `context` / `productName`. Invoked with the framework context. */
  getSessionOptions?: (ctx: TCtx) => Promise<{ context?: string; productName?: string }>
                                  |          { context?: string; productName?: string };
  /** Side-effect hook that runs after the session is minted. Return value is merged
   *  into `DenialReason.extra` so custom `onDenied` handlers can include merchant-specific
   *  fields (e.g. `order_id`) in the 403 response. Hook errors are logged and swallowed —
   *  a failing side effect should not block the 403 from reaching the agent. */
  onBeforeSession?: (ctx: TCtx, session: SessionMetadata) => Promise<Record<string, unknown>>
                                                          |          Record<string, unknown>;
}

export interface AgentScoreCoreOptions {
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
  /** If true, allow the request through when the API is unreachable. Defaults to false. */
  failOpen?: boolean;
  /** How long to cache results, in seconds. Defaults to 300. */
  cacheSeconds?: number;
  /** AgentScore API base URL. Defaults to "https://api.agentscore.sh". */
  baseUrl?: string;
  /** Optional chain to filter scoring to. */
  chain?: string;
  /** Prepended to the default User-Agent as `"{userAgent} (@agent-score/gate@{version})"`. Use to attribute API calls to your app. */
  userAgent?: string;
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
  /** Full assess response when the denial came from `/v1/assess`. Lets consumers access fields
   *  not promoted to first-class DenialReason properties (e.g., `policy_result`). Undefined for
   *  denials that did not originate from an assess call (missing_identity, api_error,
   *  payment_required, identity_verification_required). */
  data?: AgentScoreData;
  /** Extra fields returned from the `createSessionOnMissing.onBeforeSession` hook. Merged
   *  into the default 403 body; custom `onDenied` handlers can spread these into their own
   *  response shape (e.g. to include a merchant-minted `order_id`). */
  extra?: Record<string, unknown>;
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

/**
 * Outcome from `AgentScoreCore.evaluate()`. Adapters map this to framework-specific responses.
 *
 * - `{ kind: 'allow', data }` — the request passed the policy. `data` is present on a normal
 *   allow; `undefined` when fail-open short-circuited (identity missing, API unreachable,
 *   timeout, or 402 paid-tier required).
 * - `{ kind: 'deny', reason }` — the request was denied. Adapters should render a 403 with the
 *   reason, or invoke the caller's custom denial handler.
 */
export type EvaluateOutcome =
  | { kind: 'allow'; data?: AgentScoreData }
  | { kind: 'deny'; reason: DenialReason };

export interface CaptureWalletOptions {
  /** Operator credential (`opc_...`) that the agent authenticated with. */
  operatorToken: string;
  /** Signer wallet recovered from the payment payload. */
  walletAddress: string;
  /** Key-derivation family — `"evm"` for any EVM chain, `"solana"` for Solana. */
  network: 'evm' | 'solana';
  /** Optional stable key for the logical payment (e.g., payment intent id, tx hash). When the
   *  same key is seen again for the same (credential, wallet, network), the server no-ops —
   *  prevents agent retries from inflating transaction_count. */
  idempotencyKey?: string;
}

export interface AgentScoreCore {
  /**
   * Evaluate the request's identity against the configured policy.
   * @param identity - extracted identity (wallet address and/or operator token)
   * @param ctx - optional framework-specific context (Hono c, Express req, etc.) passed
   *   through to `createSessionOnMissing` hooks. Opaque to core.
   */
  evaluate(identity: AgentIdentity | undefined, ctx?: unknown): Promise<EvaluateOutcome>;
  /** Report a wallet seen paying under an operator credential. Fire-and-forget; silently
   *  swallows non-fatal errors because capture is informational, not on the critical path. */
  captureWallet(options: CaptureWalletOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AssessResult {
  allow: boolean;
  decision?: string;
  reasons?: string[];
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

export function createAgentScoreCore(options: AgentScoreCoreOptions): AgentScoreCore {
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
    failOpen = false,
    cacheSeconds = 300,
    baseUrl: rawBaseUrl = 'https://api.agentscore.sh',
    chain: gateChain,
    userAgent,
    createSessionOnMissing,
  } = options;

  const baseUrl = stripTrailingSlashes(rawBaseUrl);

  const defaultUa = `@agent-score/gate@${__VERSION__}`;
  const userAgentHeader = userAgent ? `${userAgent} (${defaultUa})` : defaultUa;

  const API_TIMEOUT_MS = 10_000;

  const cache = new TTLCache<AssessResult>(cacheSeconds * 1000);

  async function evaluate(identity: AgentIdentity | undefined, ctx?: unknown): Promise<EvaluateOutcome> {
    // Treat "returned identity object with no usable fields" the same as "no identity at all" —
    // otherwise a misbehaving custom extractIdentity would send an empty body to /v1/assess.
    if (!identity || (!identity.address && !identity.operatorToken)) {
      if (failOpen) return { kind: 'allow' };

      if (createSessionOnMissing) {
        try {
          // Start with static context/productName; let getSessionOptions override per-request.
          const sessionBody: { context?: string; product_name?: string } = {};
          if (createSessionOnMissing.context != null) sessionBody.context = createSessionOnMissing.context;
          if (createSessionOnMissing.productName != null) sessionBody.product_name = createSessionOnMissing.productName;

          if (createSessionOnMissing.getSessionOptions && ctx !== undefined) {
            try {
              const dynamic = await createSessionOnMissing.getSessionOptions(ctx);
              if (dynamic?.context != null) sessionBody.context = dynamic.context;
              if (dynamic?.productName != null) sessionBody.product_name = dynamic.productName;
            } catch (err) {
              console.warn('[gate] createSessionOnMissing.getSessionOptions hook failed:', err instanceof Error ? err.message : err);
            }
          }

          const sessionBaseUrl = stripTrailingSlashes(createSessionOnMissing.baseUrl ?? 'https://api.agentscore.sh');
          const sessionRes = await fetch(`${sessionBaseUrl}/v1/sessions`, {
            method: 'POST',
            headers: {
              'X-API-Key': createSessionOnMissing.apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': userAgentHeader,
            },
            body: JSON.stringify(sessionBody),
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
          });

          if (sessionRes.ok) {
            const data = (await sessionRes.json()) as Record<string, unknown>;

            // Run onBeforeSession side-effect hook. Errors are swallowed — a failing DB
            // write (e.g. can't insert pending order) should not block the 403.
            let extra: Record<string, unknown> | undefined;
            if (createSessionOnMissing.onBeforeSession && ctx !== undefined) {
              try {
                const sessionMeta = {
                  session_id: data.session_id as string,
                  verify_url: data.verify_url as string,
                  poll_secret: data.poll_secret as string,
                  expires_at: data.expires_at as string | undefined,
                };
                const result = await createSessionOnMissing.onBeforeSession(ctx, sessionMeta);
                if (result && typeof result === 'object') extra = result;
              } catch (err) {
                console.warn('[gate] createSessionOnMissing.onBeforeSession hook failed:', err instanceof Error ? err.message : err);
              }
            }

            return {
              kind: 'deny',
              reason: {
                code: 'identity_verification_required',
                verify_url: data.verify_url as string | undefined,
                session_id: data.session_id as string | undefined,
                poll_secret: data.poll_secret as string | undefined,
                agent_instructions: data.agent_instructions as string | undefined,
                ...(extra && { extra }),
              },
            };
          }
        } catch {
          // Fall through to default missing_identity denial
        }
      }

      return { kind: 'deny', reason: { code: 'missing_identity' } };
    }

    const cacheKey = identity.operatorToken?.toLowerCase() ?? identity.address?.toLowerCase() ?? '';

    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.allow) {
        return { kind: 'allow', data: cached.raw as AgentScoreData };
      }
      return {
        kind: 'deny',
        reason: {
          code: 'wallet_not_trusted',
          decision: cached.decision,
          reasons: cached.reasons,
          verify_url: (cached.raw as Record<string, unknown> | undefined)?.verify_url as string | undefined,
          data: cached.raw as AgentScoreData | undefined,
        },
      };
    }

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
      if (Object.keys(policy).length > 0) body.policy = policy;

      const response = await fetch(`${baseUrl}/v1/assess`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgentHeader,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (response.status === 402) {
        if (failOpen) return { kind: 'allow' };
        return { kind: 'deny', reason: { code: 'payment_required' } };
      }

      if (!response.ok) {
        throw new Error(`AgentScore API returned ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const decision = data.decision as string | null | undefined;
      const decisionReasons = (data.decision_reasons as string[]) ?? [];
      const allow = decision === 'allow' || decision == null;

      cache.set(cacheKey, { allow, decision: decision ?? undefined, reasons: decisionReasons, raw: data });

      if (allow) {
        return { kind: 'allow', data: data as unknown as AgentScoreData };
      }

      return {
        kind: 'deny',
        reason: {
          code: 'wallet_not_trusted',
          decision: decision ?? undefined,
          reasons: decisionReasons,
          verify_url: data.verify_url as string | undefined,
          data: data as unknown as AgentScoreData,
        },
      };
    } catch {
      if (failOpen) return { kind: 'allow' };
      return { kind: 'deny', reason: { code: 'api_error' } };
    }
  }

  async function captureWallet(options: CaptureWalletOptions): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        operator_token: options.operatorToken,
        wallet_address: options.walletAddress,
        network: options.network,
      };
      if (options.idempotencyKey) body.idempotency_key = options.idempotencyKey;
      await fetch(`${baseUrl}/v1/credentials/wallets`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgentHeader,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      // Silent — capture is fire-and-forget
    }
  }

  return { evaluate, captureWallet };
}
