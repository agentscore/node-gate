/**
 * Payment-signer extraction (TEC-226).
 *
 * Shared between merchants and the gate — both need to recover the on-chain signer from
 * a payment credential without duplicating code. Two rails carry a wallet signer:
 *
 *   - **Tempo MPP** — `Authorization: Payment <base64>` header; credential `source` is a DID
 *     of the form `did:pkh:eip155:<chain>:<address>`.
 *   - **x402 EIP-3009** — `payment-signature` / `x-payment` header; decoded payload carries
 *     `payload.authorization.from`.
 *
 * `mppx` is an optional peer dependency — we import it dynamically so merchants who don't
 * use MPP don't need to install it. Similarly, x402 extraction is pure JSON parsing with
 * no external dep.
 */

/**
 * Recover the signer wallet address from the incoming payment credential. Returns `null` when
 * no wallet signature is present (e.g. Stripe SPT, card-only payments, or no credential yet).
 *
 * @param request - the inbound `Request`
 * @param x402PaymentHeader - the value of `payment-signature` or `x-payment` header, if any.
 *   Extracted separately because some frameworks (Express) don't expose a web `Request` object.
 */
export async function extractPaymentSignerAddress(
  request: Request,
  x402PaymentHeader?: string,
): Promise<string | null> {
  // MPP — Authorization: Payment <base64>
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    try {
      // Use a dynamic specifier to skip TS module resolution — mppx is optional.
      const moduleName = 'mppx';
      const mppx = (await import(moduleName).catch(() => null)) as {
        Credential?: {
          extractPaymentScheme: (h: string) => unknown;
          fromRequest: (r: Request) => unknown;
        };
      } | null;
      if (mppx?.Credential?.extractPaymentScheme(authHeader)) {
        const credential = mppx.Credential.fromRequest(request);
        const source = (credential as { source?: string }).source;
        const match = source?.match(/^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/);
        if (match) return match[1]!.toLowerCase();
      }
    } catch (err) {
      console.warn('[gate] MPP signer extraction failed:', err instanceof Error ? err.message : err);
    }
  }

  // x402 — base64 JSON with payload.authorization.from (EIP-3009)
  if (x402PaymentHeader) {
    try {
      // atob is globally available on Node >=16 and every web runtime we ship to.
      const decoded = atob(x402PaymentHeader);
      const parsed = JSON.parse(decoded) as { payload?: { authorization?: { from?: string } } };
      const from = parsed?.payload?.authorization?.from;
      if (typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from)) {
        return from.toLowerCase();
      }
    } catch (err) {
      console.warn('[gate] x402 signer extraction failed:', err instanceof Error ? err.message : err);
    }
  }

  return null;
}

/**
 * Read the x402 payment header from a `Request`, matching the alternate names merchants might
 * use. Falls back to reading either header directly.
 */
export function readX402PaymentHeader(request: Request): string | undefined {
  return (
    request.headers.get('payment-signature') ??
    request.headers.get('x-payment') ??
    undefined
  );
}
