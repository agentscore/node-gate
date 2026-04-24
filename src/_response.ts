/**
 * Shared DenialReason → response body serialization for all adapters.
 *
 * Keeps Hono / Express / Fastify / Web / Next.js defaults aligned — a field added
 * here shows up in every adapter's 403 body automatically, and there's one place
 * to test the marshaling.
 */

import type { DenialReason } from './core.js';

// Field names the gate claims authority over. Merchant-provided `extra` (from the
// onBeforeSession hook) MUST NOT override these — a buggy or malicious hook could
// otherwise replace `verify_url` with a phishing URL or drop agent_instructions.
const RESERVED_FIELDS = new Set([
  'error',
  'decision',
  'reasons',
  'verify_url',
  'session_id',
  'poll_secret',
  'poll_url',
  'agent_instructions',
  'agent_memory',
  'claimed_operator',
  'actual_signer_operator',
  'expected_signer',
  'actual_signer',
  'linked_wallets',
]);

export function denialReasonToBody(reason: DenialReason): Record<string, unknown> {
  const body: Record<string, unknown> = { error: reason.code };
  if (reason.decision) body.decision = reason.decision;
  if (reason.reasons) body.reasons = reason.reasons;
  if (reason.verify_url) body.verify_url = reason.verify_url;
  if (reason.session_id) body.session_id = reason.session_id;
  if (reason.poll_secret) body.poll_secret = reason.poll_secret;
  if (reason.poll_url) body.poll_url = reason.poll_url;
  if (reason.agent_instructions) body.agent_instructions = reason.agent_instructions;
  if (reason.agent_memory) body.agent_memory = reason.agent_memory;
  if (reason.claimed_operator) body.claimed_operator = reason.claimed_operator;
  if (reason.code === 'wallet_signer_mismatch') body.actual_signer_operator = reason.actual_signer_operator ?? null;
  if (reason.expected_signer) body.expected_signer = reason.expected_signer;
  if (reason.actual_signer) body.actual_signer = reason.actual_signer;
  if (reason.linked_wallets && reason.linked_wallets.length > 0) body.linked_wallets = reason.linked_wallets;
  if (reason.extra) {
    for (const [key, value] of Object.entries(reason.extra)) {
      if (RESERVED_FIELDS.has(key)) {
        console.warn(`[gate] onBeforeSession returned reserved field "${key}" — ignoring to preserve gate authority`);
        continue;
      }
      body[key] = value;
    }
  }
  return body;
}
