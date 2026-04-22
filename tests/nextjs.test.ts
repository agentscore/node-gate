import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreMiddleware, withAgentScoreGate } from '../src/adapters/nextjs';

const WALLET = '0xabc123';
const API_KEY = 'test-api-key';

const ALLOW_RESPONSE = {
  decision: 'allow',
  decision_reasons: ['no_policy_applied'],
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

describe('Next.js adapter — withAgentScoreGate (route handler wrapper)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reaches handler on allow with assess data', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const handler = vi.fn(async (_req: Request, gate) => Response.json({ data: gate.data }));
    const POST = withAgentScoreGate({ apiKey: API_KEY }, handler);
    const req = new Request('https://example.com/api/purchase', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.data).toMatchObject({ decision: 'allow' });
  });

  it('returns 403 on deny without invoking handler', async () => {
    mockFetchOk(DENY_RESPONSE);
    const handler = vi.fn();
    const POST = withAgentScoreGate({ apiKey: API_KEY, requireKyc: true }, handler);
    const req = new Request('https://example.com/api/purchase', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ error: 'wallet_not_trusted' });
  });

  it('uses a custom onDenied handler when provided', async () => {
    mockFetchOk(DENY_RESPONSE);
    const onDenied = vi.fn((_req, reason) =>
      new Response(JSON.stringify({ code: reason.code, custom: true }), { status: 451 }),
    );
    const POST = withAgentScoreGate(
      { apiKey: API_KEY, requireKyc: true, onDenied },
      async () => new Response('ok'),
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    const res = await POST(req);

    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ code: 'wallet_not_trusted', custom: true });
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
    let captured: unknown = null;
    const POST = withAgentScoreGate(
      {
        apiKey: API_KEY,
        requireKyc: true,
        onDenied: (_req, reason) => {
          captured = reason.data;
          return new Response(null, { status: 403 });
        },
      },
      async () => new Response('ok'),
    );
    const req = new Request('https://example.com/api/purchase', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    await POST(req);

    expect(captured).toMatchObject({
      decision: 'deny',
      decision_reasons: ['kyc_required'],
      policy_result: { all_passed: false, checks: [{ rule: 'require_kyc', passed: false }] },
    });
  });

  it('honors a custom extractIdentity from options', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const POST = withAgentScoreGate(
      {
        apiKey: API_KEY,
        extractIdentity: (req) => ({ address: req.headers.get('x-custom-wallet') ?? undefined }),
      },
      async () => new Response('ok'),
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-custom-wallet': '0xdef456' },
    });

    await POST(req);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe('0xdef456');
  });

  it('sends User-Agent with canonical default and prepends custom userAgent when configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const POST = withAgentScoreGate(
      { apiKey: API_KEY, userAgent: 'my-next-app/1.0.0' },
      async () => new Response('ok'),
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    await POST(req);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toMatch(/^my-next-app\/1\.0\.0 \(@agent-score\/gate@\d+\.\d+\.\d+\)$/);
  });

  it('allows through when failOpen is true and API returns 402', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: vi.fn().mockResolvedValueOnce({}),
    } as unknown as Response);
    const handler = vi.fn(async () => new Response('reached'));
    const POST = withAgentScoreGate({ apiKey: API_KEY, failOpen: true }, handler);
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('creates a session and returns 403 identity_verification_required when identity is missing', async () => {
    const SESSION_RESPONSE = {
      session_id: 'sess_nx1',
      poll_secret: 'ps_nx',
      verify_url: 'https://agentscore.sh/verify/nx',
      agent_instructions: 'Verify to continue',
    };
    mockFetchOk(SESSION_RESPONSE);
    const POST = withAgentScoreGate(
      {
        apiKey: API_KEY,
        createSessionOnMissing: { apiKey: API_KEY, context: 'api' },
      },
      async () => new Response('reached'),
    );
    const req = new Request('https://example.com/api/x', { method: 'POST' });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      error: 'identity_verification_required',
      session_id: 'sess_nx1',
      poll_secret: 'ps_nx',
    });
  });

  it('exposes captureWallet on the handler gate arg when operator_token was used', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: true }) } as unknown as Response);

    const POST = withAgentScoreGate(
      { apiKey: API_KEY },
      async (_req, gate) => {
        await gate.captureWallet!({ walletAddress: '0xsigner', network: 'evm' });
        return Response.json({ ok: true });
      },
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-operator-token': 'opc_test' },
    });

    await POST(req);

    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(captureCall[0]).toContain('/v1/credentials/wallets');
    expect(JSON.parse(captureCall[1].body as string)).toEqual({
      operator_token: 'opc_test',
      wallet_address: '0xsigner',
      network: 'evm',
    });
  });

  it('forwards idempotencyKey as snake_case idempotency_key in the body', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: false, deduped: true }) } as unknown as Response);

    const POST = withAgentScoreGate(
      { apiKey: API_KEY },
      async (_req, gate) => {
        await gate.captureWallet!({ walletAddress: '0xsigner', network: 'evm', idempotencyKey: 'pi_abc' });
        return Response.json({ ok: true });
      },
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-operator-token': 'opc_test' },
    });

    await POST(req);

    const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = JSON.parse(captureCall[1].body as string);
    expect(body.idempotency_key).toBe('pi_abc');
  });

  it('leaves gate.captureWallet undefined when the request was wallet-authenticated', async () => {
    mockFetchOk(ALLOW_RESPONSE);

    const handler = vi.fn(async (_req: Request, gate) => {
      expect(gate.captureWallet).toBeUndefined();
      return Response.json({ ok: true });
    });
    const POST = withAgentScoreGate({ apiKey: API_KEY }, handler);
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  it('captureWallet swallows failures silently — handler response unaffected', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockRejectedValueOnce(new Error('network down'));

    const POST = withAgentScoreGate(
      { apiKey: API_KEY },
      async (_req, gate) => {
        await gate.captureWallet!({ walletAddress: '0xsigner', network: 'evm' });
        return Response.json({ ok: true });
      },
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-operator-token': 'opc_test' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('passes Next.js route params ctx through to handler', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const handler = vi.fn(async (_req: Request, _gate, ctx) => Response.json({ ctx }));
    const POST = withAgentScoreGate<Request, { params: Promise<{ slug: string }> }>(
      { apiKey: API_KEY },
      handler,
    );
    const req = new Request('https://example.com/api/x', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });
    const ctx = { params: Promise.resolve({ slug: 'wine' }) };

    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(handler.mock.calls[0][2]).toBe(ctx);
  });
});

