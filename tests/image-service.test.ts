import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../src/lib/antigravity/errors.js";
import { AllAccountsFailedError } from "../src/lib/chat/turn.js";
import { ImageService } from "../src/lib/images/service.js";

describe("ImageService", () => {
  it("executes image generation against upstream and extracts inlineData base64", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: "fake-base64-image-bytes" } },
                ],
              },
            },
          ],
        },
      }),
    });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([{ id: "acc-1", email: "user@test.com", priority: 1 }]),
      ensureFresh: vi.fn().mockResolvedValue({
        id: "acc-1",
        accessToken: "test-token",
        projectId: "aicode-consumers",
      }),
      markUsed: vi.fn(),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const result = await service.generate("A futuristic car", { size: "1024x1024" });
    expect(result).toHaveLength(1);
    expect(result[0]?.b64Json).toBe("fake-base64-image-bytes");
    expect(result[0]?.revisedPrompt).toBe("A futuristic car");
    expect(mockAccountService.markUsed).toHaveBeenCalledWith("acc-1");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1internal:generateContent");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe("gemini-3.1-flash-image");
    expect(sentBody.requestType).toBe("image_gen");
    expect(sentBody.project).toBe("aicode-consumers");
    expect(sentBody.request.generationConfig.imageConfig.aspectRatio).toBe("1:1");
    expect(sentBody.request.contents[0].parts[0].text).toBe("A futuristic car");
  });

  it("fails over to next account on upstream 429", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "Quota exceeded" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "acc2-image" } }] } },
            ],
          },
        }),
      });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([
        { id: "acc-1", email: "user1@test.com" },
        { id: "acc-2", email: "user2@test.com" },
      ]),
      ensureFresh: vi.fn().mockImplementation((acc) => ({
        id: acc.id,
        accessToken: `token-${acc.id}`,
        projectId: "aicode-consumers",
      })),
      markCooldown: vi.fn(),
      markUsed: vi.fn(),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const result = await service.generate("A mountain", {});
    expect(result[0]?.b64Json).toBe("acc2-image");
    expect(mockAccountService.applyFailure).toHaveBeenCalledWith("acc-1", expect.any(UpstreamError));
    expect(mockAccountService.markUsed).toHaveBeenCalledWith("acc-2");
  });

  it("fails over to next account on upstream 5xx", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal server error" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "recovered-5xx-image" } }] } },
            ],
          },
        }),
      });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([
        { id: "acc-1", email: "user1@test.com" },
        { id: "acc-2", email: "user2@test.com" },
      ]),
      ensureFresh: vi.fn().mockImplementation((acc) => ({
        id: acc.id,
        accessToken: `token-${acc.id}`,
        projectId: "aicode-consumers",
      })),
      markUsed: vi.fn(),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const result = await service.generate("A valley", {});
    expect(result[0]?.b64Json).toBe("recovered-5xx-image");
    expect(mockAccountService.applyFailure).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({ status: 500 }),
    );
    expect(mockAccountService.markUsed).toHaveBeenCalledWith("acc-2");
  });

  it("throws UpstreamError client_error 400 on promptFeedback blockReason safety violation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          promptFeedback: {
            blockReason: "SAFETY",
          },
          candidates: [],
        },
      }),
    });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([{ id: "acc-1", email: "user@test.com" }]),
      ensureFresh: vi.fn().mockResolvedValue({
        id: "acc-1",
        accessToken: "test-token",
        projectId: "aicode-consumers",
      }),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    await expect(service.generate("unsafe prompt")).rejects.toThrowError(
      expect.objectContaining({
        kind: "client_error",
        status: 400,
        message: "Safety violation",
      }),
    );
    // Safety violation is a prompt/client error, not an account failure
    expect(mockAccountService.applyFailure).not.toHaveBeenCalled();
  });

  it("throws UpstreamError client_error 400 on candidate finishReason SAFETY", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          candidates: [
            {
              finishReason: "SAFETY",
              content: { parts: [] },
            },
          ],
        },
      }),
    });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([{ id: "acc-1", email: "user@test.com" }]),
      ensureFresh: vi.fn().mockResolvedValue({
        id: "acc-1",
        accessToken: "test-token",
        projectId: "aicode-consumers",
      }),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    await expect(service.generate("another unsafe prompt")).rejects.toThrowError(
      expect.objectContaining({
        kind: "client_error",
        status: 400,
        message: "Safety violation",
      }),
    );
    expect(mockAccountService.applyFailure).not.toHaveBeenCalled();
  });

  it("handles n > 1 by performing sequential calls up to n", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { inlineData: { mimeType: "image/jpeg", data: `image-b64-number-${callCount}` } },
                  ],
                },
              },
            ],
          },
        }),
      };
    });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([{ id: "acc-1", email: "user@test.com" }]),
      ensureFresh: vi.fn().mockResolvedValue({
        id: "acc-1",
        accessToken: "test-token",
        projectId: "aicode-consumers",
      }),
      markUsed: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const result = await service.generate("A pair of cats", { n: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]?.b64Json).toBe("image-b64-number-1");
    expect(result[1]?.b64Json).toBe("image-b64-number-2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("translates aspect ratio according to requested size", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: "image/jpeg", data: "landscape-image" } }],
              },
            },
          ],
        },
      }),
    });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([{ id: "acc-1", email: "user@test.com" }]),
      ensureFresh: vi.fn().mockResolvedValue({
        id: "acc-1",
        accessToken: "test-token",
        projectId: "aicode-consumers",
      }),
      markUsed: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    await service.generate("Wide scenery", { size: "1792x1024" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const envelope = JSON.parse(init.body as string);
    expect(envelope.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
  });

  it("throws AllAccountsFailedError when account pool is empty", async () => {
    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([]),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: vi.fn() as any,
    });

    await expect(service.generate("empty pool test")).rejects.toBeInstanceOf(AllAccountsFailedError);
  });

  it("throws AllAccountsFailedError when all accounts in pool fail", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "Quota exceeded" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "Service unavailable" });

    const mockAccountService = {
      orderFor: vi.fn().mockResolvedValue([
        { id: "acc-1", email: "user1@test.com" },
        { id: "acc-2", email: "user2@test.com" },
      ]),
      ensureFresh: vi.fn().mockImplementation((acc) => ({
        id: acc.id,
        accessToken: `token-${acc.id}`,
        projectId: "aicode-consumers",
      })),
      applyFailure: vi.fn(),
    };

    const service = new ImageService({
      accountService: mockAccountService as any,
      fetchImpl: mockFetch as any,
    });

    const error = await service.generate("fail all test").catch((e) => e);
    expect(error).toBeInstanceOf(AllAccountsFailedError);
    expect((error as AllAccountsFailedError).failures).toHaveLength(2);
    expect(mockAccountService.applyFailure).toHaveBeenCalledTimes(2);
  });
});
