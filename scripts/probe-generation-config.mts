/**
 * scripts/probe-generation-config.mts
 *
 * Throwaway live probe script testing Antigravity / Gemini generationConfig fields
 * (temperature, topP, topK, responseMimeType, responseSchema, stopSequences, thinkingBudget)
 * against dev accounts when available (as outlined in Spec §11).
 *
 * Usage:
 *   npx tsx scripts/probe-generation-config.mts [--dry-run] [--model=gemini-2.5-flash] [--variant=<id>]
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { buildEnvelope, newRequestIdentity, type EnvelopeInput, type GeminiContent } from "../src/lib/antigravity/envelope.js";
import { streamGenerate } from "../src/lib/antigravity/rpc.js";
import { getStore, getAccountService } from "../src/lib/runtime.js";
import { UpstreamError } from "../src/lib/antigravity/errors.js";

interface VariantDefinition {
  id: string;
  section: string;
  description: string;
  prompt: string;
  envelopeOverrides: Partial<EnvelopeInput>;
  expectedStatus?: number;
}

const VARIANTS: VariantDefinition[] = [
  {
    id: "baseline",
    section: "(a)",
    description: "Baseline envelope with default generationConfig",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: {},
    expectedStatus: 200,
  },
  {
    id: "temperature-0",
    section: "(b)",
    description: "Sampling: temperature=0",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { temperature: 0 },
    expectedStatus: 200,
  },
  {
    id: "temperature-1",
    section: "(b)",
    description: "Sampling: temperature=1.0",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { temperature: 1.0 },
    expectedStatus: 200,
  },
  {
    id: "temperature-2",
    section: "(b)",
    description: "Sampling: temperature=2.0",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { temperature: 2.0 },
    expectedStatus: 200,
  },
  {
    id: "topP-extreme-low",
    section: "(b)",
    description: "Sampling: topP=0.1",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { topP: 0.1 },
    expectedStatus: 200,
  },
  {
    id: "topP-extreme-high",
    section: "(b)",
    description: "Sampling: topP=1.0",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { topP: 1.0 },
    expectedStatus: 200,
  },
  {
    id: "topK-extreme-low",
    section: "(b)",
    description: "Sampling: topK=1",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { topK: 1 },
    expectedStatus: 200,
  },
  {
    id: "topK-extreme-high",
    section: "(b)",
    description: "Sampling: topK=40",
    prompt: "Respond with 'hello world'",
    envelopeOverrides: { topK: 40 },
    expectedStatus: 200,
  },
  {
    id: "responseMimeType-json",
    section: "(c)",
    description: "Structured: responseMimeType='application/json' (no prompt JSON instruction)",
    prompt: "List 3 primary colors",
    envelopeOverrides: { responseMimeType: "application/json" },
    expectedStatus: 200,
  },
  {
    id: "responseSchema-valid",
    section: "(d)",
    description: "Structured: responseSchema with valid object schema",
    prompt: "List 3 primary colors",
    envelopeOverrides: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          colors: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: ["colors"],
      },
    },
    expectedStatus: 200,
  },
  {
    id: "responseSchema-unsupported-keys",
    section: "(d)",
    description: "Structured: responseSchema containing unsupported keywords ($ref, const, default)",
    prompt: "Pick a primary color",
    envelopeOverrides: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          color: {
            type: "string",
            const: "red",
            default: "red",
            examples: ["red"],
          },
        },
        $defs: {
          helper: { type: "string" },
        },
      },
    },
    expectedStatus: 400,
  },
  {
    id: "stopSequences-single",
    section: "(e)",
    description: "Stopping: stopSequences=['banana'] mid-sequence",
    prompt: "Repeat verbatim: apple orange banana grape kiwi",
    envelopeOverrides: {
      stopSequences: ["banana"],
    },
    expectedStatus: 200,
  },
  {
    id: "budget-boundary-exceeded",
    section: "(f)",
    description: "Boundary: thinkingBudget (100) > maxOutputTokens (50)",
    prompt: "Respond with 'hello'",
    envelopeOverrides: {
      thinking: { includeThoughts: true, thinkingBudget: 100 },
      maxOutputTokens: 50,
    },
    expectedStatus: 200,
  },
  {
    id: "budget-valid",
    section: "(f)",
    description: "Boundary: thinkingBudget (50) < maxOutputTokens (200)",
    prompt: "Respond with 'hello'",
    envelopeOverrides: {
      thinking: { includeThoughts: true, thinkingBudget: 50 },
      maxOutputTokens: 200,
    },
    expectedStatus: 200,
  },
];

async function readFirstBytes(res: Response, maxBytes = 200): Promise<string> {
  if (!res.body) return "<empty body>";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  try {
    while (accumulated.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return accumulated.slice(0, maxBytes);
}

async function resolveAccountAndToken(
  explicitToken?: string,
  explicitProject?: string,
): Promise<{ token: string; projectId: string; accountDesc: string } | null> {
  if (explicitToken) {
    return {
      token: explicitToken,
      projectId: explicitProject || "aicode-consumers",
      accountDesc: "explicit token override",
    };
  }

  try {
    const store = getStore();
    const service = getAccountService();
    const accounts = store.listAccounts().filter((a) => a.enabled && a.status !== "invalid");

    for (const acc of accounts) {
      try {
        const fresh = await service.ensureFresh(acc);
        if (fresh.accessToken) {
          return {
            token: fresh.accessToken,
            projectId: fresh.projectId || "aicode-consumers",
            accountDesc: `${fresh.email ?? fresh.id} (${fresh.projectId ?? "aicode-consumers"})`,
          };
        }
      } catch (err) {
        // Try next account if token refresh fails on this one
        console.warn(`[probe] Account ${acc.id} refresh skipped:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[probe] Could not query account store:", err instanceof Error ? err.message : String(err));
  }

  return null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      model: { type: "string", default: process.env.PROBE_MODEL || "gemini-2.5-flash" },
      variant: { type: "string" },
      token: { type: "string", default: process.env.PROBE_ACCESS_TOKEN },
      project: { type: "string", default: process.env.PROBE_PROJECT_ID },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Antigravity GenerationConfig Live Probe Script (Spec §11)

Options:
  --dry-run          Construct and dump envelopes without issuing live RPCs
  --model=<id>       Runtime model to test against (default: gemini-2.5-flash)
  --variant=<id>     Run only a specific variant (e.g. baseline, temperature-0, stopSequences-single)
  --token=<token>    Explicit OAuth access token override
  --project=<id>     Explicit GCP project override (default: aicode-consumers)
  --help             Show this help message
`);
    return;
  }

  const model = String(values.model || "gemini-2.5-flash");
  let dryRun = Boolean(values["dry-run"]);
  const filterVariant = values.variant ? String(values.variant) : null;

  console.log("================================================================================");
  console.log(" Antigravity GenerationConfig Probe (Spec §11)");
  console.log(` Model: ${model}`);
  console.log("================================================================================");

  let authInfo = await resolveAccountAndToken(values.token ? String(values.token) : undefined, values.project ? String(values.project) : undefined);

  if (!authInfo && !dryRun) {
    console.warn("\n[!] No active dev account with valid credentials found in store or environment.");
    console.warn("    Falling back to DRY-RUN mode (verifying envelope generation without network calls).");
    console.warn("    To run against live upstream, authenticate an account via the wrapper or set PROBE_ACCESS_TOKEN.\n");
    dryRun = true;
  } else if (authInfo) {
    console.log(` Authenticated Account: ${authInfo.accountDesc}`);
  }
  console.log(` Mode: ${dryRun ? "DRY-RUN (Local envelope verification only)" : "LIVE (Upstream RPC probing)"}\n`);

  const variantsToRun = filterVariant
    ? VARIANTS.filter((v) => v.id === filterVariant || v.id.includes(filterVariant))
    : VARIANTS;

  if (variantsToRun.length === 0) {
    console.error(`Error: No variants matched filter '${filterVariant}'. Available: ${VARIANTS.map((v) => v.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{ id: string; status: string; detail: string }> = [];

  for (const variant of variantsToRun) {
    console.log(`--- [${variant.section}] ${variant.id}: ${variant.description} ---`);

    const identity = newRequestIdentity(model);
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: variant.prompt }] }];

    const envelopeInput: EnvelopeInput = {
      projectId: authInfo?.projectId || "aicode-consumers",
      runtimeModel: model,
      contents,
      systemInstruction: "You are a test assistant.",
      thinking: { includeThoughts: false, thinkingBudget: 0 },
      maxOutputTokens: 64,
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
      ...variant.envelopeOverrides,
    };

    const envelope = buildEnvelope(envelopeInput);
    console.log("  generationConfig:", JSON.stringify(envelope.request.generationConfig, null, 2).replace(/\n/g, "\n  "));

    if (dryRun) {
      console.log("  [DRY-RUN] Envelope built successfully.\n");
      results.push({ id: variant.id, status: "BUILT (DRY-RUN)", detail: "OK" });
      continue;
    }

    try {
      const response = await streamGenerate(authInfo!.token, envelope);
      const status = response.status;
      const firstBytes = await readFirstBytes(response, 200);
      const sample = firstBytes.replace(/[\r\n]+/g, " ").slice(0, 120);

      console.log(`  Upstream Status: ${status}`);
      console.log(`  First 200 bytes SSE snippet: ${sample}...`);

      const pass = variant.expectedStatus ? status === variant.expectedStatus : response.ok;
      results.push({
        id: variant.id,
        status: `${status} ${response.statusText || (pass ? "OK" : "UNEXPECTED")}`,
        detail: sample,
      });
    } catch (err) {
      if (err instanceof UpstreamError) {
        console.log(`  Upstream Status: ${err.status} (${err.kind})`);
        console.log(`  Message: ${err.message.slice(0, 150)}`);
        const pass = variant.expectedStatus ? err.status === variant.expectedStatus : false;
        results.push({
          id: variant.id,
          status: `${err.status} (${err.kind})`,
          detail: err.message.slice(0, 80),
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Request Error: ${msg}`);
        results.push({ id: variant.id, status: "ERROR", detail: msg });
      }
    }
    console.log();
  }

  console.log("================================================================================");
  console.log(" Probe Summary Table");
  console.log("================================================================================");
  for (const r of results) {
    console.log(` ${r.id.padEnd(32)} | ${r.status.padEnd(16)} | ${r.detail.slice(0, 45)}`);
  }
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Fatal probe error:", err);
  process.exitCode = 1;
});
