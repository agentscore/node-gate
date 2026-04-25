// Network-aware address normalization. EVM addresses (0x + 40 hex) are
// case-insensitive in the protocol — we lowercase them so DB lookups against
// `address_lower`-style columns work. Solana addresses are base58 and are
// case-sensitive — we MUST preserve the input verbatim, never lowercase.
//
// This helper mirrors `core/api/src/lib/address.ts` so the gate, API, and
// merchants normalize identically. If the two ever drift, captured wallets
// won't resolve and signer-match silently breaks.

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export const isValidEvmAddress = (address: string): boolean => EVM_RE.test(address);

export const isSolanaAddress = (address: string): boolean =>
  SOLANA_BASE58_RE.test(address) && !address.startsWith('0x');

export const isValidAddress = (address: string): boolean =>
  isValidEvmAddress(address) || isSolanaAddress(address);

export const normalizeAddress = (address: string): string => {
  if (isSolanaAddress(address)) { return address; }
  return address.toLowerCase();
};
