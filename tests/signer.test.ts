import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPaymentSignerAddress, readX402PaymentHeader } from '../src/signer';

const SIGNER_LOWER = '0xabcdef0123456789abcdef0123456789abcdef01';
const SIGNER_MIXED = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';

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
});
