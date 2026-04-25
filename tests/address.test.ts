import { describe, expect, it } from 'vitest';
import { isSolanaAddress, isValidAddress, isValidEvmAddress, normalizeAddress } from '../src/address';

describe('isValidEvmAddress', () => {
  it('accepts canonical 0x + 40 hex', () => {
    expect(isValidEvmAddress('0x690BF056DA820EF2e74f8943B3Fe5ca4ADEe7a3e')).toBe(true);
    expect(isValidEvmAddress('0x' + 'a'.repeat(40))).toBe(true);
  });

  it('rejects wrong length / missing prefix / non-hex', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(39))).toBe(false);
    expect(isValidEvmAddress('0x' + 'a'.repeat(41))).toBe(false);
    expect(isValidEvmAddress('a'.repeat(40))).toBe(false);
    expect(isValidEvmAddress('0xZZZ' + 'a'.repeat(37))).toBe(false);
    expect(isValidEvmAddress('')).toBe(false);
  });
});

describe('isSolanaAddress', () => {
  it('accepts real Solana base58 pubkeys (32-44 chars, no 0x prefix)', () => {
    expect(isSolanaAddress('G2ajX7CrLGoaL8ncaDYNCQoV9b7XhwGF1RzAyKDEZgNZ')).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
  });

  it('rejects EVM addresses (0x prefix collides with valid base58 chars)', () => {
    // 0x... would otherwise match the base58 alphabet — the explicit !startsWith('0x')
    // disambiguation guards against routing an EVM address into the Solana code path.
    expect(isSolanaAddress('0x690BF056DA820EF2e74f8943B3Fe5ca4ADEe7a3e')).toBe(false);
  });

  it('rejects non-base58 chars + wrong lengths', () => {
    expect(isSolanaAddress('0OIl' + 'A'.repeat(28))).toBe(false); // contains 0/O/I/l
    expect(isSolanaAddress('A'.repeat(31))).toBe(false); // too short
    expect(isSolanaAddress('A'.repeat(45))).toBe(false); // too long
    expect(isSolanaAddress('')).toBe(false);
  });
});

describe('isValidAddress', () => {
  it('accepts both EVM and Solana shapes', () => {
    expect(isValidAddress('0x690BF056DA820EF2e74f8943B3Fe5ca4ADEe7a3e')).toBe(true);
    expect(isValidAddress('G2ajX7CrLGoaL8ncaDYNCQoV9b7XhwGF1RzAyKDEZgNZ')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidAddress('not-an-address')).toBe(false);
    expect(isValidAddress('')).toBe(false);
  });
});

describe('normalizeAddress', () => {
  it('lowercases EVM (case-insensitive in the protocol)', () => {
    expect(normalizeAddress('0x690BF056DA820EF2e74f8943B3Fe5ca4ADEe7a3e'))
      .toBe('0x690bf056da820ef2e74f8943b3fe5ca4adee7a3e');
  });

  it('preserves Solana base58 verbatim (case-sensitive on-chain)', () => {
    const sol = 'G2ajX7CrLGoaL8ncaDYNCQoV9b7XhwGF1RzAyKDEZgNZ';
    expect(normalizeAddress(sol)).toBe(sol);
    // Critically: do NOT lowercase a Solana address, even though the alphabet has
    // no characters illegal-when-lowered (lowercasing changes the on-chain identity).
    expect(normalizeAddress(sol)).not.toBe(sol.toLowerCase());
  });

  it('falls through to lowercase for unrecognized inputs (consistent with EVM-historical default)', () => {
    // Garbage input still returns SOMETHING (lowercased) so callers don't need an
    // is-valid guard before normalizing — DB writes are guarded separately.
    expect(normalizeAddress('NotAnAddress')).toBe('notanaddress');
  });
});
