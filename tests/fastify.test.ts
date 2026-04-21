import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate, captureWallet } from '../src/adapters/fastify';

declare const __VERSION__: string;

const WALLET = '0xabc123';
const API_KEY = 'test-api-key';

const ALLOW_RESPONSE = {
  decision: 'allow',
  decision_reasons: ['no_policy_applied'],
  subject: { chains: ['base'], address: WALLET },
};

const DENY_RESPONSE = {
  decision: 'deny',
  decision_reasons: ['kyc_required'],
  verify_url: 'https://agentscore.sh/verify/xyz',
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

describe('Fastify adapter — identity extraction', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('extracts wallet address from X-Wallet-Address header and attaches assess data to request', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.get('/test', async (req) => ({
      agentscore: (req as unknown as { agentscore?: unknown }).agentscore,
    }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    expect(res.statusCode).toBe(200);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe(WALLET);
    expect(res.json()).toMatchObject({ agentscore: { decision: 'allow' } });
  });

  it('returns 403 missing_identity when both headers absent', async () => {
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'missing_identity' });
  });

  it('uses custom extractIdentity when provided', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, {
      apiKey: API_KEY,
      extractIdentity: (req) => ({ address: (req.headers['x-custom-wallet'] as string) || undefined }),
    });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-custom-wallet': '0xdef456' } });

    expect(res.statusCode).toBe(200);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe('0xdef456');
  });
});

describe('Fastify adapter — deny behavior', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 403 wallet_not_trusted with verify_url on policy deny', async () => {
    mockFetchOk(DENY_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, requireKyc: true });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'wallet_not_trusted',
      reasons: ['kyc_required'],
      verify_url: 'https://agentscore.sh/verify/xyz',
    });
  });

  it('uses custom onDenied when provided', async () => {
    mockFetchOk(DENY_RESPONSE);
    const app = Fastify();
    const onDenied = vi.fn((_req, reply, reason) => {
      reply.code(451).send({ custom: true, code: reason.code });
    });
    await app.register(agentscoreGate, { apiKey: API_KEY, onDenied });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    expect(res.statusCode).toBe(451);
    expect(res.json()).toEqual({ custom: true, code: 'wallet_not_trusted' });
    expect(onDenied).toHaveBeenCalledOnce();
  });

  it('exposes the full assess response on reason.data in custom onDenied', async () => {
    const denyWithPolicy = {
      decision: 'deny',
      decision_reasons: ['kyc_required'],
      verify_url: 'https://agentscore.sh/verify/xyz',
      policy_result: { all_passed: false, checks: [{ rule: 'require_kyc', passed: false }] },
    };
    mockFetchOk(denyWithPolicy);
    const app = Fastify();
    let captured: unknown = null;
    const onDenied = vi.fn((_req, reply, reason) => {
      captured = reason.data;
      reply.code(403).send({});
    });
    await app.register(agentscoreGate, { apiKey: API_KEY, requireKyc: true, onDenied });
    app.get('/test', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    expect(captured).toMatchObject({
      decision: 'deny',
      decision_reasons: ['kyc_required'],
      policy_result: { all_passed: false, checks: [{ rule: 'require_kyc', passed: false }] },
    });
  });
});

describe('Fastify adapter — User-Agent', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends canonical User-Agent by default', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.get('/test', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`@agent-score/gate@${__VERSION__}`);
  });

  it('prepends custom userAgent to the default', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, userAgent: 'fastify-app/2.0' });
    app.get('/test', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`fastify-app/2.0 (@agent-score/gate@${__VERSION__})`);
  });
});

describe('Fastify adapter — fail-open + session creation paths', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('allows through on 402 when failOpen is true', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: vi.fn().mockResolvedValueOnce({}),
    } as unknown as Response);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, failOpen: true });
    app.get('/test', async () => ({ reached: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reached: true });
  });

  it('creates a session and returns 403 identity_verification_required when identity missing', async () => {
    mockFetchOk({
      session_id: 'sess_fy1',
      poll_secret: 'ps_fy',
      verify_url: 'https://agentscore.sh/verify/fy',
      agent_instructions: 'Verify to continue',
    });
    const app = Fastify();
    await app.register(agentscoreGate, {
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: API_KEY, context: 'api' },
    });
    app.get('/test', async () => ({ reached: true }));

    const res = await app.inject({ method: 'GET', url: '/test' });
    const body = res.json();

    expect(res.statusCode).toBe(403);
    expect(body).toMatchObject({
      error: 'identity_verification_required',
      session_id: 'sess_fy1',
      poll_secret: 'ps_fy',
    });
  });
});

describe('Fastify adapter — error paths', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 403 payment_required on 402 assess response', async () => {
    mockFetchStatus(402);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('payment_required');
  });

  it('returns 403 api_error on 500 assess response', async () => {
    mockFetchStatus(500);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('api_error');
  });

  it('fail_open allows through on 402', async () => {
    mockFetchStatus(402);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, failOpen: true });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });
    expect(res.statusCode).toBe(200);
  });

  it('fail_open allows through on 500', async () => {
    mockFetchStatus(500);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, failOpen: true });
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });
    expect(res.statusCode).toBe(200);
  });
});

describe('Fastify adapter — chain option', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('forwards constructor chain to /v1/assess body', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY, chain: 'solana' });
    app.get('/test', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/test', headers: { 'x-wallet-address': WALLET } });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBe('solana');
  });
});

describe('Fastify adapter — captureWallet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts to /v1/credentials/wallets after the gate ran on an operator_token request', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: true }) } as unknown as Response);

    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.post('/purchase', async (req, reply) => {
      await captureWallet(req, { walletAddress: '0xsigner', network: 'evm' });
      reply.send({ ok: true });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/purchase',
      headers: { 'x-operator-token': 'opc_test' },
    });

    expect(res.statusCode).toBe(200);
    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(captureCall[0]).toContain('/v1/credentials/wallets');
    expect(JSON.parse(captureCall[1].body as string)).toEqual({
      operator_token: 'opc_test',
      wallet_address: '0xsigner',
      network: 'evm',
    });
  });

  it('no-ops silently on a wallet-authenticated request', async () => {
    mockFetchOk(ALLOW_RESPONSE);

    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.post('/purchase', async (req, reply) => {
      await captureWallet(req, { walletAddress: '0xsigner', network: 'evm' });
      reply.send({ ok: true });
    });

    await app.inject({
      method: 'POST',
      url: '/purchase',
      headers: { 'x-wallet-address': WALLET },
    });

    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('forwards idempotencyKey as snake_case idempotency_key in the body', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: false, deduped: true }) } as unknown as Response);

    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.post('/purchase', async (req, reply) => {
      await captureWallet(req, { walletAddress: '0xsigner', network: 'evm', idempotencyKey: 'pi_abc' });
      reply.send({ ok: true });
    });

    await app.inject({
      method: 'POST',
      url: '/purchase',
      headers: { 'x-operator-token': 'opc_test' },
    });

    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(captureCall[1].body as string);
    expect(body.idempotency_key).toBe('pi_abc');
  });

  it('swallows capture failures silently — handler response unaffected', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockRejectedValueOnce(new Error('network down'));

    const app = Fastify();
    await app.register(agentscoreGate, { apiKey: API_KEY });
    app.post('/purchase', async (req, reply) => {
      await captureWallet(req, { walletAddress: '0xsigner', network: 'evm' });
      reply.send({ ok: true });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/purchase',
      headers: { 'x-operator-token': 'opc_test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
