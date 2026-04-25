import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../src/signer';

const SIGNER_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01';
const SIGNER_MIXED = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';

// Monotonic cache-bust for dynamic imports. Using `Date.now()` would collide when
// two tests run within the same millisecond (likely on fast CPUs or under CI load),
// which would share a cached module and break the vi.doMock state — flake.
let _importCounter = 0;
const freshImportKey = () => `${Date.now()}-${++_importCounter}`;

afterEach(() => {
  vi.restoreAllMocks();
});

const encodeX402 = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64');

const makeRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://example.com/purchase', { headers });

describe('readX402PaymentHeader', () => {
  it('returns the payment-signature header when present', () => {
    const req = makeRequest({ 'payment-signature': 'abc' });
    expect(readX402PaymentHeader(req)).toBe('abc');
  });

  it('falls back to x-payment when payment-signature is absent', () => {
    const req = makeRequest({ 'x-payment': 'xyz' });
    expect(readX402PaymentHeader(req)).toBe('xyz');
  });

  it('prefers payment-signature over x-payment when both are set', () => {
    const req = makeRequest({ 'payment-signature': 'first', 'x-payment': 'second' });
    expect(readX402PaymentHeader(req)).toBe('first');
  });

  it('returns undefined when neither header is present', () => {
    expect(readX402PaymentHeader(makeRequest())).toBeUndefined();
  });
});

