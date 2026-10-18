# Field-Mapping Fidelity — Design

**Date:** 2026-10-18
**Status:** Draft (design), pending builder check. Evidence upgraded by the
2026-10-18 channel research pass (D2/D4 HIGH confidence, D3 MEDIUM; §11
probe is verification, not a gate).
**Work lives in:** `github.com/medeiroshudson/antigravity-wrapper`
**Spec category:** Compatibility / Fidelity
**Scope:** Wave 1 of the consolidated analysis (2026-10-18): the changes that
directly improve the result the user sees. Concurrency, metrics, ledger and
crypto are out of this document — they are waves 2–3.

---

## 1. Context and Problem Statement

The wrapper's pool, failover and streaming machinery is measured and hardened.
The **translation layer is not**: several OpenAI contract fields are dropped on
the floor without an error, a warning, or a replacement. Two external audits
(2026-10-18, field-by-field) converged on the same picture:

1. **Silent acceptance.** The body schema (`src/routes/chat.ts:36-50`) has no
   `additionalProperties: false` and does not declare most OpenAI fields, so a
   client can send `temperature`, `response_format`, `stop`… and the wrapper
   accepts and discards them without any trace.
2. **Generative fields lost on the request** — the model runs at catalog
   defaults the caller never asked for.
3. **Semantic fields lost on the response** — a security refusal is reported
   as a normal completion; usage never reaches streaming clients.

The consequence today: a client asking for `{"response_format":
{"type":"json_object"}}` gets free text; a client sending `stop: ["END"]`
gets the delimiter and everything after it in its content; a streaming client
cannot meter usage. These are degradations the caller cannot detect, which is
the worst kind.

## 2. Goals and Non-Goals

### Goals
- **G1.** Propagate into `generationConfig` every OpenAI field the upstream
  vocabulary demonstrably has a slot for: sampling, stopping and structured
  output.
- **G2.** Stop inventing `length`: unknown upstream finish reasons must not be
  reported as truncation.
- **G3.** A safety-blocked turn must be distinguishable from a completed turn.
- **G4.** Streaming parity: usage in the stream, under `include_usage`.
- **G5.** No silent drops anywhere in the translation layer: a field the
  wrapper cannot honour is either rejected with a 400 naming it (breaking
  change) or carried with a `warnings[]` array on the response (default).
- **G6.** Backwards compatibility: existing behavior is preserved for every
  caller correct today.

### Non-Goals
- Image/audio multimodality end to end. Building `inlineData` without a live
  probe is guessing at an unmeasured channel; it gets its own spec after the
  probe (§11).
- `n>1`/`candidates[1..]`, penalties (`presence_penalty`, `frequency_penalty`,
  `logit_bias`), `logprobs`, `seed`, `user`, legacy `function_call` role
  parsing, `parallel_tool_calls`: they become **declared as ignored**
  (warnings), which is honest and implements nothing speculative.
- Tool choice enforcement beyond the existing prompt emulation.
- Performance, metrics, quotas (waves 2–3).

## 3. Evidence Base

Everything below cites a file/line measured during the 2026-10-18 audits, plus
the references at the bottom.

| Audit finding | Anchor |
|---|---|
| Schema declares only `model/messages/stream/reasoning_effort/max_tokens/tools/tool_choice` | `src/routes/chat.ts:36-50` |
| `textOf` drops `image_url`/`input_audio`/`file` | `src/lib/chat/compose.ts:20-35` |
| `GeminiRequestBody.generationConfig` only has `maxOutputTokens` + `thinkingConfig` | `src/lib/antigravity/envelope.ts:26-29` |
| `finishReason` catch-all returns `"length"` | `src/lib/chat/turn.ts:67-72` |
| `tool_calls` finish mask even `content_filter` | `src/lib/chat/turn.ts:324` |
| `promptFeedback`/`safetyRatings` never read; `StreamCandidate` lacks the fields | `src/lib/antigravity/rpc.ts:120-124` |
| `part.thought` discarded, despite `includeThoughts` being requested for effort > off | `src/lib/chat/turn.ts:252` |
| No usage chunk in the stream; `stream_options` undeclared | grep negative, `src/routes/chat.ts:254-395` |
| usage: `prompt − cacheRead` (sub-reports); `completion + thoughts` correct; detail fields dropped | `src/lib/chat/turn.ts:262-272` |
| 404 model errors are branded `server_error` | `src/lib/openai-format/index.ts:154-177` |
| Reasoning: `parseArgs` collapses invalid JSON to `{}` | `src/lib/chat/compose.ts:37-47` |
| Tool with unresolvable `$ref` omitted silently | `src/lib/chat/tools.ts:163-164` |
| Legacy schema allowlist drops keywords silently | `src/lib/chat/tools.ts:73-93` |
| `max_completion_tokens` unaccepted — clients get catalog default | `src/routes/chat.ts:36-50` |
| Unknown `reasoning_effort` falls back to `"off"` silently | `src/config/models.ts:6-10` |

