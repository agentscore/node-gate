import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentscoreGate, verifyWalletSignerMatch } from '../src/adapters/hono';
import { createAgentScoreCore } from '../src/core';

const API_KEY = 'test-api-key';

function mockFetchSequence(responses: unknown[]): void {
  const mock = vi.fn();
  for (const body of responses) {
    mock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce(body),
    } as unknown as Response);
  }
  global.fetch = mock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAgentMemoryHint', () => {
  it('surfaces on identity_verification_required denials through the hono adapter', async () => {
    // First fetch: POST /v1/sessions → session created (triggers identity_verification_required)
    mockFetchSequence([
      {
        session_id: 'sess_abc',
        poll_secret: 'poll_abc',
        verify_url: 'https://agentscore.sh/verify?session=sess_abc',
        poll_url: 'https://api.agentscore.sh/v1/sessions/sess_abc',
        expires_at: '2026-04-24T00:00:00Z',
      },
    ]);

    const app = new Hono();
    app.use('*', agentscoreGate({
      apiKey: API_KEY,
      createSessionOnMissing: { apiKey: API_KEY },
    }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(body.error).toBe('identity_verification_required');
    expect(body.agent_memory).toBeDefined();
    const memory = body.agent_memory as Record<string, unknown>;
    expect(memory.save_for_future_agentscore_gates).toBe(true);
    expect(memory.pattern_summary).toContain('AgentScore');
    expect(memory.identity_paths).toBeDefined();
    expect((memory.identity_paths as Record<string, string>).wallet).toContain('X-Wallet-Address');
    expect((memory.identity_paths as Record<string, string>).operator_token).toContain('X-Operator-Token');
    expect(memory.do_not_persist_in_memory).toContain('operator_token');
  });

  it('surfaces on bare missing_identity denials', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('/test');
    const body = await res.json() as Record<string, unknown>;

    expect(body.error).toBe('missing_identity');
    expect(body.agent_memory).toBeDefined();
  });
});

describe('AgentScoreCore.verifyWalletSignerMatch', () => {
  const WALLET_A = '0x1111111111111111111111111111111111111111';
  const WALLET_B = '0x2222222222222222222222222222222222222222';

  it('returns pass (byte-equal) without any /v1/assess lookup', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: WALLET_A,
    });

    expect(result.kind).toBe('pass');
    // Only the fire-and-forget telemetry call is allowed — no /v1/assess lookup.
    const assessCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/v1/assess'),
    );
    expect(assessCalls).toHaveLength(0);
  });

  it('returns pass when both wallets resolve to the same operator', async () => {
    mockFetchSequence([
      { resolved_operator: 'op_123', decision: 'allow' },
      { resolved_operator: 'op_123', decision: 'allow' },
    ]);
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: WALLET_B,
    });

    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.claimedOperator).toBe('op_123');
      expect(result.signerOperator).toBe('op_123');
    }
  });

  it('returns wallet_signer_mismatch when operators differ', async () => {
    mockFetchSequence([
      { resolved_operator: 'op_claimed', decision: 'allow' },
      { resolved_operator: 'op_signer', decision: 'allow' },
    ]);
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: WALLET_B,
    });

    expect(result.kind).toBe('wallet_signer_mismatch');
    if (result.kind === 'wallet_signer_mismatch') {
      expect(result.claimedOperator).toBe('op_claimed');
      expect(result.actualSignerOperator).toBe('op_signer');
      expect(result.expectedSigner).toBe(WALLET_A.toLowerCase());
      expect(result.actualSigner).toBe(WALLET_B.toLowerCase());
    }
  });

  it('returns wallet_signer_mismatch when signer resolves to null operator (unlinked)', async () => {
    mockFetchSequence([
      { resolved_operator: 'op_claimed', decision: 'allow' },
      { resolved_operator: null, decision: 'deny' },
    ]);
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: WALLET_B,
    });

    expect(result.kind).toBe('wallet_signer_mismatch');
    if (result.kind === 'wallet_signer_mismatch') {
      expect(result.actualSignerOperator).toBeNull();
    }
  });

  it('returns wallet_auth_requires_wallet_signing when signer is null (SPT/card)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: null,
    });

    expect(result.kind).toBe('wallet_auth_requires_wallet_signing');
    if (result.kind === 'wallet_auth_requires_wallet_signing') {
      expect(result.claimedWallet).toBe(WALLET_A);
    }
    // No /v1/assess lookup — only the fire-and-forget telemetry ping is allowed.
    const assessCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/v1/assess'),
    );
    expect(assessCalls).toHaveLength(0);
  });

  it('returns api_error on transient resolve failure — does not conflate with mismatch', async () => {
    // Simulate /v1/assess returning 503 for both resolve calls.
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
    const core = createAgentScoreCore({ apiKey: API_KEY });

    const result = await core.verifyWalletSignerMatch({
      claimedWallet: WALLET_A,
      signer: WALLET_B,
    });

    expect(result.kind).toBe('api_error');
    if (result.kind === 'api_error') {
      expect(result.claimedWallet).toBe(WALLET_A.toLowerCase());
    }
  });
});

