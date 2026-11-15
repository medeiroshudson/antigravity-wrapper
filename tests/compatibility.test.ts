import { describe, expect, it } from "vitest";
import { applyCompatibility, RULES } from "../src/lib/chat/compatibility.js";
import type { GeminiContent } from "../src/lib/antigravity/envelope.js";

const LITERAL = RULES[0]!.when.literal;

function inputOf(system: string, userText = "oi"): { systemInstruction: string; contents: GeminiContent[] } {
  return {
    systemInstruction: system,
    contents: [{ role: "user", parts: [{ text: userText }] }],
  };
}

describe("applyCompatibility", () => {
  it("does not even evaluate the rules when off", () => {
    const input = inputOf(`catalog: ${LITERAL}`);
    expect(applyCompatibility(input, "off")).toEqual({ input, hits: [] });
  });

  it("reports without changing the request in log mode", () => {
    const input = inputOf(`catalog: ${LITERAL}`);
    const result = applyCompatibility(input, "log");
    expect(result.input).toBe(input);
    expect(result.hits).toEqual([
      { ruleId: RULES[0]!.id, chars: input.systemInstruction.length, applied: false, skipped: "log-only" },
    ]);
  });

  it("moves the system text, verbatim, to the first user turn in on mode", () => {
    const system = `catalog: ${LITERAL}`;
    const result = applyCompatibility(inputOf(system, "Reply OK"), "on");

    expect(result.hits[0]).toMatchObject({ ruleId: RULES[0]!.id, applied: true });
    expect(result.input.systemInstruction).toBe("");
    const first = result.input.contents[0]!;
    const text = first.parts[0]!;
    expect("text" in text && text.text).toContain("<system-instructions>");
    expect("text" in text && text.text).toContain(system);
    expect("text" in text && text.text).toContain("Reply OK");
  });

  it("is idempotent: the second pass finds no literal left in the system", () => {
    const once = applyCompatibility(inputOf(`catalog: ${LITERAL}`), "on");
    const twice = applyCompatibility(once.input, "on");
    expect(twice.input).toBe(once.input);
    expect(twice.hits).toEqual([]);
  });

  it("does not apply without a user turn to move the text into", () => {
    const input = { systemInstruction: `catalog: ${LITERAL}`, contents: [] as GeminiContent[] };
    const result = applyCompatibility(input, "on");
    expect(result.input).toBe(input);
    expect(result.hits[0]).toMatchObject({ applied: false, skipped: "no-user-turn" });
  });

  it("ignores a system instruction with no known literal", () => {
    expect(applyCompatibility(inputOf("You are a helpful assistant."), "on").hits).toEqual([]);
  });

  it("matches case-insensitively, like the upstream rule it mirrors", () => {
    const result = applyCompatibility(inputOf(`catalog: ${LITERAL.toUpperCase()}`), "on");
    expect(result.hits[0]).toMatchObject({ applied: true });
  });
});
