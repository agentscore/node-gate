/**
 * Shared DenialReason → response body serialization for all adapters.
 *
 * Keeps Hono / Express / Fastify / Web / Next.js defaults aligned — a field added
 * here shows up in every adapter's 403 body automatically, and there's one place
 * to test the marshaling.
 */

import type { DenialReason } from './core.js';

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
  if (reason.actual_signer_operator !== undefined) body.actual_signer_operator = reason.actual_signer_operator;
  if (reason.expected_signer) body.expected_signer = reason.expected_signer;
  if (reason.actual_signer) body.actual_signer = reason.actual_signer;
  if (reason.linked_wallets && reason.linked_wallets.length > 0) body.linked_wallets = reason.linked_wallets;
  if (reason.extra) Object.assign(body, reason.extra);
  return body;
}
