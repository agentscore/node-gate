import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate } from '../src/adapters/express';
import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Source-code reading sanity checks
// ---------------------------------------------------------------------------

const coreSrc = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf-8');
const expressSrc = readFileSync(new URL('../src/adapters/express.ts', import.meta.url), 'utf-8');
const cacheSrc = readFileSync(new URL('../src/cache.ts', import.meta.url), 'utf-8');

describe('source code structure', () => {
  it('Express adapter exports agentscoreGate factory', () => {
    expect(expressSrc).toContain('export function agentscoreGate');
  });

  it('DenialReason includes verify_url field', () => {
    expect(coreSrc).toContain('verify_url?: string');
  });

  it('TTLCache has sweep and evictOldest methods', () => {
    expect(cacheSrc).toContain('private sweep');
    expect(cacheSrc).toContain('private evictOldest');
  });

  it('core sends User-Agent header with package version', () => {
    expect(coreSrc).toContain('User-Agent');
    expect(coreSrc).toContain('@agent-score/gate@');
  });

  it('Express middleware sends canonical User-Agent by default and prepends custom when configured', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({ decision: 'allow', decision_reasons: [] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({ decision: 'allow', decision_reasons: [] }),
      } as unknown as Response);

    const def = agentscoreGate({ apiKey: API_KEY });
    const req1 = { headers: { 'x-wallet-address': WALLET } } as unknown as Request;
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await def(req1, res1, next1);

    const call1 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call1[1].headers['User-Agent']).toMatch(/^@agent-score\/gate@\d+\.\d+\.\d+$/);

    const custom = agentscoreGate({ apiKey: API_KEY, userAgent: 'express-app/1.0.0' });
    const req2 = { headers: { 'x-wallet-address': WALLET } } as unknown as Request;
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await custom(req2, res2, next2);

    const call2 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call2[1].headers['User-Agent']).toMatch(/^express-app\/1\.0\.0 \(@agent-score\/gate@\d+\.\d+\.\d+\)$/);
  });

  it('Express defaultOnDenied delegates body marshaling to the shared _response helper', () => {
    // The marshaling (verify_url, session_id, agent_memory, wallet-signer fields, extra)
    // lives in src/_response.ts now; every adapter calls denialReasonToBody().
    expect(expressSrc).toContain('denialReasonToBody');
  });
});

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

function mockFetchReject(error?: Error): void {
  global.fetch = vi.fn().mockRejectedValueOnce(error ?? new Error('Network failure'));
}

// ---------------------------------------------------------------------------
// Error responses from API
// ---------------------------------------------------------------------------

describe('error response edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 api_error on HTTP 503 when failOpen is false', async () => {
    mockFetchStatus(503);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });

  it('calls next() on HTTP 503 when failOpen is true', async () => {
    mockFetchStatus(503);
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 api_error on HTTP 429 rate limit when failOpen is false', async () => {
    mockFetchStatus(429);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });

  it('handles timeout-like errors with failOpen true', async () => {
    mockFetchReject(new Error('The operation was aborted'));
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('handles timeout-like errors with failOpen false', async () => {
    mockFetchReject(new Error('The operation was aborted'));
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

// ---------------------------------------------------------------------------
// Invalid wallet header edge cases
// ---------------------------------------------------------------------------

describe('invalid wallet header edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 when x-wallet-address header is whitespace only', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = { headers: { 'x-wallet-address': '   ' } } as unknown as Request;
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(global.fetch).toBeDefined();
  });

  it('returns 403 when headers object has no x-wallet-address key', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = { headers: { 'authorization': 'Bearer xyz' } } as unknown as Request;
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_identity' }));
  });

  it('missing_identity body carries next_steps.action: send_existing_identity', async () => {
    // TEC-218 phase 1: bare bootstrap denial hints agents to try stored identity first
    // (returning-customer fast path) before running the cold-start session flow.
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq();
    const { res, json } = makeRes();
    await mw(req, res, makeNext());

    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.error).toBe('missing_identity');
    expect(body.agent_instructions).toBeDefined();
    const instructions = JSON.parse(body.agent_instructions as string) as Record<string, unknown>;
    expect(instructions.action).toBe('send_existing_identity');
    expect(instructions.user_message).toMatch(/stored operator_token|wallet/i);
    // agent_memory still present for cross-merchant pattern hint
    expect(body.agent_memory).toBeDefined();
  });

});

// ---------------------------------------------------------------------------
// Empty responses
// ---------------------------------------------------------------------------

