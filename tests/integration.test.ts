import { describe, expect, it } from 'vitest';

const API_KEY = process.env.AGENTSCORE_API_KEY;
const BASE_URL = process.env.AGENTSCORE_BASE_URL || 'http://api.dev.agentscore.internal';
const TEST_ADDRESS = '0x339559a2d1cd15059365fc7bd36b3047bba480e0';

const describeIf = API_KEY ? describe : describe.skip;

describeIf('integration: real API assess response shape', () => {
  it('assess returns correct top-level shape', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();

    expect(data.decision).toBeDefined();
    expect(data.decision_reasons).toBeInstanceOf(Array);
    expect(data.identity_method).toBe('wallet');
    expect(data.operator_verification).toBeDefined();
    expect(typeof data.on_the_fly).toBe('boolean');
  });

  it('assess with compliance policy can deny', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS, policy: { require_kyc: true } }),
    });
    const data = await res.json();

    expect(data.decision).toBe('deny');
    expect(data.decision_reasons).toContain('kyc_required');
    expect(data.policy_result).toBeDefined();
    expect(data.policy_result.all_passed).toBe(false);
    expect(data.explanation).toBeInstanceOf(Array);
    expect(data.explanation.length).toBeGreaterThan(0);
    expect(data.verify_url).toBeDefined();
    expect(data.verify_url).toContain('/verify');
  });

  it('assess deny includes actionable explanation', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS, policy: { require_kyc: true } }),
    });
    const data = await res.json();

    const explanation = data.explanation[0];
    expect(explanation.rule).toBe('require_kyc');
    expect(explanation.passed).toBe(false);
    expect(explanation.how_to_remedy).toBeDefined();
    expect(typeof explanation.message).toBe('string');
  });

  it('assess without policy returns allow with no_policy_applied', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS }),
    });
    const data = await res.json();

    expect(data.decision).toBe('allow');
    expect(data.decision_reasons).toContain('no_policy_applied');
  });
});
