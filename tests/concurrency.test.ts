import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { applyCatalog, resetRegistryForTests } from "../src/config/models.js";
import { CATALOG } from "./fixtures/catalog.js";

const auth = { authorization: "Bearer test-key" };
const ENV = { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" };
let app: FastifyInstance;
let store: AccountStore;

beforeEach(() => {
  store = new AccountStore(":memory:");
  applyCatalog(CATALOG);
  for (const id of ["a1", "a2"]) {
    store.upsertAccount({
      id,
      email: `${id}@x.com`,
      refreshToken: `r-${id}`,
      accessToken: `tok-${id}`,
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });
  }
});

afterEach(async () => {
  await app.close();
  store.close();
  resetRegistryForTests();
});

/** The marker the caller sent, read out of the envelope the wrapper built. */
function markerOf(init: RequestInit | undefined): string {
  const envelope = JSON.parse(String(init?.body ?? "{}")) as {
    request?: { contents?: Array<{ parts?: Array<{ text?: string }> }> };
  };
  return envelope.request?.contents?.[0]?.parts?.[0]?.text ?? "";
}

/**
 * Echoes each request's own marker back, **split across two reads with a pause between
 * them**. The pause is the point: it makes the transport read one stream, yield the event
 * loop, and come back after another request's stream has already delivered a partial line.
 * A reassembly buffer shared between calls corrupts both lines and this test catches it;
 * delivering each body in one piece would not, because nothing would interleave.
 */
function slowEchoStub(): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const marker = markerOf(init);
    const frame = `data: ${JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: marker }] } }] },
    })}\n\n`;
    const cut = Math.floor(frame.length / 2);
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(new TextEncoder().encode(frame.slice(0, cut)));
          return;
        }
        if (step === 1) {
          step = 2;
          // Yield long enough for the other in-flight requests to deliver their first half.
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(new TextEncoder().encode(frame.slice(cut)));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Echoes each request's own marker back, so a swapped stream is detectable. */
function echoStub(): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const marker = markerOf(init);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              response: { candidates: [{ content: { parts: [{ text: marker }] } }] },
            })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function contentOf(sseBody: string): string {
  let out = "";
  for (const block of sseBody.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const payload = trimmed.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    out += parsed.choices?.[0]?.delta?.content ?? "";
  }
  return out;
}

describe("concurrent requests", () => {
  it("keeps every stream's content separate when many run at once", async () => {
    // The slow stub is what gives this test teeth: each body pauses mid-frame, so the
    // transport genuinely interleaves the reads. With the fast stub this test passed even
    // against a deliberately shared reassembly buffer.
    app = buildServer("test-key", { store, env: ENV, fetchImpl: slowEchoStub(), logger: false });
    const markers = Array.from({ length: 8 }, (_, i) => `MARKER-${i}`);

    const responses = await Promise.all(
      markers.map((marker) =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "gemini-3.8-flash",
            stream: true,
            messages: [{ role: "user", content: marker }],
          },
        }),
      ),
    );

    responses.forEach((response, index) => {
      expect(response.statusCode, `request ${index}`).toBe(200);
      // Exactly the caller's own marker: a buffer shared between streams would surface as
      // another request's marker here, which is the failure this test exists to catch.
      expect(contentOf(response.body), `request ${index}`).toBe(markers[index]);
    });
  });

  it("answers many non-streaming requests without mixing their results", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: echoStub(), logger: false });
    const markers = Array.from({ length: 8 }, (_, i) => `PLAIN-${i}`);

    const responses = await Promise.all(
      markers.map((marker) =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "gemini-3.8-flash",
            stream: false,
            messages: [{ role: "user", content: marker }],
          },
        }),
      ),
    );

    responses.forEach((response, index) => {
      expect(response.statusCode, `request ${index}`).toBe(200);
      const body = response.json() as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content, `request ${index}`).toBe(markers[index]);
    });
  });

  it("serves streams and non-streams interleaved without corrupting either", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: echoStub(), logger: false });

    const jobs = Array.from({ length: 10 }, (_, i) => ({
      marker: `MIX-${i}`,
      stream: i % 2 === 0,
    }));

    const responses = await Promise.all(
      jobs.map((job) =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "gemini-3.8-flash",
            stream: job.stream,
            messages: [{ role: "user", content: job.marker }],
          },
        }),
      ),
    );

    responses.forEach((response, index) => {
      const job = jobs[index];
      expect(response.statusCode, `request ${index}`).toBe(200);
      if (job?.stream) {
        expect(contentOf(response.body), `stream ${index}`).toBe(job.marker);
      } else {
        const body = response.json() as { choices: Array<{ message: { content: string } }> };
        expect(body.choices[0]?.message.content, `plain ${index}`).toBe(job.marker);
      }
    });
  });

  it("records every concurrent use of the pool without losing an account", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: echoStub(), logger: false });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "gemini-3.8-flash",
            stream: false,
            messages: [{ role: "user", content: `USE-${i}` }],
          },
        }),
      ),
    );

    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(2);
    // Both accounts still exist and both are eligible: concurrent traffic must not park,
    // duplicate or drop one. Which account each request picked is not asserted -- that is
    // the selector's job and it is pinned there.
    for (const account of accounts) {
      expect(account.status).toBe("active");
      expect(account.enabled).toBe(true);
      expect(account.lastUsedAt).not.toBeNull();
    }
  });
});
