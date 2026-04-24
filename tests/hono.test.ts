import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate, captureWallet, getAgentScoreData } from '../src/adapters/hono';

declare const __VERSION__: string;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET = '0xabc123';
const OPERATOR_TOKEN = 'opc_test123';
const API_KEY = 'test-api-key';

const ALLOW_RESPONSE = {
  decision: 'allow',
  decision_reasons: ['no_policy_applied'],
  subject: { chains: ['base'], address: WALLET },
  score: { value: 85, grade: 'A' },
};

const DENY_RESPONSE = {
  decision: 'deny',
  decision_reasons: ['kyc_required'],
  subject: { chains: ['base'], address: WALLET },
  verify_url: 'https://agentscore.sh/verify/xyz',
};

const SESSION_RESPONSE = {
  session_id: 'sess_123',
  poll_secret: 'ps_secret',
  verify_url: 'https://agentscore.sh/verify/new',
  agent_instructions: 'Ask the user to verify',
};

function mockFetchOk(body: unknown): void {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValueOnce(body),
  } as unknown as Response);
}

function mockFetchStatus(status: number): void {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    json: vi.fn().mockResolvedValueOnce({}),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

describe('Hono adapter — identity extraction', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('extracts wallet address from X-Wallet-Address header', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.json({ data: getAgentScoreData(c) }));

    const res = await app.request('/test', {
      headers: { 'x-wallet-address': WALLET },
    });

    expect(res.status).toBe(200);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe(WALLET);
    expect(body.operator_token).toBeUndefined();
  });

  it('extracts operator token from X-Operator-Token header', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', {
      headers: { 'x-operator-token': OPERATOR_TOKEN },
    });

    expect(res.status).toBe(200);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.operator_token).toBe(OPERATOR_TOKEN);
  });

  it('returns 403 missing_identity when both headers absent and no createSessionOnMissing', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'missing_identity' });
  });

  it('uses custom extractIdentity when provided', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      extractIdentity: (c) => ({ address: c.req.header('x-custom-wallet') }),
    }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', {
      headers: { 'x-custom-wallet': '0xdef456' },
    });

    expect(res.status).toBe(200);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe('0xdef456');
  });
});

// ---------------------------------------------------------------------------
// Context attachment + getAgentScoreData helper
// ---------------------------------------------------------------------------

describe('Hono adapter — context attachment', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('attaches assess data via c.set, retrievable by getAgentScoreData', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.json(getAgentScoreData(c) ?? { empty: true }));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ decision: 'allow' });
  });

  it('getAgentScoreData returns undefined when gate fails open without data', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, failOpen: true }));
    app.get('/test', (c) => c.json({ data: getAgentScoreData(c) ?? null }));

    const res = await app.request('/test'); // no identity
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ data: null });
  });
});

// ---------------------------------------------------------------------------
// Deny behavior
// ---------------------------------------------------------------------------

