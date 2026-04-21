import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate } from '../src/index';
import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(walletAddress?: string): Request {
  return {
    headers: walletAddress ? { 'x-wallet-address': walletAddress } : {},
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  return { res, status, json };
}

function makeNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

const WALLET = '0xabc123';
const API_KEY = 'test-api-key';

const ALLOW_RESPONSE = {
  decision: 'allow',
  decision_reasons: [],
  subject: { chains: ['base'], address: WALLET },
  score: { value: 85, grade: 'A' },
};

const DENY_RESPONSE = {
  decision: 'deny',
  decision_reasons: ['low_score'],
  subject: { chains: ['base'], address: WALLET },
  score: { value: 20, grade: 'F' },
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

function mockFetchReject(): void {
  global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network failure'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentscoreGate factory', () => {
  it('throws when no apiKey is provided', () => {
    expect(() => agentscoreGate({ apiKey: '' })).toThrow('AgentScore API key is required');
  });

  it('returns a function when apiKey is provided', () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    expect(typeof mw).toBe('function');
  });
});

describe('agentscoreGate middleware — missing wallet address', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 when no wallet address and failOpen is false', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq();
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });

  it('calls next() when no wallet address and failOpen is true', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('agentscoreGate middleware — successful assessment', () => {
  beforeEach(() => {
    mockFetchOk(ALLOW_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls next() and attaches agentscore to req on allow decision', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as Record<string, unknown>).agentscore).toMatchObject(ALLOW_RESPONSE);
  });
});

describe('agentscoreGate middleware — denied assessment', () => {
  beforeEach(() => {
    mockFetchOk(DENY_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 with denial reason when decision is deny', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'wallet_not_trusted',
      decision: 'deny',
      reasons: ['low_score'],
    }));
  });
});

describe('agentscoreGate middleware — API error', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 api_error on fetch rejection when failOpen is false', async () => {
    mockFetchReject();
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });

  it('calls next() on fetch rejection when failOpen is true', async () => {
    mockFetchReject();
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('calls next() on HTTP 500 when failOpen is true', async () => {
    mockFetchStatus(500);
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 api_error on non-402 HTTP error when failOpen is false', async () => {
    mockFetchStatus(500);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });
});

describe('agentscoreGate middleware — 402 payment required', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 payment_required when API returns 402 and failOpen is false', async () => {
    mockFetchStatus(402);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'payment_required' }));
  });

  it('calls next() when API returns 402 and failOpen is true', async () => {
    mockFetchStatus(402);
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('agentscoreGate middleware — cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves allow result from cache on second request without calling fetch again', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = makeReq(WALLET);
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    // fetch should have been called once
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Second request — same wallet, no new fetch stub needed
    const req2 = makeReq(WALLET);
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    // fetch must not have been called again
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
  });

  it('serves deny result from cache on second request', async () => {
    mockFetchOk(DENY_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = makeReq(WALLET);
    const { res: res1, status: status1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const req2 = makeReq(WALLET);
    const { res: res2, status: status2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(status1).toHaveBeenCalledWith(403);
    expect(status2).toHaveBeenCalledWith(403);
  });
});


describe('agentscoreGate middleware — decision null/undefined treated as allow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows when decision is null', async () => {
    mockFetchOk({ ...ALLOW_RESPONSE, decision: null });
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('allows when decision field is missing (undefined)', async () => {
    const { decision: _, ...noDecision } = ALLOW_RESPONSE;
    mockFetchOk(noDecision);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('agentscoreGate middleware — chain option', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not send chain when not configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBeUndefined();
    expect(body.address).toBe(WALLET);
  });

  it('sends chain when configured', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, chain: 'base' });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.chain).toBe('base');
  });
});

describe('agentscoreGate middleware — policy fields in request body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });



  it('omits policy when no policy fields are set', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy).toBeUndefined();
  });
});

describe('agentscoreGate middleware — custom onDenied', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes custom onDenied with the denial reason', async () => {
    mockFetchOk(DENY_RESPONSE);
    const onDenied = vi.fn();
    const mw = agentscoreGate({ apiKey: API_KEY, onDenied });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(onDenied).toHaveBeenCalledOnce();
    expect(onDenied).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ code: 'wallet_not_trusted', decision: 'deny' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('sends User-Agent header with package version', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const middleware = agentscoreGate({ apiKey: 'test-key' });
    const req = makeReq('0xabc123');
    const { res } = makeRes();
    const next = makeNext();
    await middleware(req, res, next);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`@agent-score/gate@${__VERSION__}`);
  });

  it('prepends custom userAgent to the default on /v1/assess', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const middleware = agentscoreGate({ apiKey: 'test-key', userAgent: 'my-app/1.2.3' });
    const req = makeReq('0xabc123');
    const { res } = makeRes();
    const next = makeNext();
    await middleware(req, res, next);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`my-app/1.2.3 (@agent-score/gate@${__VERSION__})`);
  });

  it('prepends custom userAgent to the default on /v1/sessions', async () => {
    mockFetchOk({ session_id: 's1', verify_url: 'https://v', poll_secret: 'p' });
    const onDenied = vi.fn();
    const middleware = agentscoreGate({
      apiKey: 'test-key',
      userAgent: 'my-app/1.2.3',
      createSessionOnMissing: { apiKey: 'test-key' },
      onDenied,
    });
    const req = { headers: {} } as unknown as Parameters<typeof middleware>[0];
    const { res } = makeRes();
    const next = makeNext();
    await middleware(req, res, next);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(`my-app/1.2.3 (@agent-score/gate@${__VERSION__})`);
  });
});

