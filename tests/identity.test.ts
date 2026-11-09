import { describe, expect, it } from "vitest";
import { ConversationRegistry } from "../src/lib/chat/identity.js";
import type { GeminiContent } from "../src/lib/antigravity/envelope.js";

const CONTENTS: GeminiContent[] = [{ role: "user", parts: [{ text: "primeira mensagem" }] }];

function registry(): ConversationRegistry {
  return new ConversationRegistry({ now: () => 1_000 });
}

describe("ConversationRegistry", () => {
  it("keeps one key for the turns of a conversation and another key for another chat", () => {
    const found = registry();
    const key = found.key(CONTENTS, "system");
    const later = found.key(
      [{ role: "user", parts: [{ text: "primeira mensagem" }] }, { role: "model", parts: [{ text: "ok" }] }],
      "system",
    );
    expect(later).toBe(key);
    expect(found.key([{ role: "user", parts: [{ text: "outra abertura" }] }], "system")).not.toBe(key);
    expect(found.key(CONTENTS, "outro system")).not.toBe(key);
  });

  it("mints one cascade, one trajectory and one session per conversation", () => {
    const found = registry();
    const key = found.key(CONTENTS, "system");
    const state = found.state(key);
    expect(state.cascadeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.trajectoryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.sessionId).toMatch(/^-?\d+$/);
    expect(state.step).toBe(1);
    expect(found.state(key)).toBe(state);
  });

  it("advances the step and remembers the account only after a finished turn", () => {
    const found = registry();
    const key = found.key(CONTENTS, "system");
    found.state(key);
    expect(found.accountFor(key)).toBeNull();

    expect(found.state(key).requestIndex).toBe(0);
    expect(found.state(key).lastExecutionId).toBeNull();

    found.recordSuccess(key, "a1");
    expect(found.accountFor(key)).toBe("a1");
    expect(found.state(key).step).toBe(2);
    // The step and the request counter are independent, and the finished turn becomes the
    // execution the next request names.
    expect(found.state(key).requestIndex).toBe(1);
    expect(found.state(key).lastExecutionId).toMatch(/^[0-9a-f-]{36}$/);

    found.recordSuccess(key, "a1");
    expect(found.state(key).step).toBe(3);
    expect(found.state(key).requestIndex).toBe(2);
  });

  it("ignores a success for a conversation it never saw", () => {
    const found = registry();
    found.recordSuccess("desconhecida", "a1");
    expect(found.accountFor("desconhecida")).toBeNull();
    expect(found.size()).toBe(0);
  });

  it("forgets a conversation after the ttl", () => {
    let now = 1_000;
    const found = new ConversationRegistry({ ttlMs: 50, now: () => now });
    const key = found.key(CONTENTS, "system");
    const first = found.state(key);
    now = 1_100;
    const second = found.state(key);
    expect(second.cascadeId).not.toBe(first.cascadeId);
    expect(found.size()).toBe(1);
  });

  it("bounds the map, dropping the least recently used conversation", () => {
    let now = 1_000;
    const found = new ConversationRegistry({ maxEntries: 2, now: () => now });
    const first = found.key([{ role: "user", parts: [{ text: "a" }] }], "s");
    found.state(first);
    now = 1_010;
    const second = found.key([{ role: "user", parts: [{ text: "b" }] }], "s");
    found.state(second);
    now = 1_020;
    const third = found.key([{ role: "user", parts: [{ text: "c" }] }], "s");
    found.state(third);
    expect(found.size()).toBe(2);
  });
});
