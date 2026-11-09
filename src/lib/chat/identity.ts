import { createHash, randomUUID } from "node:crypto";
import { randomInt64, type ConversationIdentity, type GeminiContent } from "../antigravity/envelope.js";

/**
 * One conversation's identity, plus the account that last served it.
 *
 * Measured 2026-11-09: the client keeps `cascade_id`, `trajectory_id` and `sessionId` for a
 * whole conversation and only advances `last_step_index`. Minting them per turn (what this
 * wrapper did) turns one conversation into N unrelated cascades — each carrying the full
 * history — which no real client produces.
 *
 * The account is part of the state because the same anomaly applies to routing: a pool that
 * rotates accounts mid-conversation makes one cascade appear from several Google accounts,
 * something a human cannot do.
 */
export interface ConversationState extends ConversationIdentity {
  accountId: string | null;
  lastUsedAt: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 512;

export class ConversationRegistry {
  private readonly entries = new Map<string, ConversationState>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = opts.now ?? Date.now;
  }

  /**
   * The conversation key: the system instruction plus the first user message, which is what
   * stays identical across the turns of one chat and changes between chats. Two chats that
   * open with the same text collide; the consequence is a shared cascade id and a shared
   * account, not a wrong answer, and the TTL bounds how long the collision can live.
   */
  key(contents: readonly GeminiContent[], systemInstruction: string): string {
    const firstUser = contents.find((content) => content.role === "user") ?? contents[0];
    const text = (firstUser?.parts ?? [])
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
    return createHash("sha256")
      .update(systemInstruction)
      .update("\u0000")
      .update(text)
      .digest("hex")
      .slice(0, 32);
  }

  /** The state for a key, created on first use. */
  state(key: string): ConversationState {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = this.clock();
      return existing;
    }
    const created: ConversationState = {
      cascadeId: randomUUID(),
      trajectoryId: randomUUID(),
      sessionId: randomInt64(),
      step: 1,
      requestIndex: 0,
      lastExecutionId: null,
      accountId: null,
      lastUsedAt: this.clock(),
    };
    this.entries.set(key, created);
    return created;
  }

  /** The account that last served this conversation, or null before the first turn. */
  accountFor(key: string): string | null {
    return this.entries.get(key)?.accountId ?? null;
  }

  /** A finished turn: advance the step and remember who served it. */
  recordSuccess(key: string, accountId: string): void {
    const state = this.entries.get(key);
    if (!state) return;
    state.step += 1;
    state.requestIndex += 1;
    // The client names the execution each request ran in; the next request reports it as
    // `last_execution_id` (measured: a UUID, not a derived id).
    state.lastExecutionId = randomUUID();
    state.accountId = accountId;
    state.lastUsedAt = this.clock();
  }

  size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [key, state] of this.entries) {
      if (state.lastUsedAt < cutoff) this.entries.delete(key);
    }
    if (this.entries.size < this.maxEntries) return;
    // Oldest first: Map keeps insertion order and `state()` re-inserts nothing, so the
    // first entries are the least recently used after the TTL sweep above.
    const ordered = [...this.entries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [key] of ordered.slice(0, this.entries.size - this.maxEntries + 1)) {
      this.entries.delete(key);
    }
  }
}

let shared: ConversationRegistry | null = null;

/** The process-wide registry: one per server, so identity survives across requests. */
export function getConversationRegistry(): ConversationRegistry {
  shared ??= new ConversationRegistry();
  return shared;
}

export function resetConversationRegistryForTests(): void {
  shared = null;
}
