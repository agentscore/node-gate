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
  poll_url: string;
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

export type DenialCode =
  | 'wallet_not_trusted'
  | 'missing_identity'
  | 'api_error'
  | 'payment_required'
  | 'identity_verification_required'
  // Wallet-signer binding: claimed X-Wallet-Address must resolve to the same operator as
  // the payment signer; wallet-auth is rejected on rails with no wallet signer.
  | 'wallet_signer_mismatch'
  | 'wallet_auth_requires_wallet_signing'
  // Granular credential-state denials passed through from /v1/assess.
  | 'token_expired';

/**
 * Cross-merchant pattern hint emitted on bootstrap denials and session-create responses.
 * LLM-hosted agents should persist this to long-term memory so future AgentScore encounters skip
 * the cold-start session flow. Contents are the pattern, not secrets.
 */
export interface AgentMemoryHint {
  save_for_future_agentscore_gates: true;
  pattern_summary: string;
  quickstart: string;
  identity_check_endpoint: string;
  list_wallets_endpoint?: string;
  identity_paths: { wallet: string; operator_token: string };
  bootstrap: string;
  do_not_persist_in_memory: string[];
  persist_in_credential_store: string[];
}

export interface DenialReason {
  code: DenialCode;
  decision?: string;
  reasons?: string[];
  verify_url?: string;
  session_id?: string;
  poll_secret?: string;
  poll_url?: string;
  agent_instructions?: string;
  /** Cross-merchant memory hint. Emitted on bootstrap denials only by default. */
  agent_memory?: AgentMemoryHint;
  /** Full assess response when the denial came from `/v1/assess`. Lets consumers access fields
   *  not promoted to first-class DenialReason properties (e.g., `policy_result`). Undefined for
   *  denials that did not originate from an assess call (missing_identity, api_error,
   *  payment_required, identity_verification_required). */
  data?: AgentScoreData;
  /** Extra fields returned from the `createSessionOnMissing.onBeforeSession` hook. Merged
   *  into the default 403 body; custom `onDenied` handlers can spread these into their own
   *  response shape (e.g. to include a merchant-minted `order_id`). */
  extra?: Record<string, unknown>;
  // ---------------------------------------------------------------------------
  // Wallet-signer-match fields — populated for wallet_signer_mismatch only.
  // ---------------------------------------------------------------------------
  /** Operator id resolved from `X-Wallet-Address`. */
  claimed_operator?: string;
  /** Operator id the actual payment signer resolves to. `null` when the signer wallet isn't
   *  linked to any operator (treat as a different identity). */
  actual_signer_operator?: string | null;
  /** The wallet the agent claimed via header. Echoed back for self-correction. */
  expected_signer?: string;
  /** The wallet that actually signed the payment. */
  actual_signer?: string;
  /** Wallets the claimed operator could sign with (if enumerable). Present when non-empty. */
  linked_wallets?: string[];
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

export interface VerifyWalletSignerMatchOptions {
  /** The wallet claimed via `X-Wallet-Address`. */
  claimedWallet: string;
  /** The signer wallet recovered from the payment credential. `null` means the rail carries
   *  no wallet signer (SPT, card) — the helper returns `wallet_auth_requires_wallet_signing`. */
  signer: string | null;
  /** Network of the signer. EVM covers every EVM chain; `solana` lives in its own namespace. */
  network?: 'evm' | 'solana';
}

export type VerifyWalletSignerResult =
  | { kind: 'pass'; claimedOperator: string | null; signerOperator: string | null }
  | {
      kind: 'wallet_signer_mismatch';
      claimedOperator: string | null;
      actualSignerOperator: string | null;
      expectedSigner: string;
      actualSigner: string;
      linkedWallets: string[];
      /** JSON-encoded action copy (action + steps + user_message). Spread into the 403 body
       *  verbatim so agents get a concrete recovery path inside the denial response itself. */
      agentInstructions: string;
    }
  | {
      kind: 'wallet_auth_requires_wallet_signing';
      claimedWallet: string;
      agentInstructions: string;
    }
  // Transient — the resolve call to /v1/assess failed or timed out. Caller should
  // retry or surface as 503. Distinct from wallet_signer_mismatch (which is an actual
  // security reject) so legitimate users don't get rejected on network flakes.
  | { kind: 'api_error'; claimedWallet: string };

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
  /**
   * Verify the payment signer resolves to the same operator as the claimed `X-Wallet-Address`.
   *
   * Returns `pass` when the signer is linked to the same operator as the claimed wallet
   * (byte-equal wallets pass trivially; other wallets linked to the same operator also pass —
   * multi-wallet agents work without ergonomic pain). Returns `wallet_signer_mismatch` when
   * the signer resolves to a different (or no) operator. Returns `wallet_auth_requires_wallet_signing`
   * when the signer is `null` (SPT, card — rails that carry no wallet signature).
   *
   * Call this AFTER the gate evaluates (so the claimed wallet's operator is cached) and
   * AFTER the payment credential is parsed (so the signer is known). Merchants should call
   * it before settling payment.
   */
  verifyWalletSignerMatch(options: VerifyWalletSignerMatchOptions): Promise<VerifyWalletSignerResult>;
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

/**
 * Build the cross-merchant memory hint emitted on bootstrap denials. Base URLs are
 * derived from the gate's AgentScore API base so self-hosted / staging deployments get
 * correct pointers. Contents describe the AgentScore identity substrate in transferable
 * terms; merchant-specific context lives in other `agent_instructions` fields.
 */
// Canonical production AgentScore API — used as the authoritative source for endpoint pointers
// emitted to agent memory regardless of how a given merchant configured their gate's baseUrl.
// Hardcoded so a malicious merchant can't set `baseUrl: "evil.com"` and phish agents into
// sending their credentials to attacker-controlled endpoints.
const CANONICAL_AGENTSCORE_API = 'https://api.agentscore.sh';

// JSON-encoded action copy emitted on wallet-signer-match denials. Spread into 403 bodies
// by merchants so agents get a concrete recovery path inside the denial response itself —
// no discovery-doc round trip required.
const WALLET_SIGNER_MISMATCH_INSTRUCTIONS = JSON.stringify({
  action: 'resign_or_switch_to_operator_token',
  steps: [
    'Preferred: re-submit the payment signed by expected_signer (or any entry in linked_wallets — same-operator wallets are fungible) and retry with the same X-Wallet-Address.',
    'Alternative: drop X-Wallet-Address and retry with X-Operator-Token. Use a stored opc_... if you have one; otherwise retry this request with NO identity header — the merchant will mint a verification session in the 403 body (verify_url + poll_secret). Share verify_url with the user, poll, receive a fresh opc_...',
  ],
  user_message:
    'The payment signer resolves to a different operator than X-Wallet-Address. Re-sign from expected_signer or any linked_wallets entry, or switch to X-Operator-Token.',
});

const WALLET_AUTH_REQUIRES_WALLET_SIGNING_INSTRUCTIONS = JSON.stringify({
  action: 'switch_to_operator_token',
  steps: [
    'This payment rail (Stripe SPT, card) carries no wallet signature — X-Wallet-Address cannot be verified against the payment.',
    'Drop X-Wallet-Address and retry with X-Operator-Token. If you do not have a stored opc_..., retry with no identity header to receive a verification session.',
  ],
  user_message:
    'Wallet-address identity is only supported on wallet-signing rails (Tempo MPP, x402). On Stripe or card, use X-Operator-Token instead.',
});

export function buildAgentMemoryHint(_baseUrl?: string): AgentMemoryHint {
  // _baseUrl is kept in the signature for backwards compat but deliberately ignored —
  // agent memory pointers must always point at the canonical production API to prevent
  // merchant-initiated phishing across the cross-merchant memory surface.
  const api = CANONICAL_AGENTSCORE_API;
  return {
    save_for_future_agentscore_gates: true,
    pattern_summary:
      'AgentScore is a cross-merchant identity substrate for agent commerce. Any endpoint that ' +
      'returns 403 missing_identity / identity_verification_required or 402 challenges referencing AgentScore uses ' +
      'the same identity system. One KYC works across all AgentScore merchants — no re-verification ' +
      'per site. Save this pattern (and the endpoints below) to persistent memory so future ' +
      'AgentScore encounters skip the cold-start session flow.',
    quickstart: 'https://docs.agentscore.sh/guides/agent-identity',
    identity_check_endpoint: `${api}/v1/credentials`,
    identity_paths: {
      wallet:
        'If paying from a crypto wallet you have used before on any AgentScore merchant, send ' +
        '`X-Wallet-Address: 0x...`. Shortest path; no token lifecycle to manage.',
      operator_token:
        'For any rail (Stripe SPT, card, or a wallet you have not linked yet), send ' +
        '`X-Operator-Token: opc_...`. Reusable across merchants until the token expires.',
    },
    bootstrap:
      'If you have neither a linked wallet nor a valid operator_token, follow the session/verify ' +
      'flow in the per-request `agent_instructions` block. This happens at most once per agent ' +
      'identity — after first verification, the operator_token and any subsequently used wallet ' +
      'are reusable everywhere.',
    do_not_persist_in_memory: ['operator_token', 'poll_secret'],
    persist_in_credential_store: ['operator_token'],
  };
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
  const agentMemoryHint = buildAgentMemoryHint(baseUrl);

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

            // Validate required fields before trusting the response. A misbehaving
            // (or mocked-wrong) API could 200 without session_id/poll_secret/verify_url,
            // which would propagate `undefined` into the 403 body and leave the agent
            // stuck — treat that as a session-create failure and fall back to the bare
            // missing_identity denial with the probe strategy copy.
            if (
              typeof data.session_id !== 'string' ||
              typeof data.poll_secret !== 'string' ||
              typeof data.verify_url !== 'string'
            ) {
              console.warn('[gate] /v1/sessions returned 200 without required fields — falling back to bare missing_identity');
              // fall through to the bare denial below
            } else {

            // Run onBeforeSession side-effect hook. Errors are swallowed — a failing DB
            // write (e.g. can't insert pending order) should not block the 403.
            let extra: Record<string, unknown> | undefined;
            if (createSessionOnMissing.onBeforeSession && ctx !== undefined) {
              try {
                const sessionMeta = {
                  session_id: data.session_id as string,
                  verify_url: data.verify_url as string,
                  poll_secret: data.poll_secret as string,
                  poll_url: data.poll_url as string,
                  expires_at: data.expires_at as string | undefined,
                };
                const result = await createSessionOnMissing.onBeforeSession(ctx, sessionMeta);
                if (result && typeof result === 'object') extra = result;
              } catch (err) {
                console.warn('[gate] createSessionOnMissing.onBeforeSession hook failed:', err instanceof Error ? err.message : err);
              }
            }

            // The API emits `next_steps` (structured object) on /v1/sessions success.
            // Stringify it into the gate's `agent_instructions` contract so merchants
            // get the same JSON-encoded {action, steps, user_message} envelope as every
            // other gate-emitted denial.
            const apiNextSteps = data.next_steps as Record<string, unknown> | undefined;
            return {
              kind: 'deny',
              reason: {
                code: 'identity_verification_required',
                verify_url: data.verify_url as string,
                session_id: data.session_id as string,
                poll_secret: data.poll_secret as string,
                poll_url: data.poll_url as string | undefined,
                agent_instructions: apiNextSteps ? JSON.stringify(apiNextSteps) : undefined,
                agent_memory: agentMemoryHint,
                ...(extra && { extra }),
              },
            };
            }
          }
        } catch {
          // Fall through to default missing_identity denial
        }
      }

      // Bare missing-identity denial (no session was auto-created). Describe the probe
      // strategy so agents without memory can recover: try wallet first on signing rails,
      // fall back to stored opc_..., fall back to session flow (noting that only
      // auto-session merchants return verify_url + poll data on the retry).
      const missingIdentityInstructions = JSON.stringify({
        action: 'probe_identity_then_session',
        steps: [
          'If you have a wallet AND this merchant accepts a wallet-signing rail (Tempo MPP or x402 — see openapi.json x-payment-info): send X-Wallet-Address and retry. If the wallet is already linked to an AgentScore operator (via prior SIWE claim or prior captureWallet), this passes in one round trip. If the wallet is unlinked or the account has no KYC, the 403 will include a verify_url — share it with the user to claim the wallet + complete KYC, then retry.',
          'If step 1 is denied or you already have a stored operator_token (valid + not expired): send X-Operator-Token: opc_... and retry.',
          'If neither applies: retry with NO identity header. Merchants that auto-create verification sessions (most AgentScore merchants do) return verify_url + session_id + poll_secret in the 403 body — share verify_url with the user, then poll poll_url every 5s with the X-Poll-Secret header until status=verified (the poll returns a one-time operator_token). If the retry returns the same bare 403, this merchant does not support self-service session bootstrapping — direct the user to https://agentscore.sh/sign-up to create an AgentScore identity and mint an operator_token from their dashboard (https://agentscore.sh/dashboard/verify). The user hands the opc_... to you, and you retry with X-Operator-Token.',
        ],
        user_message:
          'Try X-Wallet-Address first if you have a wallet and the merchant accepts Tempo/x402; fall back to a stored X-Operator-Token, then to the session/verify flow described in agent_memory.bootstrap.',
      });
      return {
        kind: 'deny',
        reason: {
          code: 'missing_identity',
          agent_instructions: missingIdentityInstructions,
          agent_memory: agentMemoryHint,
        },
      };
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

      // Pass through the API's token_expired 401 (covers both expired and revoked
      // credentials — the API deliberately doesn't distinguish). The 401 body carries
      // an auto-minted session (verify_url + session_id + poll_secret + next_steps +
      // agent_memory) so agents can recover without holding an API key. Forward all of
      // that into the DenialReason so the gate's 403 body includes the session fields.
      if (response.status === 401) {
        try {
          const errData = (await response.clone().json()) as {
            error?: { code?: string };
            session_id?: unknown;
            poll_secret?: unknown;
            verify_url?: unknown;
            poll_url?: unknown;
            next_steps?: unknown;
            agent_memory?: unknown;
          };
          const code = errData?.error?.code;
          if (code === 'token_expired') {
            return {
              kind: 'deny',
              reason: {
                code,
                data: errData as unknown as AgentScoreData,
                ...(typeof errData.verify_url === 'string' ? { verify_url: errData.verify_url } : {}),
                ...(typeof errData.session_id === 'string' ? { session_id: errData.session_id } : {}),
                ...(typeof errData.poll_secret === 'string' ? { poll_secret: errData.poll_secret } : {}),
                ...(typeof errData.poll_url === 'string' ? { poll_url: errData.poll_url } : {}),
                ...(errData.next_steps ? { agent_instructions: JSON.stringify(errData.next_steps) } : {}),
                ...(errData.agent_memory ? { agent_memory: errData.agent_memory as AgentMemoryHint } : {}),
              },
            };
          }
        } catch {
          // Fall through to generic error handling if the body isn't the expected shape.
        }
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
    } catch (err) {
      // Fire-and-forget: don't throw. Log so a persistent capture outage is visible
      // to merchant ops — otherwise wallet↔operator linkage silently stops.
      console.warn('[agentscore-gate] captureWallet failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Resolve a wallet to its operator id via /v1/assess.
   *
   * Returns:
   *   - `{ ok: true, operator: <id> }` — wallet is linked to that operator
   *   - `{ ok: true, operator: null }` — wallet is valid but not linked to any operator
   *   - `{ ok: false }` — the API call failed (network, timeout, non-2xx). Distinguishable so
   *     callers can emit `api_error` instead of falsely asserting "no operator linked".
   *
   * Checks the main evaluate() cache before making a fresh call — if the gate already
   * resolved this wallet during identity evaluation, we have the resolved_operator already.
   */
  async function resolveWalletToOperator(
    walletAddress: string,
  ): Promise<{ ok: true; operator: string | null; linkedWallets: string[] } | { ok: false }> {
    const wallet = walletAddress.toLowerCase();

    // Cache lookup — first the plain cache (populated by evaluate() for identity-headered wallets).
    // Saves a second /v1/assess call when the gate already looked up this wallet.
    const extractFromCached = (raw: Record<string, unknown>): { operator: string | null; linkedWallets: string[] } => {
      const op = raw.resolved_operator;
      const links = raw.linked_wallets;
      return {
        operator: typeof op === 'string' ? op : null,
        linkedWallets: Array.isArray(links) ? (links as unknown[]).filter((w): w is string => typeof w === 'string') : [],
      };
    };

    const plainCached = cache.get(wallet);
    if (plainCached?.raw) {
      return { ok: true, ...extractFromCached(plainCached.raw as Record<string, unknown>) };
    }
    const resolveCached = cache.get(`resolve:${wallet}`);
    if (resolveCached?.raw) {
      return { ok: true, ...extractFromCached(resolveCached.raw as Record<string, unknown>) };
    }

    try {
      const response = await fetch(`${baseUrl}/v1/assess`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgentHeader,
        },
        body: JSON.stringify({ address: walletAddress }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false };
      const data = (await response.json()) as Record<string, unknown>;
      cache.set(`resolve:${wallet}`, { allow: true, raw: data });
      return { ok: true, ...extractFromCached(data) };
    } catch {
      return { ok: false };
    }
  }

  function reportSignerEvent(kind: 'pass' | 'wallet_signer_mismatch' | 'wallet_auth_requires_wallet_signing' | 'api_error'): void {
    // Fire-and-forget: surfaces mismatch-catch rate + api_error SLO on the dashboard.
    // Never blocks, awaits, or throws — telemetry failure must not affect the gate's decision.
    try {
      const pending = fetch(`${baseUrl}/v1/telemetry/signer-match`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgentHeader,
        },
        body: JSON.stringify({ kind }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          console.warn('[agentscore-gate] signer-match telemetry failed:', err instanceof Error ? err.message : err);
        });
      }
    } catch {
      // Thrown synchronously (e.g., fetch unavailable in test harness) — swallow silently.
    }
  }

  async function verifyWalletSignerMatch(
    options: VerifyWalletSignerMatchOptions,
  ): Promise<VerifyWalletSignerResult> {
    const { claimedWallet, signer } = options;

    if (!signer) {
      reportSignerEvent('wallet_auth_requires_wallet_signing');
      return {
        kind: 'wallet_auth_requires_wallet_signing',
        claimedWallet,
        agentInstructions: WALLET_AUTH_REQUIRES_WALLET_SIGNING_INSTRUCTIONS,
      };
    }

    const claimedLower = claimedWallet.toLowerCase();
    const signerLower = signer.toLowerCase();

    // Byte-equal short-circuit — no API lookup; same wallet ≡ same operator by definition.
    if (claimedLower === signerLower) {
      reportSignerEvent('pass');
      return { kind: 'pass', claimedOperator: null, signerOperator: null };
    }

    const [claimedResolve, signerResolve] = await Promise.all([
      resolveWalletToOperator(claimedLower),
      resolveWalletToOperator(signerLower),
    ]);

    // Transient API failure on either resolve → emit api_error. Caller should retry or
    // surface 503 rather than falsely reject a legitimate user on a network flake.
    if (!claimedResolve.ok || !signerResolve.ok) {
      reportSignerEvent('api_error');
      return { kind: 'api_error', claimedWallet: claimedLower };
    }

    const claimedOperator = claimedResolve.operator;
    const signerOperator = signerResolve.operator;

    if (claimedOperator && signerOperator && claimedOperator === signerOperator) {
      reportSignerEvent('pass');
      return { kind: 'pass', claimedOperator, signerOperator };
    }

    reportSignerEvent('wallet_signer_mismatch');
    return {
      kind: 'wallet_signer_mismatch',
      claimedOperator,
      actualSignerOperator: signerOperator,
      expectedSigner: claimedLower,
      actualSigner: signerLower,
      // Populated from /v1/assess.linked_wallets on the claimed wallet — the full set of
      // wallets the agent CAN sign with to satisfy the claim (same-operator rule).
      linkedWallets: claimedResolve.linkedWallets,
      agentInstructions: WALLET_SIGNER_MISMATCH_INSTRUCTIONS,
    };
  }

  return { evaluate, captureWallet, verifyWalletSignerMatch };
}
