import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentScoreGate, withAgentScoreGate } from '../src/adapters/web';

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

const SESSION_RESPONSE = {
  session_id: 'sess_123',
  poll_secret: 'ps_secret',
  verify_url: 'https://agentscore.sh/verify/new',
  next_steps: { action: 'deliver_verify_url_and_poll', user_message: 'Ask the user to verify' },
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

describe('Web Fetch adapter — createAgentScoreGate', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns { allowed: true, data } on allow', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const result = await guard(req);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.data).toMatchObject({ decision: 'allow' });
    }
  });

  it('returns { allowed: false, response } on deny with 403 body', async () => {
    mockFetchOk(DENY_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY, requireKyc: true });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const result = await guard(req);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body).toMatchObject({
        error: 'wallet_not_trusted',
        verify_url: 'https://agentscore.sh/verify/xyz',
      });
    }
  });

  it('returns missing_identity 403 when headers absent and no session config', async () => {
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/');

    const result = await guard(req);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toMatchObject({ error: 'missing_identity' });
    }
  });

  it('treats an empty identity object from custom extractIdentity as missing_identity', async () => {
    global.fetch = vi.fn();
    const guard = createAgentScoreGate({
      apiKey: API_KEY,
      extractIdentity: () => ({}),
    });

    const result = await guard(new Request('https://example.com/'));

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(await result.response.json()).toMatchObject({ error: 'missing_identity' });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns identity_verification_required when createSessionOnMissing is set', async () => {
    mockFetchOk(SESSION_RESPONSE);
    const guard = createAgentScoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: API_KEY, context: 'test-ctx' },
    });
    const req = new Request('https://example.com/');

    const result = await guard(req);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      const body = await result.response.json();
      expect(body).toMatchObject({
        error: 'identity_verification_required',
        session_id: 'sess_123',
        poll_secret: 'ps_secret',
      });
    }
  });

  it('strips trailing slashes from baseUrl before concatenating /v1/assess', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY, baseUrl: 'https://api.example.com///' });
    await guard(new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } }));

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.example.com/v1/assess');
  });

  it('passes an AbortSignal to /v1/assess fetch so hung requests get aborted', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    await guard(new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } }));

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('sends User-Agent with canonical package identifier', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    await guard(new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } }));

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`@agent-score/gate@${__VERSION__}`);
  });

  it('prepends userAgent to the default when configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY, userAgent: 'worker/1.0' });
    await guard(new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } }));

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers['User-Agent']).toBe(`worker/1.0 (@agent-score/gate@${__VERSION__})`);
  });

  it('fails open on 402 when failOpen is true — returns allowed with no data', async () => {
    mockFetchStatus(402);
    const guard = createAgentScoreGate({ apiKey: API_KEY, failOpen: true });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const result = await guard(req);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.data).toBeUndefined();
    }
  });

  it('honors a custom extractIdentity from options', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({
      apiKey: API_KEY,
      extractIdentity: (req) => ({ address: req.headers.get('x-custom-wallet') ?? undefined }),
    });
    await guard(new Request('https://example.com/', { headers: { 'x-custom-wallet': '0xdef456' } }));

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe('0xdef456');
  });

  it('uses custom onDenied when provided', async () => {
    mockFetchOk(DENY_RESPONSE);
    const onDenied = vi.fn((_req, reason) => Response.json({ code: reason.code }, { status: 451 }));
    const guard = createAgentScoreGate({ apiKey: API_KEY, onDenied });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const result = await guard(req);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(451);
      expect(await result.response.json()).toEqual({ code: 'wallet_not_trusted' });
    }
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
    const onDenied = vi.fn((_req, reason) => {
      captured = reason.data;
      return new Response(null, { status: 403 });
    });
    const guard = createAgentScoreGate({ apiKey: API_KEY, requireKyc: true, onDenied });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    await guard(req);

    expect(captured).toMatchObject({
      decision: 'deny',
      decision_reasons: ['kyc_required'],
      policy_result: { all_passed: false, checks: [{ rule: 'require_kyc', passed: false }] },
    });
  });
});

describe('Web Fetch adapter — withAgentScoreGate', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('invokes handler with assess data on allow', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const handler = vi.fn(async (_req: Request, gate: { data?: unknown }) =>
      Response.json({ data: gate.data }),
    );
    const wrapped = withAgentScoreGate({ apiKey: API_KEY }, handler);
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.data).toMatchObject({ decision: 'allow' });
  });

  it('returns the deny response without invoking handler', async () => {
    mockFetchOk(DENY_RESPONSE);
    const handler = vi.fn();
    const wrapped = withAgentScoreGate({ apiKey: API_KEY, requireKyc: true }, handler);
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const res = await wrapped(req);

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('binds captureWallet on allow when identity came from operator_token', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: true }) } as unknown as Response);

    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-operator-token': 'opc_test' } });

    const result = await guard(req);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.captureWallet).toBeDefined();
      await result.captureWallet!({ walletAddress: '0xsigner', network: 'evm' });
      const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(captureCall[0]).toContain('/v1/credentials/wallets');
      expect(JSON.parse(captureCall[1].body as string)).toEqual({
        operator_token: 'opc_test',
        wallet_address: '0xsigner',
        network: 'evm',
      });
    }
  });

  it('forwards idempotencyKey as snake_case idempotency_key in the body', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce({ associated: true, first_seen: false, deduped: true }) } as unknown as Response);

    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-operator-token': 'opc_test' } });
    const result = await guard(req);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      await result.captureWallet!({ walletAddress: '0xsigner', network: 'evm', idempotencyKey: 'pi_abc' });
      const captureCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      const body = JSON.parse(captureCall[1].body as string);
      expect(body.idempotency_key).toBe('pi_abc');
    }
  });

  it('leaves captureWallet undefined on allow when identity was wallet-based', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const result = await guard(req);

    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.captureWallet).toBeUndefined();
  });

  it('passes framework-specific ctx through to the handler', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const handler = vi.fn(async (_req: Request, _gate, ctx) => Response.json({ ctx }));
    const wrapped = withAgentScoreGate<{ params: { id: string } }>({ apiKey: API_KEY }, handler);
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });

    const res = await wrapped(req, { params: { id: '42' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ctx: { params: { id: '42' } } });
  });
});

describe('Web Fetch adapter — error paths + chain', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns { allowed: false } with payment_required deny reason on 402', async () => {
    mockFetchStatus(402);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });
    const result = await guard(req);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('payment_required');
    }
  });

  it('returns { allowed: false } with api_error deny reason on 500', async () => {
    mockFetchStatus(500);
    const guard = createAgentScoreGate({ apiKey: API_KEY });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });
    const result = await guard(req);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json() as { error: string };
      expect(body.error).toBe('api_error');
    }
  });

  it('fail_open allows through on 402', async () => {
    mockFetchStatus(402);
    const guard = createAgentScoreGate({ apiKey: API_KEY, failOpen: true });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });
    const result = await guard(req);
    expect(result.allowed).toBe(true);
  });

  it('fail_open allows through on 500', async () => {
    mockFetchStatus(500);
    const guard = createAgentScoreGate({ apiKey: API_KEY, failOpen: true });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });
    const result = await guard(req);
    expect(result.allowed).toBe(true);
  });

  it('forwards constructor chain to /v1/assess body', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const guard = createAgentScoreGate({ apiKey: API_KEY, chain: 'solana' });
    const req = new Request('https://example.com/', { headers: { 'x-wallet-address': WALLET } });
    await guard(req);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBe('solana');
  });
});
