import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("POST /v1/images/generations", () => {
  it("rejects request without prompt with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/prompt/i);
  });

  it("rejects request with empty prompt with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/prompt/i);
  });

  it("rejects request with prompt exceeding 4000 characters with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "a".repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/prompt/i);
  });

  it("rejects unknown model with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", model: "dall-e-3" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not supported/i);
  });

  it("rejects invalid n with 400", async () => {
    const server = buildServer("test-key");
    const resTooLarge = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", n: 5 },
    });
    expect(resTooLarge.statusCode).toBe(400);

    const resTooSmall = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", n: 0 },
    });
    expect(resTooSmall.statusCode).toBe(400);
  });

  it("returns 200 with b64_json on valid request", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "base64-cat-image" } }] } },
          ],
        },
      }),
    });

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", model: "gemini-3.1-flash-image", response_format: "b64_json" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].b64_json).toBe("base64-cat-image");
    expect(body.created).toBeTypeOf("number");
  });

  it("returns Data URI when response_format is url", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        response: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "base64-cat-image" } }] } },
          ],
        },
      }),
    });

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", response_format: "url" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data[0].url).toBe("data:image/jpeg;base64,base64-cat-image");
  });

  it("defaults to gemini-3.1-flash-image when model is omitted", async () => {
    let capturedBody: any;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "default-model-image" } }] } },
            ],
          },
        }),
      };
    };

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "Sunset" },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedBody.model).toBe("gemini-3.1-flash-image");
  });

  it("generates multiple images when n > 1", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: `image-${callCount}` } }] } },
            ],
          },
        }),
      };
    };

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "Two puppies", model: "gemini-3.1-flash-image", n: 2 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].b64_json).toBe("image-1");
    expect(body.data[1].b64_json).toBe("image-2");
  });

  it("maps upstream safety violation to 400", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "SAFETY: Prohibited content detected",
    });

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "unsafe prompt" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("rejects non-string prompt with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/prompt/i);
  });

  it("rejects non-string size with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", size: 1024 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/size/i);
  });

  it("rejects non-integer n with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", n: 2.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/n/i);
  });

  it("rejects unsupported response_format with 400", async () => {
    const server = buildServer("test-key");
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat", response_format: "webp" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/response_format/i);
  });

  it("translates size parameter into upstream aspectRatio", async () => {
    let capturedBody: any;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "landscape-image" } }] } },
            ],
          },
        }),
      };
    };

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A wide beach", size: "1792x1024" },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedBody.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
  });

  it("maps upstream 500 error to 502/500 with OpenAI error body", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const server = buildServer("test-key", { fetchImpl: mockFetch as any });
    const res = await server.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: "Bearer test-key" },
      payload: { prompt: "A cat" },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json().error.type).toBe("server_error");
  });
});