## 4. Key Metric

**Fidelity gap** = number of OpenAI request/response fields that alter the
user-visible result but are dropped or misreported today. The baseline audit
counted **24** (request: content blocks, response_format, temperature, top_p,
stop, seed, n, user, penalties, logit_bias, logprobs, max_completion_tokens,
parallel_tool_calls; response: unknown finish_reason, safety refusal, usage
details, stream usage, error type for 404). Target for wave 1: at most **11
declared-ignorable** remain, each surfacing in `warnings[]`, zero silent.

## 5. The over-arching decision D1 — Bad-warn-fat caller notification

**D1. Warn, don't reject: unknown or unsupportable fields surface in a
top-level `warnings[]` array** (chunk-attached in streaming, top-level in
non-stream) and never abort the request.

Rationale: in a personal proxy the caller is usually the user's own tooling
(OpenCode, Cline, scripts): rejecting on `temperature` because one is 422-
strict breaks workflows that were "working" (visibly degraded). A warning
array is additive (G6), and it is exactly the trade-off pre-quality gateway
implementations took (LiteLLM's drop-with-metadata analogy: the caller keeps
the on-off difference, but always knows what was lost).

Shape (both modes):

```json
"warnings": [{ "field": "response_format.json_schema",
               "reason": "not supported upstream; free text will be returned" }]
```

Rules:
- `field` uses the dotted request path (`temperature`, `tools[0].function…`,
  `messages[2].content[0].image_url`).
- `reason` short English phrases in i18n (`warn.*` keys, one per class).
- warnings do not invalidate the response; they are metadata. No new HTTP
  status is introduced by D1.
- Non-stream: `warnings[]` top-level on `chat.completion`. Stream: warnings
  ride the **finish-reason chunk** (the last `choices`-bearing frame before
  `[DONE]`) — that chunk exists in every stream, so the policy is uniform and
  there is no extra frame type. When `include_usage` is on, the usage chunk
  also carries the same `warnings[]` (belt-and-suspenders, so a client that
  reads only the usage frame still sees them). A stream with no warnings is
  byte-identical to today (G6). A client that never requested usage but
  receives the finish-reason chunk today will find the extra optional key;
  OpenAI chunk shapes tolerate additive optional fields — the only strict
  break is byte-equality test suites (§9).

## 6. Request fields (D2–D6)

### D2. Sampling fields → generationConfig

`temperature`, `top_p`, `top_k` map directly:

| OpenAI | `GeminiRequestBody.generationConfig` |
|---|---|
| `temperature` (number) | `temperature: number` |
| `top_p` (number) | `topP: number` |
| `top_k` (number, non-standard OpenAI field some clients send) | `topK: number` |

**HIGH evidence of channel acceptance** (reverse-engineered spec table;
CLIProxyAPI and hermes-agent both send these camelCase names live). The
canonical casing is the public Gemini API's (https://ai.google.dev/api/generate-content,
js-genai `GenerationConfig`).