describe('Next.js adapter — agentscoreMiddleware', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns undefined on allow (request should continue)', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreMiddleware({ apiKey: API_KEY });
    const req = new Request('https://example.com/api/purchase', {
      headers: { 'x-wallet-address': WALLET },
    });

    const result = await mw(req);

    expect(result).toBeUndefined();
  });

  it('returns a Response on deny', async () => {
    mockFetchOk(DENY_RESPONSE);
    const mw = agentscoreMiddleware({ apiKey: API_KEY, requireKyc: true });
    const req = new Request('https://example.com/api/purchase', {
      headers: { 'x-wallet-address': WALLET },
    });

    const result = await mw(req);

    expect(result).toBeInstanceOf(Response);
    expect(result?.status).toBe(403);
  });

  it('returns missing_identity Response when no headers set', async () => {
    const mw = agentscoreMiddleware({ apiKey: API_KEY });
    const req = new Request('https://example.com/api/purchase');

    const result = await mw(req);

    expect(result?.status).toBe(403);
    const body = await result?.json();
    expect(body).toEqual({ error: 'missing_identity' });
  });
});

describe('Next.js adapter — error paths + chain', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns 403 payment_required on 402', async () => {
    mockFetchStatus(402);
    const POST = withAgentScoreGate({ apiKey: API_KEY }, async () => Response.json({ ok: true }));
    const req = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('payment_required');
  });

  it('returns 403 api_error on 500', async () => {
    mockFetchStatus(500);
    const POST = withAgentScoreGate({ apiKey: API_KEY }, async () => Response.json({ ok: true }));
    const req = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('api_error');
  });

  it('forwards constructor chain to /v1/assess body', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const POST = withAgentScoreGate({ apiKey: API_KEY, chain: 'solana' }, async () => Response.json({ ok: true }));
    const req = new Request('https://example.com/', {
      method: 'POST',
      headers: { 'x-wallet-address': WALLET },
    });
    await POST(req);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBe('solana');
  });
});