describe('Hono adapter — deny behavior', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 403 wallet_not_trusted with verify_url on policy deny', async () => {
    mockFetchOk(DENY_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, requireKyc: true }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      error: 'wallet_not_trusted',
      decision: 'deny',
      reasons: ['kyc_required'],
      verify_url: 'https://agentscore.sh/verify/xyz',
    });
  });

  it('exposes raw assess response to custom onDenied so consumers can access policy_result', async () => {
    const DENY_WITH_POLICY = {
      ...DENY_RESPONSE,
      policy_result: {
        all_passed: false,
        checks: [{ rule: 'require_kyc', passed: false, required: true, actual: 'none' }],
      },
    };
    mockFetchOk(DENY_WITH_POLICY);
    const capturedReasons: Array<{ reasons?: string[]; policy_result?: unknown }> = [];
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      requireKyc: true,
      onDenied: (c, reason) => {
        capturedReasons.push({
          reasons: reason.reasons,
          policy_result: reason.data?.policy_result,
        });
        return c.json({ ok: false }, 403);
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    expect(capturedReasons[0]).toEqual({
      reasons: ['kyc_required'],
      policy_result: {
        all_passed: false,
        checks: [{ rule: 'require_kyc', passed: false, required: true, actual: 'none' }],
      },
    });
  });

  it('uses custom onDenied when provided', async () => {
    mockFetchOk(DENY_RESPONSE);
    const app = new Hono();
    const onDenied = vi.fn((c, reason) => c.json({ custom: true, code: reason.code }, 451));
    app.use('*', agentscoreGate({ apiKey: API_KEY, onDenied }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ custom: true, code: 'wallet_not_trusted' });
    expect(onDenied).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createSessionOnMissing
// ---------------------------------------------------------------------------

describe('Hono adapter — createSessionOnMissing', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('creates session and returns 403 identity_verification_required when identity missing', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: API_KEY, context: 'wine-purchase' },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      error: 'identity_verification_required',
      session_id: 'sess_123',
      poll_secret: 'ps_secret',
      verify_url: 'https://agentscore.sh/verify/new',
      agent_instructions: 'Ask the user to verify',
    });
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('/v1/sessions');
    const postBody = JSON.parse(fetchCall[1].body as string);
    expect(postBody.context).toBe('wine-purchase');
  });

  // -----------------------------------------------------------------------
  // getSessionOptions hook
  // -----------------------------------------------------------------------

  it('getSessionOptions overrides the static productName per-request', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('productName' as never, 'dynamic Cabernet' as never); await next(); });
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        context: 'wine-purchase',
        productName: 'static fallback',
        getSessionOptions: (c) => ({ productName: c.get('productName' as never) as string }),
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    await app.request('/test');
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const postBody = JSON.parse(fetchCall[1].body as string);
    expect(postBody.product_name).toBe('dynamic Cabernet');
    expect(postBody.context).toBe('wine-purchase');
  });

  it('getSessionOptions may be async', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        getSessionOptions: async () => ({ productName: 'async dynamic' }),
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    await app.request('/test');
    const postBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(postBody.product_name).toBe('async dynamic');
  });

  it('getSessionOptions errors are swallowed and static values used', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        productName: 'static',
        getSessionOptions: () => { throw new Error('boom'); },
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    expect(res.status).toBe(403);  // session still created
    const postBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(postBody.product_name).toBe('static');
  });

  // -----------------------------------------------------------------------
  // onBeforeSession hook
  // -----------------------------------------------------------------------

  it('onBeforeSession return value is merged into the 403 body', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        onBeforeSession: () => ({ order_id: 'ord_123', reservation_id: 'r_42' }),
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(body.order_id).toBe('ord_123');
    expect(body.reservation_id).toBe('r_42');
    expect(body.session_id).toBe('sess_123');
  });

  it('onBeforeSession receives the minted session metadata', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const hook = vi.fn().mockReturnValue({ order_id: 'ord_1' });
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: API_KEY, onBeforeSession: hook },
    }));
    app.get('/test', (c) => c.text('reached'));

    await app.request('/test');
    expect(hook).toHaveBeenCalledOnce();
    const sessionArg = hook.mock.calls[0]![1] as Record<string, unknown>;
    expect(sessionArg.session_id).toBe('sess_123');
    expect(sessionArg.verify_url).toBe('https://agentscore.sh/verify/new');
    expect(sessionArg.poll_secret).toBe('ps_secret');
  });

  it('onBeforeSession may be async', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        onBeforeSession: async () => ({ order_id: 'ord_async' }),
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(body.order_id).toBe('ord_async');
  });

  it('onBeforeSession errors are swallowed and 403 still emitted without extra', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        onBeforeSession: () => { throw new Error('db down'); },
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(body.session_id).toBe('sess_123');
    expect(body.order_id).toBeUndefined();
  });

  it('onBeforeSession non-object return is ignored (no extra merged)', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        onBeforeSession: () => 'not an object' as unknown as Record<string, unknown>,
      },
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(body.session_id).toBe('sess_123');
    // Extra was not an object → no new fields, but session data still present.
    expect(Object.keys(body)).not.toContain('not an object');
  });

  it('custom onDenied can read reason.extra to build a custom response', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: API_KEY,
        onBeforeSession: () => ({ order_id: 'ord_42' }),
      },
      onDenied: (c, reason) => c.json({
        code: reason.code,
        stash: (reason.extra as { order_id?: string } | undefined)?.order_id,
      }, 403),
    }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe('identity_verification_required');
    expect(body.stash).toBe('ord_42');
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------

