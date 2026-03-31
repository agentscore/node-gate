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

    expect(data.subject.chains).toBeInstanceOf(Array);
    expect(data.subject.chains.length).toBeGreaterThan(0);

    expect(typeof data.score.value).toBe('number');
    expect(typeof data.score.grade).toBe('string');
    expect(data.score.status).toBeDefined();
    expect(data.score.version).toBeDefined();
    expect(data.score.confidence).toBeUndefined();
    expect(data.score.dimensions).toBeUndefined();

    expect(data.chains).toBeInstanceOf(Array);
    expect(data.chains.length).toBeGreaterThan(0);

    expect(data.decision).toBeDefined();
    expect(data.decision_reasons).toBeInstanceOf(Array);
    expect(data.agents).toBeInstanceOf(Array);
    expect(data.caveats).toBeInstanceOf(Array);
    expect(data.data_semantics).toBeDefined();
    expect(data.updated_at).toBeDefined();

    expect(data.classification).toBeUndefined();
  });

  it('assess chain entry has full per-chain data', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS }),
    });
    const data = await res.json();
    const chain = data.chains[0];

    expect(chain.score.confidence).toBeDefined();
    expect(chain.score.dimensions).toBeDefined();
    expect(chain.classification).toBeDefined();
    expect(chain.classification.entity_type).toBeDefined();
    expect(chain.identity).toBeDefined();
    expect(chain.activity).toBeDefined();
    expect(chain.activity.as_verified_payer).toBeDefined();
    expect(chain.activity.active_days).toBeDefined();
    expect(chain.evidence_summary).toBeDefined();
  });

  it('assess with policy can deny', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS, policy: { min_score: 999 } }),
    });
    const data = await res.json();

    expect(data.decision).toBe('deny');
    expect(data.decision_reasons.length).toBeGreaterThan(0);
  });

  it('assess includes operator_score when agents exist', async () => {
    const res = await fetch(`${BASE_URL}/v1/assess`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: TEST_ADDRESS }),
    });
    const data = await res.json();

    if (data.operator_score) {
      expect(typeof data.operator_score.score).toBe('number');
      expect(typeof data.operator_score.grade).toBe('string');
      expect(typeof data.operator_score.agent_count).toBe('number');
      expect(data.operator_score.chains_active).toBeInstanceOf(Array);
    }
  });
});