describe('AgentScoreCore.verifyWalletSignerMatch — telemetry', () => {
  const TELEMETRY_WALLET = '0x1111111111111111111111111111111111111111';

  it('fire-and-forget posts the kind to /v1/telemetry/signer-match', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    global.fetch = fetchMock;
    const core = createAgentScoreCore({ apiKey: API_KEY });

    await core.verifyWalletSignerMatch({ claimedWallet: TELEMETRY_WALLET, signer: TELEMETRY_WALLET });

    const telemetryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/v1/telemetry/signer-match'),
    );
    expect(telemetryCalls).toHaveLength(1);
    const body = JSON.parse(telemetryCalls[0]![1]!.body as string) as { kind: string };
    expect(body.kind).toBe('pass');
  });

  it('reports wallet_auth_requires_wallet_signing on null signer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    global.fetch = fetchMock;
    const core = createAgentScoreCore({ apiKey: API_KEY });

    await core.verifyWalletSignerMatch({ claimedWallet: TELEMETRY_WALLET, signer: null });

    const telemetryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/v1/telemetry/signer-match'),
    );
    expect(telemetryCalls).toHaveLength(1);
    const body = JSON.parse(telemetryCalls[0]![1]!.body as string) as { kind: string };
    expect(body.kind).toBe('wallet_auth_requires_wallet_signing');
  });

  it('telemetry failure never throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('telemetry outage'));
    const core = createAgentScoreCore({ apiKey: API_KEY });

    // Must not throw — gate decision is independent of telemetry.
    const result = await core.verifyWalletSignerMatch({ claimedWallet: TELEMETRY_WALLET, signer: TELEMETRY_WALLET });
    expect(result.kind).toBe('pass');
  });
});

describe('AgentScoreCore.verifyWalletSignerMatch — Section IV (both headers)', () => {
  it('hono adapter no-ops signer check when both headers sent', async () => {
    // Simulate a request with both X-Operator-Token and X-Wallet-Address — token should win
    // and the wrapper must not run a signer check at all.
    const { Hono } = await import('hono');
    const { agentscoreGate, verifyWalletSignerMatch } = await import('../src/adapters/hono');

    // Gate allow on the operator token.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_token_holder',
      }),
    } as unknown as Response);

    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', async (c) => {
      // A signer that would NOT match the wallet — if signer check ran, it would reject.
      const result = await verifyWalletSignerMatch(c, { signer: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
      return c.json(result);
    });

    const res = await app.request('/test', {
      headers: {
        'x-operator-token': 'opc_test',
        'x-wallet-address': '0xaaa0000000000000000000000000000000000000',
      },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.kind).toBe('pass');
    expect(body.claimedOperator).toBeNull();
  });
});

describe('buildAgentMemoryHint — hardcoded canonical URLs', () => {
  it('ignores merchant baseUrl to prevent cross-merchant phishing', async () => {
    const { buildAgentMemoryHint } = await import('../src/core');
    // Even if a malicious merchant configured their gate with baseUrl pointing at their own
    // evil endpoint, the agent memory must always advertise the canonical AgentScore API so
    // an agent following the memory hint doesn't leak credentials to a rogue merchant.
    const hint = buildAgentMemoryHint('https://evil.example.com');
    expect(hint.identity_check_endpoint).toBe('https://api.agentscore.sh/v1/credentials');
    expect(hint.list_wallets_endpoint).toBe('https://api.agentscore.sh/v1/credentials/wallets');
  });
});

