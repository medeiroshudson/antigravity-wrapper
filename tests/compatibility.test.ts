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

const MASK_RULE = RULES.find((rule) => rule.action.kind === "mask-literal")!;
const MASK_LITERAL = MASK_RULE.when.literal;
const MASK_REPLACEMENT =
  MASK_RULE.action.kind === "mask-literal" ? MASK_RULE.action.replacement : "";

describe("applyCompatibility — content scope", () => {
  it("masks the literal in a user text part and leaves everything else byte-identical", () => {
    const input = {
      systemInstruction: "sys",
      contents: [
        {
          role: "user" as const,
          parts: [{ text: `before ${MASK_LITERAL} after` }, { text: "untouched" }],
        },
      ],
    };

    const result = applyCompatibility(input, "on");

    expect(result.hits).toEqual([
      { ruleId: MASK_RULE.id, chars: MASK_LITERAL.length, applied: true },
    ]);
    const [first, second] = result.input.contents[0]!.parts;
    expect("text" in first! && first.text).toBe(`before ${MASK_REPLACEMENT} after`);
    expect("text" in second! && second.text).toBe("untouched");
    expect(result.input.systemInstruction).toBe("sys");
  });

  it("masks inside a tool result, where the agent's own reads land", () => {
    const input = {
      systemInstruction: "",
      contents: [
        {
          role: "user" as const,
          parts: [
            {
              functionResponse: {
                name: "bash",
                response: { output: `$ cat note.md\n${MASK_LITERAL}\n` },
              },
            },
          ],
        },
      ],
    };

    const result = applyCompatibility(input, "on");

    expect(result.hits[0]).toMatchObject({ ruleId: MASK_RULE.id, applied: true });
    const response = result.input.contents[0]!.parts[0] as {
      functionResponse: { response: { output: string } };
    };
    expect(response.functionResponse.response.output).toBe(
      `$ cat note.md\n${MASK_REPLACEMENT}\n`,
    );
  });

  it("does not touch functionCall arguments or thought parts", () => {
    const input = {
      systemInstruction: "",
      contents: [
        {
          role: "model" as const,
          parts: [
            { functionCall: { name: "write", args: { text: MASK_LITERAL } } },
            { thought: true as const, text: MASK_LITERAL },
          ],
        },
      ],
    };

    expect(applyCompatibility(input, "on")).toEqual({ input, hits: [] });
  });

  it("is idempotent: a masked request has nothing left to match", () => {
    const once = applyCompatibility(
      { systemInstruction: "", contents: [{ role: "user", parts: [{ text: MASK_LITERAL }] }] },
      "on",
    );
    const twice = applyCompatibility(once.input, "on");
    expect(twice.input).toBe(once.input);
    expect(twice.hits).toEqual([]);
  });

  it("reports the content hit without changing anything in log mode", () => {
    const input = { systemInstruction: "", contents: [{ role: "user" as const, parts: [{ text: MASK_LITERAL }] }] };
    const result = applyCompatibility(input, "log");
    expect(result.input).toBe(input);
    expect(result.hits).toEqual([
      { ruleId: MASK_RULE.id, chars: MASK_LITERAL.length, applied: false, skipped: "log-only" },
    ]);
  });

  it("never evaluates content in off mode", () => {
    const input = { systemInstruction: "", contents: [{ role: "user" as const, parts: [{ text: MASK_LITERAL }] }] };
    expect(applyCompatibility(input, "off")).toEqual({ input, hits: [] });
  });

  it("masks case-insensitively and counts every occurrence", () => {
    const text = `${MASK_LITERAL.toUpperCase()} and ${MASK_LITERAL}`;
    const result = applyCompatibility(
      { systemInstruction: "", contents: [{ role: "user", parts: [{ text }] }] },
      "on",
    );
    expect(result.hits[0]).toEqual({
      ruleId: MASK_RULE.id,
      chars: MASK_LITERAL.length * 2,
      applied: true,
    });
    const part = result.input.contents[0]!.parts[0]!;
    expect("text" in part && part.text).toBe(`${MASK_REPLACEMENT} and ${MASK_REPLACEMENT}`);
  });
});