**Rule: accept OpenAI's full range; the wrapper does not clamp.** The
upstream applies its own bounds (0.0–2.0 for temperature per the channel
spec); a rejected value surfaces as a `client_error` 400 (existing behavior,
adequate — the caller learns the boundary from the error instead of the
gateway inventing one). Divergent clamping in the wrapper would be a second,
divergent source of truth. One documented channel note: Gemini-3-family docs
recommend `temperature = 1.0` for thinking models; the wrapper stays
pass-through (the caller's choice), not a policy layer.

`max_completion_tokens` becomes an accepted alias of `max_tokens`:
`max_tokens && max_completion_tokens` present and different → 400
invalid_request; else merge (newer clients send only the new field). This
also matches CLIProxyAPI, which reads either field. **Interaction to
preserve:** the existing clamp `Math.min(input.maxTokens ?? default,
maxOutputTokens)` (`turn.ts:227`) must continue to respect the channel
constraint `maxOutputTokens > thinkingBudget` (reverse-engineered spec's
400 rule) — the builder must verify which component owns the
thinkingBudget/maxOutputTokens reconciliation and keep it single-sourced.

- `envelope.ts`: `GeminiRequestBody.generationConfig` gains optional
  `temperature?: number; topP?: number; topK?: number;` — `topP`/`topK`, not
  snake_case, matching the public Gemini API casing.
- `turn.ts` `buildEnvelope` call site must pass them through the existing
  `EnvelopeInput`, extended, not mutated.

### D3. `stop` → `stopSequences`

| OpenAI | generationConfig |
|---|---|
| `stop: string \| string[]` | `stopSequences: string[]` (all entries) |

- string → `[string]`. Empty array → omit field (a `stopSequences: []` is a
  no-op request field; sending it as `[]` would be a schema error on some
  validators).
- This is the single most degrading ignored field today (the literal
  delimiter arrives in content).
- **Evidence status: MEDIUM.** `stopSequences` appears in the
  reverse-engineered channel spec ("Verified by Direct API Testing",
  npdkdev/opencode-agy-auth, `docs/ANTIGRAVITY_API_SPEC.md`) and hermes-agent
  sends it, but CLIProxyAPI — the most mature mapper on this channel —
  deliberately does **not** map OpenAI `stop`, and no project verifies an
  observed stream truncation. The D3 probe (§11) tests it: marker prompt +
  `stopSequences=[marker]`, checking truncation, final `finishReason`, and
  whether `candidate.stopSequence` arrives populated. **Failure mode of the
  field being silently ignored upstream is exactly today's behavior plus a
  D1 warning**, so shipping the mapping un-probed is safe either way; the
  probe only decides whether documentation promises the truncation.
- **Per-request warning policy (D3 field only):** until the probe confirms
  honoring, a mapped `stop` carries a Standing warning ("stop requested; upstream
  honoring is unverified — the delimiter may appear in content"), and after a
  passing probe the warning is removed (doc becomes the contract). This is
  one field, not a policy: every other mapped field (D2, D4) has HIGH
  evidence, so no warning is warranted there.
- Do not invent `candidate.stopSequence` downstream: only the finish reason is
  preserved (CLIProxyAPI PR #5230 precedent — the channel sometimes omits
  finishReason entirely; their synthesized STOP is why D7's map keeps a
  catch-all instead of erroring).

### D4. `response_format` — measured, then mapped

`response_format` is currently absent from schema, reader, and envelope type.
The plan:

- Accept `{"type":"json_object"}` and `{"type":"json_schema", "json_schema":
  {name, strict?, schema}}` in the schema.
- **Evidence is HIGH and the probe is therefore a verification, not a
  gate:** CLIProxyAPI maps `response_format` on this exact channel to
  `request.generationConfig.responseMimeType = "application/json"` +
  `request.generationConfig.responseSchema` (PR #4651, tests fixture the
  fields), and reports the upstream honors the legacy `responseSchema`
  spelling while **ignoring `responseJsonSchema`**. LiteLLM and Vercel AI
  SDK map the same way on the public Gemini API.
  - **D4a (adopted default):** map to `responseMimeType`/`responseSchema`.
  - **D4b (fallback, retained):** if the §11 probe shows our account tier or
    envelope path rejects the fields, do NOT map; warn instead. The probe is
    confirmation, not a decision blocker — unlike the earlier draft, shipping
    D4a without the probe is defensible, but the probe still runs first
    (minutes) because a rejected field would 400 *every* json-mode request
    the caller makes, which is worse than today's free text.
  - **Builder-access contingency:** if the probe cannot run at build time
    (no available account), ship **D4a behind a one-line kill switch** in
    `config/index.ts` (`GENERATION_CONFIG_MAP=off` skips the mapping and
    emits the D4b warning instead) and run the probe before the next real
    use. The kill switch is the documented rollback if any account tier
    starts 400ing json-mode requests — nothing else changes.
- **Schema sanitization is mandatory** (channel 400-matrix from the
  reverse-engineered spec): `type/properties/required/description/enum/
  items/anyOf/allOf/oneOf/additionalProperties` survive; `const`, `$ref`,
  `$defs`/`$definitions`, `$schema`, `$id`, `default`, `examples` are
  stripped with a D13-style aggregate warning per json_schema request
  (LiteLLM independently strips `additionalProperties`/`strict` before
  sending — same lesson, quote: "schemas unsupported by Google's OpenAPI
  version"). Reuse the tools `$ref` dereferencer where possible, but note it
  dereferences rather than strips; the sanitize step is a separate filter
  pass over the dereferenced tree.
- `strict` is not translated (upstream concept absent; the schema carries
  the intent).
- OpenAI `type:"text"` → no-op, no warning.

### Family coverage (D2–D4 scope decision)

All model families share ONE request path (`turn.ts:221-234` — a single
`buildEnvelope` → `streamGenerate(${endpoint}/v1internal:streamGenerateContent?alt=sse)`,
no per-family fork; the only family-specific treatment today is
`used_claude`/`used_non_gemini_model` labels and the tools schema encoding).
The mapping is therefore **uniform across families** (no scoping): a
claude/gpt runtime rejecting `temperature` would surface as a `client_error`
400 under existing classification, not silent corruption — same failure mode
the probes already cover. Windows: keep the §11 probe pointed at one Gemini
runtime first (all cited evidence), then one claude runtime and one gpt
runtime for a 2-minute acceptance check each (200 vs 400 is all that is
needed). Chris's note: if any non-Gemini family 400s a mapped field, scope
that field per-family at build time — the builder gate keeps it a content
decision, not a design one.

### D5. Declared-ignored fields (warn only)

`n`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`,
`top_logprobs`, `seed`, `user`, `parallel_tool_calls`, `service_tier`,
`store`, `metadata`, `stream_options` beyond `include_usage`.
Implementation: one constant list of field names checked against the parsed
body; each present-but-unsupported field appends its warning. i18n: one
shared phrase, parameterised by field name, plus a per-field note where a
phrase would otherwise mislead (`n` → "only one choice is returned").

**Schema strictness (builder Q3, settled):** the body schema stays
**permissive** (no `additionalProperties: false`). A field outside the mapped
set and outside the D5 list gets a **single generic warning** (`field:
"<name>", reason: "field is not recognized by the wrapper and was ignored"`).
Rationale: `additionalProperties:false` would 400 client typos and
not-yet-invented OpenAI fields — precisely the workflow-breaking behavior D1
rejects — while the generic warning keeps G5's zero-silent guarantee without
requiring the D5 list to be exhaustive. The D5 list exists to give those
fields *specific* explanations; unrecognized ones get the generic one.
Auth/transport errors keep existing strictness (Fastify schema for
`model`/`messages` required, and 400 for malformed JSON, unchanged).

### D6. `reasoning_effort` strictness

An unrecognized effort currently falls back to `off` silently
(`models.ts:6-10`). Change: unknown string → **400** `invalid_request_error`
naming the accepted vocabulary. Rationale: `effort` selects a model variant
with real cost (thinking budget); a typo silently disabling reasoning is a
degradation the caller must be able to see. Breaking change is bounded and
desirable (G6 keeps correct callers identical).

## 7. Response fields (D7–D10)

### D7. finish_reason: stop inventing `length`

New mapping:

| Upstream | OpenAI |
|---|---|
| `STOP` | `stop` |
| `MAX_TOKENS` | `length` |
| `SAFETY`, `RECITATION` | `content_filter` |
| anything else | **`stop`** + `warnings[]` entry `{field: "finish_reason", reason: unknown <raw> reported as stop}` |

- Rationale: an unknown reason is not evidence of truncation. OpenAI's own
  enum ends at `stop/length/tool_calls/content_filter/function_call`; of
  these, `stop` is the only honest default for "the model finished speaking"
  (Gemini's `OTHER`/`UNKNOWN`/null-terminated cases).
- `tool_calls` mask stays (a turn that emitted calls is a tool_calls turn)
  **except** when the raw reason is SAFETY/RECITATION, which still wins:
  the calls were emitted but the turn was censored mid-turn — the caller
  must see `content_filter` (parity decision, fixes the audit's finding).

### D8. Safety visibility

`StreamCandidate` (`rpc.ts:120-124`) gains
`promptFeedback?: { blockReason?: string }` and the readSse candidate path
records the first non-null `blockReason` into the turn outcome as
`blocked?: string`. Mapping:

| Situation | Result |
|---|---|
| `promptFeedback.blockReason` present | upstream text discarded, **HTTP 200 non-stream** with `finish_reason:"content_filter"`, content `""`, and warnings entry naming the blockReason; stream variant: error frame-shaped info? No — keep byte flow: emit `finish_reason: content_filter` chunk + `[DONE]`, plus the warning on that final chunk |
| raw `finishReason` SAFETY/RECITATION | `content_filter` via D7 (already) |

- If content already streamed before the block, we do NOT retroactively
  retract it (impossible mid-stream); the final chunk carries the honest
  finish reason and warning.
- Non-stream with block: the blocked prompt never generates; returning empty
  content instead of a refusal text we cannot distinguish from a normal
  completion is the *measurable* improvement; the warning names the reason
  ("PROHIBITED_CONTENT…"), which is what the audit reference implementations
  surface.

### D9. usage: full-fidelity numbers + stream chunk

- `TurnResult.usage` gains `prompt_tokens` = **`promptTokenCount`** (gross,
  OpenAI-like; see note), `completion_tokens` =
  `candidatesTokenCount + thoughtsTokenCount` (unchanged), `total_tokens` =
  `totalTokenCount` (unchanged), and detail objects:
  `prompt_tokens_details: {cached_tokens: cacheRead}`,
  `completion_tokens_details: {reasoning_tokens: thoughts}`.
- Note on the `prompt − cacheRead` subtraction today: OpenAI bills the
  *gross* prompt in `prompt_tokens` and exposes cached as a detail. The
  current wrapper under-reports by `cacheRead`; the fix makes the number
  the caller learns match their provider dashboards better — cache reads
  cost (much) less, not zero.
- **D4 of streaming: usage chunk before `[DONE]`.** Emit the final chunk
  with `delta: {}`, `finish_reason` *included in the same frame*, top-level
  `usage` object, **when** the client asked (D4a) or never asked (D4b):
  - `stream_options.include_usage: true` → final chunk has `usage` and the
    preceding choices-empty convention is observed: the usage chunk carries
    `choices: []` exactly as OpenAI does (one extra frame, spec-compliant),
    and the finish-reason chunk stays as it is today.
  - `include_usage` absent/false → no extra frame (today's contract, G6).
- Stream chunk builder (`openai-format/index.ts`) needs the optional usage
  and `choices: []` capability.

### D10. Error typing for 404 model

`toOpenAIErrorBody` maps 404 to `{type:"invalid_request_error",
code:"model_not_found"}` (today: `server_error`/`antigravity_error`).
The `detectStatus` chain continues to pass 404 through as terminal — only
the branding changes. Other statuses unchanged. The OpenAI SDK maps this
code into a typed error the caller can catch, which is the whole point.

## 8. Prompt-side small repairs (D11–D13)

### D11. Warn on dropped content blocks

`textOf` keeps its behavior, but `toContents` returns
`{contents, systemInstruction, dropped: string[]}` where `dropped` lists
index-role-field of each block it discarded (`messages[1].image_url`).
Route turns them into `warnings[]` entries. Cost: one loop, no behavior
change (G6).

### D12. parseArgs failure is now a warning, not a lie

`compose.ts:37-47` returns `{}` at two sites silently. To keep
`toContents` a pure function, thread a collector: `{contents, …,
parseWarnings: [{toolCallId, raw: <first 80 chars>}]} → warnings[]` at
route level, i18n phrase "tool call arguments were not valid JSON and were
sent empty". Low frequency, high confusion potential when it happens.

### D13. Tool omission and legacy-schema keywords

- Tool omitted for unresolvable `$ref` (`tools.ts:163-164` → `warnings[]`:
  "tool '<name>' was omitted: unresolvable $ref").
- Legacy path strips keywords silently today; emit one **aggregate**
  warning per tool: `tools[i].parameters: unsupported schema keywords were
  dropped: anyOf, format, additionalProperties`. One warning per tool (not
  per keyword) keeps the array readable.

## 9. Compatibility matrix

| Caller habit | Today | After wave 1 |
|---|---|---|
| sends `temperature`/`top_p`/`stop` | accepted, discarded silently | propagated to generationConfig (D2/D3); warn only if upstream rejects |
| sends `response_format: json_object` | free text, silent | mapped per D4-probe, or warning D4b |
| sends `max_completion_tokens` | field ignored entirely | honored as alias (D2) |
| sends unknown `reasoning_effort` | silently "off" | 400 naming vocabulary (D6) |
| streams without `stream_options` | no usage frames | unchanged (G6) |
| streams with `include_usage` | no usage frames | usage frame before `[DONE]` (D9) |
| gets unknown finish reason | `length` | `stop` + warning (D7) |
| safety-blocked prompt | refusal text as `stop`, or opaque 503 | `content_filter` + blockReason warning (D8) |
| checks `error.code/model_not_found` | gets `server_error` | typed 404 (D10) |
| asserts on exact response body shape | `warnings[]` addition is additive-only; strict-equality tests in the wild **may** break | flagged as the only known compatible break, §10 |

## 10. Testing (TDD Order)

New test files:
- `tests/generation-config.test.ts` — temperature/topP/stopSequences/max_completion_tokens aliasing, conflicting alias 400, empty stop array omission, envelope passthrough.
- `tests/response-format.test.ts` — section D4: probe-pass branch (mapping)
  and probe-fail branch (warning), text no-op.
- `tests/finish-reason.test.ts` — mapFinishReason table incl. raw-unknown →
  stop + warning; tool_calls vs SAFETY precedence (D7).
- `tests/safety-block.test.ts —` promptFeedback present → content_filter +
  empty content non-stream; streamed-then-blocked; no-content no-block
  regression of the earlier behavior.
- `tests/stream-usage.test.ts` — include_usage true/false/absent;
  choices:[] shape; warnings attach to final chunk; D1 always-attached.
- `tests/warn-schema.test.ts` — declared-ignored list returns warnings per
  field; i18n keys exist (schema-like golden test).
- Extend `openai-format` tests: error branding 404, usage chunk builder.
- Extend `compose`/`tools` tests: dropped-blocks warnings, parseArgs
  warning (with fixture of truncated JSON), tool omission/ref-keywords.

Existing tests updated: finish_reason expectations that locked `length`
(as unknown raw), error body shape, `mapFinishReason` cases in turn.test.
Everything else must stay green unchanged (G6 verified by CI).

Isolation: no new env vars are strictly required. `WRAP_UNKNOWN_EFFORT`
stays unsupported — D6 is unconditional (one less knob).

## 11. The live probe (D3/D4 verification) — 10-minute experiment

Before implementing, run against the dev wrapper with a real account —
per-field, one at a time, fixed prompt, documenting envelope dumps and
status/rejection per variant (channel evidence notes this is how two specs
were reverse-engineered by third parties; hermes-agent and CLIProxyAPI are
the cross-checks we already matched):

1. A tiny `scripts/probe-generation-config.mts` builds an envelope by hand
   (imports `buildEnvelope`), calls `streamGenerate` with the pool's
   `ensureFresh` account token, and prints status + first 200 bytes of the
   SSE per variant:
   - (a) baseline envelope;
   - (b) `temperature` 0 / 1.0 / 2.0 and `topP`/`topK` extremes (200/400 and
     perceptible-difference check only);
   - (c) `responseMimeType:"application/json"` with no prompt instruction —
     expect parsed JSON if honored;
   - (d) `responseSchema` with a small schema, then one with `const`/`$ref`/
     `$defs`/`default`/`examples` — confirm the channel 400-matrix (those
     keys rejected) to validate the sanitizer list;
   - (e) `stopSequences:[marker]` with a unique marker mid-prompt — check
     truncation, final `finishReason`, `candidate.stopSequence` presence;
   - (f) maxOutputTokens vs thinkingBudget boundary (constraint `>` check).
2. Outcomes: 200 honoring → adopt (D4a confirmed; D3 documented);
   200 ignoring → field works as today + D1 warning (still safe to ship);
   400 → strip field, D4b/D3b warn path.
3. This probe script is throwaway; it does not enter CI. Rotating it in
   tree as `scripts/` is fine.

The probe cost is minutes and converts the remaining "medium/low confidence"
cells into measured decisions — consistent with how this project already
works (specs refined by live probe, e.g. the 2026-10-13 quota spec).

## 12. What's left to the builder (and what was settled)

Post-builder-check dispositions:

- **Answered already (this conversation/repo):** family coverage (§6 — one
  path, uniform mapping, 2-minute per-family probe check), streaming-warning
  carrier (§5 — finish-reason chunk), schema strictness (§6 D5 — permissive
  + generic warning), D4 probe-access default (§6 D4 — D4a + kill switch).
- **Settled by the builder's check as minor, marked as calls (not the
  human's):** D3 standing warning until probe (§6 D3); D5 list not required
  to be exhaustive (§6 D5).
- **Theirs (only the human can answer):** availability of a dev account to
  run the §11 probe (the D4 kill-switch default makes this non-blocking).
- Exact i18n key names and phrasing (en-US only, matching existing style).
- The `warnings[]` TS type (suggested: `{field: string; reason: string}`)
  and where it lives (`openai-format` or a new `translate/diagnostics.ts`).
- Whether the declared-ignored field list should live in config (env) for
  silencing — our call: no, keep it a constant; no env knob without need
  (the D4 kill switch exists only because its failure mode is a 400 on
  every json-mode request, which is a different class).
- Chunk ordering details in D9 when usage + warnings coexist (they share
  the final frame; document the decided shape in a test).
- The probe script's exact argument handling (§11).
- Unit-test organization: new files listed in §10 are a default, may be
  reorganized if a module boundary suggests better.

## 13. References

- Field audit (2026-10-18): field-by-field gap table with file:line anchors (conversation record).
- Channel generationConfig evidence (2026-10-18 research pass):
  - Reverse-engineered channel spec (table "Verified by Direct API Testing"):
    https://raw.githubusercontent.com/npdkdev/opencode-agy-auth/HEAD/docs/ANTIGRAVITY_API_SPEC.md
  - CLIProxyAPI OpenAI→Antigravity translator:
    https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/translator/antigravity/openai/chat-completions/antigravity_openai_request.go
  - CLIProxyAPI PR #4651 (response_format → responseMimeType/responseSchema on this channel):
    https://github.com/router-for-me/CLIProxyAPI/pull/4651
  - CLIProxyAPI PR #5230 (channel sometimes omits finishReason; synthesized STOP precedent):
    https://github.com/router-for-me/CLIProxyAPI/pull/5230
  - hermes-agent code-assist adapter (envelope + stopSequences sender):
    https://raw.githubusercontent.com/wiki3-ai/hermes-agent/main/agent/gemini_cloudcode_adapter.py
  - LiteLLM JSON mode → response_mime_type/response_schema + schema-stripping lesson:
    https://docs.litellm.ai/docs/completion/json_mode
- LiteLLM reliability (cooldown/fallback shapes referenced by wave-2, context only):
  https://docs.litellm.ai/docs/proxy/reliability
- OpenRouter streaming contract (mid-stream error framing, pre-stream-only failover):
  https://openrouter.ai/docs/api_reference/errors-and-debugging
- Gemini API GenerationConfig canonical names:
  https://ai.google.dev/api/generate-content
- OpenAI Chat Completions reference:
  https://platform.openai.com/docs/api-reference/chat