describe('agentscoreGate middleware — edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 when default extractAddress receives an empty string header', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = { headers: { 'x-wallet-address': '' } } as unknown as Request;
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });


  it('handles a custom onDenied that throws without crashing the middleware', async () => {
    mockFetchOk(DENY_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      onDenied: () => { throw new Error('onDenied boom'); },
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    const result = mw(req, res, next);
    await expect(result).rejects.toThrow('onDenied boom');
  });

  it('treats 0xABC and 0xabc as the same cache key via toLowerCase', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = makeReq('0xABC');
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const req2 = makeReq('0xabc');
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
  });

  it('isolates cache between different wallets', async () => {
    const allowA = { ...ALLOW_RESPONSE, subject: { chains: ['base'], address: '0xwallet_a' } };
    const denyB = { ...DENY_RESPONSE, subject: { chains: ['base'], address: '0xwallet_b' } };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(allowA) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(denyB) } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const reqA = makeReq('0xwallet_a');
    const { res: resA } = makeRes();
    const nextA = makeNext();
    await mw(reqA, resA, nextA);

    const reqB = makeReq('0xwallet_b');
    const { res: resB, status: statusB } = makeRes();
    const nextB = makeNext();
    await mw(reqB, resB, nextB);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(nextA).toHaveBeenCalledOnce();
    expect(nextB).not.toHaveBeenCalled();
    expect(statusB).toHaveBeenCalledWith(403);
  });


  it('sends User-Agent header matching @agentscore/gate format with version', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/^@agent-score\/gate@\d+\.\d+\.\d+$/);
  });

  it('sends requireKyc as policy.require_kyc in request body', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireKyc: true,
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy).toBeDefined();
    expect(body.policy.require_kyc).toBe(true);
  });

  it('sends requireSanctionsClear as policy.require_sanctions_clear', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireSanctionsClear: true,
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.require_sanctions_clear).toBe(true);
  });

  it('sends minAge as policy.min_age', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      minAge: 90,
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.min_age).toBe(90);
  });

  it('sends blockedJurisdictions as policy.blocked_jurisdictions', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      blockedJurisdictions: ['KP', 'IR'],
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.blocked_jurisdictions).toEqual(['KP', 'IR']);
  });

  it('sends all compliance policy fields together', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireKyc: true,
      requireSanctionsClear: true,
      minAge: 21,
      blockedJurisdictions: ['KP'],
      allowedJurisdictions: ['US'],
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy).toEqual({
      require_kyc: true,
      require_sanctions_clear: true,
      min_age: 21,
      blocked_jurisdictions: ['KP'],
      allowed_jurisdictions: ['US'],
    });
  });

  it('overwrites cached deny with allow when cache expires and re-assessment succeeds', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(DENY_RESPONSE) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValueOnce(ALLOW_RESPONSE) } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 10 });

    const req1 = makeReq(WALLET);
    const { res: res1, status: status1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(status1).toHaveBeenCalledWith(403);
    expect(next1).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10001);

    const req2 = makeReq(WALLET);
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(next2).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});