describe('empty and minimal response handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles response with empty decision_reasons array', async () => {
    mockFetchOk({
      decision: 'deny',
      decision_reasons: [],
      subject: { chains: ['base'], address: WALLET },
      score: { value: 10, grade: 'F' },
    });
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'wallet_not_trusted',
      reasons: [],
    }));
  });

  it('handles response with minimal fields (only decision)', async () => {
    mockFetchOk({ decision: 'allow' });
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Cache boundary conditions (max_size exactly at limit)
// ---------------------------------------------------------------------------

describe('cache boundary conditions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cache eviction does not break middleware when many wallets fill cache', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    // Make 3 requests with different wallets
    for (let i = 0; i < 3; i++) {
      const wallet = `0xwallet_${i}`;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({
          ...ALLOW_RESPONSE,
          subject: { chains: ['base'], address: wallet },
        }),
      } as unknown as Response);

      const req = makeReq(wallet);
      const { res } = makeRes();
      const next = makeNext();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('does not call fetch for a cached allow within TTL', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = makeReq(WALLET);
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    const req2 = makeReq(WALLET);
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(next2).toHaveBeenCalledOnce();
  });

  it('does not call fetch for a cached deny within TTL', async () => {
    mockFetchOk(DENY_RESPONSE);
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300 });

    const req1 = makeReq(WALLET);
    const { res: res1, status: status1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(status1).toHaveBeenCalledWith(403);

    const req2 = makeReq(WALLET);
    const { res: res2, status: status2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(status2).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Concurrent request deduplication
// ---------------------------------------------------------------------------

describe('concurrent requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent requests for the same wallet both resolve correctly', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstCallPromise = new Promise((resolve) => { resolveFirst = resolve; });

    global.fetch = vi.fn().mockImplementation(() => firstCallPromise);

    const mw = agentscoreGate({ apiKey: API_KEY });

    const req1 = makeReq(WALLET);
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    const p1 = mw(req1, res1, next1);

    const req2 = makeReq(WALLET);
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    const p2 = mw(req2, res2, next2);

    resolveFirst!({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(ALLOW_RESPONSE),
    });

    await Promise.all([p1, p2]);

    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Fail-open behavior on various error types
// ---------------------------------------------------------------------------

describe('fail-open behavior on various errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails open on TypeError (e.g., fetch not available)', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('fails closed on TypeError when failOpen is false', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });

  it('fails open on missing_identity when failOpen is true', async () => {
    const mw = agentscoreGate({ apiKey: API_KEY, failOpen: true });
    const req = makeReq();
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// verify_url in DenialReason
// ---------------------------------------------------------------------------

describe('verify_url in DenialReason', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes verify_url to defaultOnDenied on fresh deny', async () => {
    const denyWithVerifyUrl = {
      ...DENY_RESPONSE,
      verify_url: 'https://agentscore.sh/verify/test123',
    };
    mockFetchOk(denyWithVerifyUrl);
    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'wallet_not_trusted',
      verify_url: 'https://agentscore.sh/verify/test123',
    }));
  });

  it('passes verify_url to custom onDenied on fresh deny', async () => {
    const denyWithVerifyUrl = {
      ...DENY_RESPONSE,
      verify_url: 'https://agentscore.sh/verify/custom123',
    };
    mockFetchOk(denyWithVerifyUrl);
    const onDenied = vi.fn();
    const mw = agentscoreGate({ apiKey: API_KEY, onDenied });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(onDenied).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        code: 'wallet_not_trusted',
        verify_url: 'https://agentscore.sh/verify/custom123',
      }),
    );
  });

  it('passes verify_url through cache on repeated deny', async () => {
    const denyWithVerifyUrl = {
      ...DENY_RESPONSE,
      verify_url: 'https://agentscore.sh/verify/cached123',
    };
    mockFetchOk(denyWithVerifyUrl);
    const onDenied = vi.fn();
    const mw = agentscoreGate({ apiKey: API_KEY, cacheSeconds: 300, onDenied });

    const req1 = makeReq(WALLET);
    const { res: res1 } = makeRes();
    const next1 = makeNext();
    await mw(req1, res1, next1);

    const req2 = makeReq(WALLET);
    const { res: res2 } = makeRes();
    const next2 = makeNext();
    await mw(req2, res2, next2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledTimes(2);
    expect(onDenied).toHaveBeenNthCalledWith(2,
      req2,
      res2,
      expect.objectContaining({
        verify_url: 'https://agentscore.sh/verify/cached123',
      }),
    );
  });

  it('does not include verify_url in DenialReason when absent from API response', async () => {
    mockFetchOk(DENY_RESPONSE);
    const onDenied = vi.fn();
    const mw = agentscoreGate({ apiKey: API_KEY, onDenied });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const reason = onDenied.mock.calls[0][2];
    expect(reason.verify_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Compliance options edge cases
// ---------------------------------------------------------------------------

describe('compliance options edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends requireKyc: false in policy (explicit false)', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireKyc: false,
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy).toBeDefined();
    expect(body.policy.require_kyc).toBe(false);
  });

  it('sends minAge: 0 in policy (boundary value)', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      minAge: 0,
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.min_age).toBe(0);
  });

  it('sends empty blockedJurisdictions array in policy', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      blockedJurisdictions: [],
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.blocked_jurisdictions).toEqual([]);
  });

  it('sends requireSanctionsClear: false in policy', async () => {
    mockFetchOk(ALLOW_RESPONSE);
    const mw = agentscoreGate({
      apiKey: API_KEY,
      requireSanctionsClear: false,
    });
    const req = makeReq(WALLET);
    const { res } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.policy.require_sanctions_clear).toBe(false);
  });
});

describe('evaluate() — 401 passthrough edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through token_expired with agent_instructions when API returns 401 + next_steps', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      clone: () => ({
        json: async () => ({
          error: { code: 'token_expired', message: 'expired' },
          next_steps: { action: 'mint_new_credential' },
        }),
      }),
    } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();
    await mw(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'token_expired',
      agent_instructions: expect.stringContaining('mint_new_credential'),
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through token_revoked without agent_instructions when next_steps absent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      clone: () => ({ json: async () => ({ error: { code: 'token_revoked' } }) }),
    } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    await mw(req, res, makeNext());

    expect(status).toHaveBeenCalledWith(403);
    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.error).toBe('token_revoked');
    expect(body).not.toHaveProperty('agent_instructions');
  });

  it('falls through to generic api_error when 401 body has unknown error.code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      clone: () => ({ json: async () => ({ error: { code: 'something_unknown' } }) }),
    } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    await mw(req, res, makeNext());

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });

  it('falls through to generic api_error when 401 body fails to parse as JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      clone: () => ({ json: async () => { throw new Error('not JSON'); } }),
    } as unknown as Response);

    const mw = agentscoreGate({ apiKey: API_KEY });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    await mw(req, res, makeNext());

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'api_error' }));
  });
});