describe('verifyWalletSignerMatch hono helper', () => {
  beforeEach(() => {
    // Allow-mock for the gate's initial /v1/assess so requests pass through.
    global.fetch = vi.fn().mockImplementation(async (_url: string, opts: unknown) => {
      const body = JSON.parse((opts as { body: string }).body) as Record<string, unknown>;
      const wallet = (body.address as string | undefined)?.toLowerCase();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          decision: 'allow',
          decision_reasons: [],
          resolved_operator: wallet === '0xaaa0000000000000000000000000000000000000' ? 'op_victim' : 'op_attacker',
        }),
      } as unknown as Response;
    });
  });

  it('returns pass when request is operator-token authenticated (no-op)', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', async (c) => {
      const result = await verifyWalletSignerMatch(c, { signer: '0xwhatever' });
      return c.json(result);
    });

    const res = await app.request('/test', { headers: { 'x-operator-token': 'opc_test' } });
    const body = await res.json() as Record<string, unknown>;
    expect(body.kind).toBe('pass');
    expect(body.claimedOperator).toBeNull();
  });

  it('returns wallet_signer_mismatch when signer differs from claimed wallet operator', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', async (c) => {
      const result = await verifyWalletSignerMatch(c, { signer: '0xbbb0000000000000000000000000000000000000' });
      return c.json(result);
    });

    const res = await app.request('/test', {
      headers: { 'x-wallet-address': '0xaaa0000000000000000000000000000000000000' },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.kind).toBe('wallet_signer_mismatch');
    expect(body.claimedOperator).toBe('op_victim');
    expect(body.actualSignerOperator).toBe('op_attacker');
  });

  it('returns wallet_auth_requires_wallet_signing when signer null on wallet-auth request', async () => {
    const app = new Hono();
    app.use('*', agentscoreGate({ apiKey: API_KEY }));
    app.get('/test', async (c) => {
      const result = await verifyWalletSignerMatch(c, { signer: null });
      return c.json(result);
    });

    const res = await app.request('/test', {
      headers: { 'x-wallet-address': '0xaaa0000000000000000000000000000000000000' },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.kind).toBe('wallet_auth_requires_wallet_signing');
  });
});

// ---------------------------------------------------------------------------
// Per-adapter no-op parity — operator-token wins when both headers are sent.
// Each adapter has its own state-stashing location; verify the wrapper reads it
// correctly and short-circuits before any API call.
// ---------------------------------------------------------------------------

describe('verifyWalletSignerMatch adapter parity — both headers no-op', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        decision: 'allow',
        decision_reasons: [],
        resolved_operator: 'op_token_holder',
      }),
    } as unknown as Response);
  });

  it('express adapter no-ops when both headers sent', async () => {
    const { agentscoreGate: expressGate, verifyWalletSignerMatch: expressVerify } =
      await import('../src/adapters/express');

    const mw = expressGate({ apiKey: API_KEY });
    const req = {
      headers: {
        'x-operator-token': 'opc_test',
        'x-wallet-address': '0xaaa0000000000000000000000000000000000000',
      },
    } as unknown as import('express').Request;
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }) } as unknown as import('express').Response;
    const next = vi.fn();
    await mw(req, res, next);

    // Any signer — if the no-op weren't honored, this would mismatch against the claimed wallet.
    const result = await expressVerify(req, { signer: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(result.kind).toBe('pass');
    expect((result as { claimedOperator: string | null }).claimedOperator).toBeNull();
  });

  it('fastify adapter no-ops when both headers sent', async () => {
    const fastifyMod = await import('fastify').catch(() => null);
    if (!fastifyMod) { return; } // skip if fastify not installed in this env
    const { default: Fastify } = fastifyMod;
    const { agentscoreGate: fastifyPlugin, verifyWalletSignerMatch: fastifyVerify } =
      await import('../src/adapters/fastify');

    const app = Fastify();
    await app.register(fastifyPlugin, { apiKey: API_KEY });
    app.get('/test', async (req) => {
      const result = await fastifyVerify(req, { signer: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
      return result;
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        'x-operator-token': 'opc_test',
        'x-wallet-address': '0xaaa0000000000000000000000000000000000000',
      },
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.kind).toBe('pass');
    expect(body.claimedOperator).toBeNull();
    await app.close();
  });

  it('web (fetch) adapter does not bind verifyWalletSignerMatch when both headers sent', async () => {
    // Web adapter's no-op is to NOT bind the helper at all on operator-token requests.
    // Consumers check for `verifyWalletSignerMatch` undefined before calling.
    const { createAgentScoreGate } = await import('../src/adapters/web');
    const guard = createAgentScoreGate({ apiKey: API_KEY });

    const req = new Request('http://localhost/test', {
      headers: {
        'x-operator-token': 'opc_test',
        'x-wallet-address': '0xaaa0000000000000000000000000000000000000',
      },
    });
    const outcome = await guard(req);
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.verifyWalletSignerMatch).toBeUndefined();
    }
  });
});