describe('agentscoreGate middleware — verify_url and operator_verification in response', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const COMPLIANCE_DENY_RESPONSE = {
    decision: 'deny',
    decision_reasons: ['kyc_required', 'sanctions_check_pending'],
    subject: { chains: ['base'], address: WALLET },
    score: { value: 72, grade: 'C' },
    operator_verification: {
      level: 'none',
      operator_type: null,
      claimed_at: null,
      verified_at: null,
    },
    verify_url: 'https://agentscore.sh/verify/abc123',
    resolved_operator: '0xoperator456',
  };

  it('attaches verify_url to req.agentscore on allow with operator_verification', async () => {
    const allowWithVerification = {
      ...ALLOW_RESPONSE,
      operator_verification: {
        level: 'kyc_verified',
        operator_type: 'business',
        claimed_at: '2024-06-01T00:00:00Z',
        verified_at: '2024-06-15T00:00:00Z',
      },
    };
    mockFetchOk(allowWithVerification);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const agentscoreData = (req as unknown as Record<string, Record<string, unknown>>).agentscore;
    expect(agentscoreData.operator_verification).toEqual(allowWithVerification.operator_verification);
  });

  it('returns 403 with verify_url in onDenied call on compliance deny', async () => {
    mockFetchOk(COMPLIANCE_DENY_RESPONSE);
    const onDenied = vi.fn();
    const mw = agentscoreGate({ apiKey: API_KEY, onDenied });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        code: 'wallet_not_trusted',
        decision: 'deny',
        reasons: ['kyc_required', 'sanctions_check_pending'],
      }),
    );
  });

  it('includes verify_url in raw data cached on deny', async () => {
    mockFetchOk(COMPLIANCE_DENY_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });
    const req = makeReq(WALLET);
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const req2 = makeReq(WALLET);
    const { res: res2, status: status2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(status2).toHaveBeenCalledWith(403);
  });

  it('integration: gate middleware with compliance deny returns verify_url through onDenied', async () => {
    mockFetchOk(COMPLIANCE_DENY_RESPONSE);

    let capturedReason: Record<string, unknown> | undefined;
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireKyc: true,
      requireSanctionsClear: true,
      onDenied: (_req, res, reason) => {
        capturedReason = reason as unknown as Record<string, unknown>;
        (res as unknown as ReturnType<typeof makeRes>['res']).status(403).json({
          error: reason.code,
          verify_url: COMPLIANCE_DENY_RESPONSE.verify_url,
        });
      },
    });

    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(capturedReason).toBeDefined();
    expect(capturedReason!.code).toBe('wallet_not_trusted');
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'wallet_not_trusted',
        verify_url: 'https://agentscore.sh/verify/abc123',
      }),
    );

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.require_kyc).toBe(true);
    expect(body.policy.require_sanctions_clear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identity model: extractIdentity, operator token, backwards compat
// ---------------------------------------------------------------------------

describe('agentscoreGate — identity model', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default extractIdentity checks X-Operator-Token first', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = {
      headers: { 'x-operator-token': 'opc_abc', 'x-wallet-address': WALLET },
    } as unknown as Request;
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.operator_token).toBe('opc_abc');
    expect(body.address).toBe(WALLET);
  });

  it('default extractIdentity falls back to X-Wallet-Address when no token', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe(WALLET);
    expect(body.operator_token).toBeUndefined();
  });

  it('sends operator_token to assess API when X-Operator-Token header present', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = {
      headers: { 'x-operator-token': 'opc_test_123' },
    } as unknown as Request;
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.operator_token).toBe('opc_test_123');
    expect(body.address).toBeUndefined();
  });

  it('sends address when X-Wallet-Address present without token', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.address).toBe(WALLET);
    expect(body.operator_token).toBeUndefined();
  });

  it('returns missing_identity denial code when no identity found', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = { headers: {} } as unknown as Request;
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });

  it('calls next() on missing identity when failOpen is true', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = { headers: {} } as unknown as Request;
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('cache key uses operator token when present (lowercased)', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = {
      headers: { 'x-operator-token': 'OPC_ABC' },
    } as unknown as Request;
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const req2 = {
      headers: { 'x-operator-token': 'opc_abc' },
    } as unknown as Request;
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
  });


  it('custom extractIdentity overrides default behavior', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      extractIdentity: () => ({ operatorToken: 'opc_custom' }),
    });

    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.operator_token).toBe('opc_custom');
    expect(body.address).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSessionOnMissing
// ---------------------------------------------------------------------------

describe('agentscoreGate middleware — createSessionOnMissing', () => {
  const SESSION_RESPONSE = {
    session_id: 'sess_abc123',
    verify_url: 'https://agentscore.sh/verify/sess_abc123',
    poll_secret: 'ps_secret_456',
    agent_instructions: 'Please complete identity verification at the verify_url.',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a session and returns 403 with session data when no identity found', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(SESSION_RESPONSE),
    } as unknown as globalThis.Response);

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq();
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'identity_verification_required',
      verify_url: 'https://agentscore.sh/verify/sess_abc123',
      session_id: 'sess_abc123',
      poll_secret: 'ps_secret_456',
      agent_instructions: 'Please complete identity verification at the verify_url.',
    }));
  });

  it('calls POST /v1/sessions with the session apiKey', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(SESSION_RESPONSE),
    } as unknown as globalThis.Response);

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.agentscore.sh/v1/sessions');
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('ask_session_key');
    expect(JSON.parse(fetchCall[1].body as string)).toEqual({});
  });

  it('sends first-class session fields in POST body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(SESSION_RESPONSE),
    } as unknown as globalThis.Response);

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: {
        apiKey: 'ask_session_key',
        context: 'wine purchase',
        productName: 'Cabernet Reserve 2021',
      },
    });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body).toEqual({
      context: 'wine purchase',
      product_name: 'Cabernet Reserve 2021',
    });
  });

  it('uses custom baseUrl for session creation', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(SESSION_RESPONSE),
    } as unknown as globalThis.Response);

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key', baseUrl: 'https://custom.api.example.com' },
    });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://custom.api.example.com/v1/sessions');
  });

  it('falls back to missing_identity when session creation fails', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValueOnce({}),
    } as unknown as globalThis.Response);

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq();
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });

  it('falls back to missing_identity when session creation throws', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network failure'));

    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq();
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });

  it('does not create session when identity is present', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('/v1/assess');
    expect(url).not.toContain('/v1/sessions');
  });

  it('failOpen takes precedence over createSessionOnMissing', async () => {
    const mw = agentscoreGate({
      apiKey: API_KEY,
      failOpen: true,
      createSessionOnMissing: { apiKey: 'ask_session_key' },
    });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