describe('extractPaymentSignerAddress — x402 path', () => {
  it('returns the lowercased `from` address from a valid x402 payload', async () => {
    const req = makeRequest();
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    const result = await extractPaymentSignerAddress(req, header);
    expect(result).toBe(SIGNER_LOWER);
  });

  it('returns null when the x402 payload is not valid base64 JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await extractPaymentSignerAddress(makeRequest(), '!!!not-base64!!!');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when `payload.authorization.from` is missing', async () => {
    const header = encodeX402({ payload: { authorization: {} } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBeNull();
  });

  it('returns null when `from` is not a valid 0x-prefixed address', async () => {
    const header = encodeX402({ payload: { authorization: { from: 'not-a-wallet' } } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBeNull();
  });

  it('returns null when neither header nor x402 payload is supplied', async () => {
    expect(await extractPaymentSignerAddress(makeRequest(), undefined)).toBeNull();
  });
});

describe('extractPaymentSignerAddress — MPP path', () => {
  // mppx is an optional peer dep and is not installed in the gate's test env. The dynamic
  // import resolves to null and the helper falls through, leaving MPP extraction a no-op
  // for merchants who don't opt in to MPP.
  it('returns null when Authorization: Payment is set but mppx is unavailable', async () => {
    const req = makeRequest({ authorization: 'Payment some-mpp-credential' });
    expect(await extractPaymentSignerAddress(req)).toBeNull();
  });

  it('returns null when the Authorization header is not the Payment scheme', async () => {
    const req = makeRequest({ authorization: 'Bearer unrelated-token' });
    expect(await extractPaymentSignerAddress(req)).toBeNull();
  });

  it('prefers MPP when both MPP and x402 are present, falling back to x402 on MPP miss', async () => {
    // Because mppx is unavailable, MPP path yields null and the x402 path runs instead.
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await extractPaymentSignerAddress(req, header)).toBe(SIGNER_LOWER);
  });

  it('extracts the lowercased 0x address from an MPP DID (did:pkh:eip155:...)', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: `did:pkh:eip155:8453:${SIGNER_MIXED}` }),
      },
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    const result = await freshExtract(req);
    expect(result).toBe(SIGNER_LOWER);
    vi.doUnmock('mppx');
  });

  it('returns null when the MPP credential source is not a did:pkh:eip155 shape', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => true,
        fromRequest: () => ({ source: 'did:web:example.com' }),
      },
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp-nonevm=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await freshExtract(req)).toBeNull();
    vi.doUnmock('mppx');
  });

  it('logs and falls through when mppx throws during extraction', async () => {
    vi.doMock('mppx', () => ({
      Credential: {
        extractPaymentScheme: () => { throw new Error('mpp parse failed'); },
        fromRequest: () => ({}),
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?mpp-throw=${freshImportKey()}`
    );
    const req = makeRequest({ authorization: 'Payment mpp-cred' });
    expect(await freshExtract(req)).toBeNull();
    expect(warn).toHaveBeenCalled();
    vi.doUnmock('mppx');
  });
});

describe('extractPaymentSignerAddress — Solana x402 path', () => {
  // The Solana branch is selected when `accepted.network` starts with `solana:`. It
  // dynamic-imports `@x402/svm` (optional peer dep) and recovers the SPL Token payer
  // from the encoded transaction. Critically: payer is base58 and case-sensitive — we
  // return it verbatim, never lowercase.
  const SOL_PAYER = 'G2ajX7CrLGoaL8ncaDYNCQoV9b7XhwGF1RzAyKDEZgNZ';

  it('extracts the case-preserved Solana payer when @x402/svm is available', async () => {
    vi.doMock('@x402/svm', () => ({
      decodeTransactionFromPayload: vi.fn(() => ({})),
      getTokenPayerFromTransaction: vi.fn(() => SOL_PAYER),
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?svm=${freshImportKey()}`
    );
    const header = encodeX402({
      accepted: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
      payload: { transaction: Buffer.from('not-a-real-tx').toString('base64') },
    });
    const result = await freshExtract(makeRequest(), header);
    expect(result).toBe(SOL_PAYER);
    // Verbatim case — Solana would silently break if we lowercased here.
    expect(result).not.toBe(SOL_PAYER.toLowerCase());
    vi.doUnmock('@x402/svm');
  });

  it('returns null on a Solana payload when @x402/svm is unavailable (graceful when peer dep absent)', async () => {
    const header = encodeX402({
      accepted: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
      payload: { transaction: Buffer.from('any-tx').toString('base64') },
    });
    // No vi.doMock for @x402/svm — the dynamic import resolves to null in the test env.
    const result = await extractPaymentSignerAddress(makeRequest(), header);
    expect(result).toBeNull();
  });

  it('returns null on a Solana payload missing the transaction field', async () => {
    vi.doMock('@x402/svm', () => ({
      decodeTransactionFromPayload: vi.fn(),
      getTokenPayerFromTransaction: vi.fn(),
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?svm-missing-tx=${freshImportKey()}`
    );
    const header = encodeX402({
      accepted: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
      payload: {},
    });
    expect(await freshExtract(makeRequest(), header)).toBeNull();
    vi.doUnmock('@x402/svm');
  });

  it('returns null when @x402/svm returns no payer (malformed Solana transaction)', async () => {
    vi.doMock('@x402/svm', () => ({
      decodeTransactionFromPayload: vi.fn(() => ({})),
      getTokenPayerFromTransaction: vi.fn(() => undefined),
    }));
    const { extractPaymentSignerAddress: freshExtract } = await import(
      `../src/signer?svm-no-payer=${freshImportKey()}`
    );
    const header = encodeX402({
      accepted: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
      payload: { transaction: Buffer.from('tx').toString('base64') },
    });
    expect(await freshExtract(makeRequest(), header)).toBeNull();
    vi.doUnmock('@x402/svm');
  });

  it('takes the EIP-3009 branch (not Solana) when network is eip155:*', async () => {
    const header = encodeX402({
      accepted: { network: 'eip155:84532' },
      payload: { authorization: { from: SIGNER_MIXED } },
    });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBe(SIGNER_LOWER);
  });

  it('falls back to legacy EIP-3009 extraction when accepted.network is missing (back-compat)', async () => {
    // Older x402 clients (pre-multi-network) didn't emit `accepted.network`. We still
    // extract `payload.authorization.from` if it looks EVM — preserves wallet-auth on
    // those clients without forcing them to upgrade.
    const header = encodeX402({ payload: { authorization: { from: SIGNER_MIXED } } });
    expect(await extractPaymentSignerAddress(makeRequest(), header)).toBe(SIGNER_LOWER);
  });
});
