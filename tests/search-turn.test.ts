import { describe, expect, it } from "vitest";
import { TurnRunner } from "../src/lib/chat/turn.js";

describe("TurnRunner with search grounding", () => {
  it("appends citations footer to non-streaming message and populates groundingMetadata", async () => {
    const mockSse = `data: {"response":{"candidates":[{"content":{"parts":[{"text":"O vencedor foi Han Kang."}]},"groundingMetadata":{"webSearchQueries":["Nobel 2024"],"groundingChunks":[{"web":{"uri":"https://nobelprize.org","title":"Nobel Prize"}}]}}]}}\n\n`;

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(mockSse));
          controller.close();
        },
      }),
    });

    const mockAccountService = {
      orderFor: async () => [{ id: "acc-1" }],
      ensureFresh: async () => ({ id: "acc-1", accessToken: "tok", projectId: "p1" }),
      poolSummary: () => ({ enabled: 1, cooling: 0, soonestCooldownUntil: null }),
      markUsed: () => {},
    };

    const runner = new TurnRunner({
      accounts: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const outcome = await runner.run({
      runtimeModel: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: "Quem venceu o Nobel?" }] }],
      systemInstruction: "You are a helpful assistant.",
      effort: "off",
      enableWebSearch: true,
    } as any);

    expect(outcome.result.content).toContain("O vencedor foi Han Kang.");
    expect(outcome.result.content).toContain("### Fontes consultadas");
    expect(outcome.result.content).toContain("[Nobel Prize](https://nobelprize.org)");
    expect(outcome.result.groundingMetadata).toBeDefined();
    expect(outcome.result.groundingMetadata?.webSearchQueries).toContain("Nobel 2024");
  });

  it("emits citations delta when streaming onDelta is provided", async () => {
    const mockSse = `data: {"response":{"candidates":[{"content":{"parts":[{"text":"O vencedor foi Han Kang."}]},"groundingMetadata":{"webSearchQueries":["Nobel 2024"],"groundingChunks":[{"web":{"uri":"https://nobelprize.org","title":"Nobel Prize"}}]}}]}}\n\n`;

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(mockSse));
          controller.close();
        },
      }),
    });

    const mockAccountService = {
      orderFor: async () => [{ id: "acc-1" }],
      ensureFresh: async () => ({ id: "acc-1", accessToken: "tok", projectId: "p1" }),
      poolSummary: () => ({ enabled: 1, cooling: 0, soonestCooldownUntil: null }),
      markUsed: () => {},
    };

    const runner = new TurnRunner({
      accounts: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const deltas: string[] = [];
    const outcome = await runner.run(
      {
        runtimeModel: "gemini-3.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: "Quem venceu o Nobel?" }] }],
        systemInstruction: "You are a helpful assistant.",
        effort: "off",
        enableWebSearch: true,
      } as any,
      {
        onDelta: (chunk) => deltas.push(chunk),
      },
    );

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toBe("O vencedor foi Han Kang.");
    expect(deltas[1]).toContain("### Fontes consultadas");
    expect(deltas[1]).toContain("[Nobel Prize](https://nobelprize.org)");
    expect(outcome.result.content).toBe(deltas.join(""));
  });
});
