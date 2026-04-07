import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate } from '../src/index';
import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Source-code reading sanity checks
// ---------------------------------------------------------------------------

const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
const cacheSrc = readFileSync(new URL('../src/cache.ts', import.meta.url), 'utf-8');

describe('source code structure', () => {
  it('exports agentscoreGate factory', () => {
    expect(indexSrc).toContain('export function agentscoreGate');
  });

  it('DenialReason includes verify_url field', () => {
    expect(indexSrc).toContain('verify_url?: string');
  });

  it('TTLCache has sweep and evictOldest methods', () => {
    expect(cacheSrc).toContain('private sweep');
    expect(cacheSrc).toContain('private evictOldest');
  });

  it('middleware sends User-Agent header with package version', () => {
    expect(indexSrc).toContain('User-Agent');
    expect(indexSrc).toContain('agentscore-gate-node');
  });

  it('defaultOnDenied includes verify_url in response body', () => {
    expect(indexSrc).toContain('reason.verify_url');
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
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_wallet_address' }));
  });

  it('extractAddress returning undefined triggers missing_wallet_address when failOpen is false', async () => {
    const mw = agentscoreGate({
      apiKey: API_KEY,
      extractAddress: () => undefined,
    });
    const req = makeReq(WALLET);
    const { res, status, json } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_wallet_address' }));
  });

  it('extractAddress returning empty string triggers missing_wallet_address', async () => {
    const mw = agentscoreGate({
      apiKey: API_KEY,
      extractAddress: () => '',
    });
    const req = makeReq(WALLET);
    const { res, status } = makeRes();
    const next = makeNext();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
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

  it('fails open on missing_wallet_address when failOpen is true', async () => {
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