describe('Hono adapter — fail-open', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('passes through on 402 when failOpen is true', async () => {
    mockFetchStatus(402);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, failOpen: true }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached');
  });

  it('returns 403 payment_required on 402 when failOpen is false', async () => {
    mockFetchStatus(402);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('reached'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'payment_required' });
  });
});

// ---------------------------------------------------------------------------
// User-Agent header
// ---------------------------------------------------------------------------

describe('Hono adapter — User-Agent header', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends User-Agent matching canonical package identifier', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`@agent-score/gate@${__VERSION__}`);
  });

  it('prepends userAgent option to default when configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, userAgent: 'wine-co/1.0.0' }));
    app.get('/test', (c) => c.text('ok'));

    await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`wine-co/1.0.0 (@agent-score/gate@${__VERSION__})`);
  });
});

// ---------------------------------------------------------------------------
// Error paths: 402 payment_required + 500 api_error
// ---------------------------------------------------------------------------

describe('Hono adapter — error paths', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 403 payment_required on 402 assess response', async () => {
    mockFetchStatus(402);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('payment_required');
  });

  it('returns 403 api_error on 500 assess response', async () => {
    mockFetchStatus(500);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('api_error');
  });

  it('fail_open allows through on 402', async () => {
    mockFetchStatus(402);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, failOpen: true }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(200);
  });

  it('fail_open allows through on 500', async () => {
    mockFetchStatus(500);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, failOpen: true }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test', { headers: { 'x-wallet-address': WALLET } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// chain= constructor option
// ---------------------------------------------------------------------------

describe('Hono adapter — chain option', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('forwards constructor chain to /v1/assess body', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY, chain: 'solana' }));
    app.get('/test', (c) => c.text('ok'));

    await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBe('solana');
  });

  it('omits chain from body when not configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    await app.request('/test', { headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// captureWallet
// ---------------------------------------------------------------------------

describe('Hono adapter — captureWallet', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('forwards idempotencyKey as snake_case idempotency_key in the body', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: false, deduped: true }) } as unknown as Response);

    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.post('/purchase', async (c) => {
      await captureWallet(c, { walletAddress: '0xsigner', network: 'evm', idempotencyKey: 'pi_abc' });
      return c.text('ok');
    });

    await app.request('/purchase', {
      method: 'POST',
      headers: { 'x-operator-token': OPERATOR_TOKEN },
    });

    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(captureCall[1].body as string);
    expect(body.idempotency_key).toBe('pi_abc');
  });

  it('posts to /v1/credentials/wallets with operator_token, wallet_address, and network', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: true }) } as unknown as Response);

    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.post('/purchase', async (c) => {
      await captureWallet(c, { walletAddress: '0xsigner', network: 'evm' });
      return c.text('ok');
    });

    const res = await app.request('/purchase', {
      method: 'POST',
      headers: { 'x-operator-token': OPERATOR_TOKEN },
    });

    expect(res.status).toBe(200);
    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(captureCall[0]).toContain('/v1/credentials/wallets');
    const body = JSON.parse(captureCall[1].body as string);
    expect(body).toEqual({
      operator_token: OPERATOR_TOKEN,
      wallet_address: '0xsigner',
      network: 'evm',
    });
  });

  it('no-ops silently when request was wallet-authenticated (no operator_token)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response);

    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.post('/purchase', async (c) => {
      await captureWallet(c, { walletAddress: '0xsigner', network: 'evm' });
      return c.text('ok');
    });

    const res = await app.request('/purchase', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    expect(res.status).toBe(200);
    // Only the assess call, no capture call
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('swallows capture failures silently so the handler response is unaffected', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockRejectedValueOnce(new Error('network down'));

    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.post('/purchase', async (c) => {
      await captureWallet(c, { walletAddress: '0xsigner', network: 'evm' });
      return c.text('ok');
    });

    const res = await app.request('/purchase', {
      method: 'POST',
      headers: { 'x-operator-token': OPERATOR_TOKEN },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// beforeEach: reset fetch mocks between tests to avoid cache bleed
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});
