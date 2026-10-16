/**
 * Server-side memory of the thoughtSignatures the upstream issued.
 *
 * The upstream requires every functionCall in the conversation history to carry the
 * `thoughtSignature` it was returned with; without it the next turn is rejected with
 * 400 "missing a thought_signature" (measured with the real client). OpenAI-compatible
 * clients have no such field and silently drop it when echoing the assistant turn
 * back — so the wrapper, the stateful party of the loop, remembers signatures by call
 * id and reattaches them when the client history arrives unsigned.
 *
 * Process memory is enough: signatures are only reusable within the same conversation,
 * and a conversation lives within one server process. A restart mid-conversation falls
 * back to what the client sends (nothing), matching pre-fix behaviour.
 */

const MAX_ENTRIES = 5_000;

const byCallId = new Map<string, string>();

export function rememberSignature(callId: string, signature: string): void {
  if (!callId || !signature) return;
  if (byCallId.size >= MAX_ENTRIES && !byCallId.has(callId)) {
    const oldest = byCallId.keys().next().value;
    if (oldest !== undefined) byCallId.delete(oldest);
  }
  byCallId.set(callId, signature);
}

export function recallSignature(callId: string): string | null {
  return byCallId.get(callId) ?? null;
}
