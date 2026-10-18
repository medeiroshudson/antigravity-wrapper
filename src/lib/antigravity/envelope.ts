import { getRandomValues, randomUUID } from "node:crypto";

export interface GeminiTextPart { text: string; thoughtSignature?: string }
export interface GeminiThoughtPart { thought: true; text: string; thoughtSignature?: string }
export interface GeminiInlineDataPart { inlineData: { mimeType: string; data: string } }
export interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
}
export interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: { output?: string; error?: string }; id?: string };
}
export type GeminiPart =
  | GeminiTextPart
  | GeminiThoughtPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export type GeminiRole = "user" | "model";
export interface GeminiContent { role: GeminiRole; parts: GeminiPart[] }

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction: { role: "user"; parts: GeminiTextPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: { includeThoughts: boolean; thinkingBudget: number };
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: unknown;
  };
  tools?: { functionDeclarations: unknown[] }[];
  sessionId?: string;
  labels?: Record<string, string>;
}

export interface AntigravityRequest {
  project: string;
  model: string;
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
  request: GeminiRequestBody;
}

export interface EnvelopeInput {
  projectId: string;
  runtimeModel: string;
  contents: GeminiContent[];
  systemInstruction: string;
  thinking: { includeThoughts: boolean; thinkingBudget: number };
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
  tools?: { functionDeclarations: unknown[] }[];
  sessionId: string;
  labels: Record<string, string>;
  requestId: string;
}

function randomInt64(): string {
  const bytes = getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigInt64(0, true).toString();
}

export function newRequestIdentity(
  runtimeModel: string,
  opts: { step?: number; requestIndex?: number } = {},
): {
  conversationId: string;
  trajectoryId: string;
  requestId: string;
  labels: Record<string, string>;
  sessionId: string;
} {
  const step = Math.max(1, opts.step ?? 1);
  const requestIndex = opts.requestIndex ?? Math.max(0, step - 1);
  const conversationId = randomUUID();
  const trajectoryId = randomUUID();
  const isClaude = runtimeModel.startsWith("claude-");
  const isNonGemini = !runtimeModel.startsWith("gemini-");

  const labels: Record<string, string> = {
    last_step_index: String(Math.max(0, step - 1)),
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: isClaude ? "true" : "false",
    used_claude_conservative: isClaude ? "true" : "false",
    used_non_gemini_model: isNonGemini ? "true" : "false",
  };
  if (step > 1) labels.last_execution_id = `exec-${trajectoryId}-${step - 1}`;

  return {
    conversationId,
    trajectoryId,
    requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
    labels,
    sessionId: randomInt64(),
  };
}

export function buildEnvelope(input: EnvelopeInput): AntigravityRequest {
  const generationConfig: NonNullable<GeminiRequestBody["generationConfig"]> = {
    maxOutputTokens: input.maxOutputTokens,
    thinkingConfig: input.thinking,
  };
  if (input.temperature !== undefined) {
    generationConfig.temperature = input.temperature;
  }
  if (input.topP !== undefined) {
    generationConfig.topP = input.topP;
  }
  if (input.topK !== undefined) {
    generationConfig.topK = input.topK;
  }
  if (input.stopSequences && input.stopSequences.length > 0) {
    generationConfig.stopSequences = input.stopSequences;
  }
  if (input.responseMimeType !== undefined) {
    generationConfig.responseMimeType = input.responseMimeType;
  }
  if (input.responseSchema !== undefined) {
    generationConfig.responseSchema = input.responseSchema;
  }

  const request: GeminiRequestBody = {
    contents: input.contents,
    systemInstruction: { role: "user", parts: [{ text: input.systemInstruction }] },
    generationConfig,
    labels: input.labels,
    sessionId: input.sessionId,
  };
  if (input.tools && input.tools.length > 0) request.tools = input.tools;

  return {
    project: input.projectId,
    model: input.runtimeModel,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: input.requestId,
    request,
  };
}
