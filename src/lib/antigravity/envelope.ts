import { getRandomValues } from "node:crypto";
import type { ThinkingConfig } from "../../config/models.js";

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

export type GeminiTool =
  | { functionDeclarations: unknown[] }
  | { googleSearch: Record<string, unknown> };

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction: { role: "user"; parts: GeminiTextPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    thinkingConfig?: ThinkingConfig;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: unknown;
  };
  tools?: GeminiTool[];
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
  thinking: ThinkingConfig;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
  tools?: GeminiTool[];
  enableWebSearch?: boolean;
  sessionId: string;
  labels: Record<string, string>;
  requestId: string;
}

export function randomInt64(): string {
  const bytes = getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigInt64(0, true).toString();
}

/**
 * The identity of one conversation, stable across its turns. Measured 2026-11-09: the
 * client keeps one `cascade_id` and one `trajectory_id` for a whole conversation, reuses
 * the same `sessionId`, and per turn only moves `last_step_index` / `request_id`.
 */
export interface ConversationIdentity {
  cascadeId: string;
  trajectoryId: string;
  sessionId: string;
  /**
   * 1-based number of the step being requested. The URL carries it as-is and
   * `last_step_index` carries `step - 1`, which is how the client sends a cascade whose
   * steps already exist: measured 0 -> 1, then 3 -> 4 for the second turn.
   */
  step: number;
  /** 0-based count of API requests already made in this cascade, for `request_id`. */
  requestIndex: number;
  /** The previous request's execution id, sent as `last_execution_id` from the 2nd request. */
  lastExecutionId: string | null;
}

export interface RequestIdentity {
  cascadeId: string;
  trajectoryId: string;
  requestId: string;
  labels: Record<string, string>;
  sessionId: string;
}

export function newRequestIdentity(
  runtimeModel: string,
  conversation: ConversationIdentity,
  modelEnum: string | null = null,
): RequestIdentity {
  const step = Math.max(1, conversation.step);
  const requestIndex = Math.max(0, conversation.requestIndex);
  const isClaude = runtimeModel.startsWith("claude-");
  const isNonGemini = !runtimeModel.startsWith("gemini-");

  const labels: Record<string, string> = {
    cascade_id: conversation.cascadeId,
    root_cascade_id: conversation.cascadeId,
    last_step_index: String(step - 1),
    request_id: `${conversation.trajectoryId}-${requestIndex}`,
    trajectory_id: conversation.trajectoryId,
    used_claude: isClaude ? "true" : "false",
    used_claude_conservative: isClaude ? "true" : "false",
    used_non_gemini_model: isNonGemini ? "true" : "false",
  };
  // Measured on the second turn: a UUID naming the execution the previous request ran in.
  // Absent on the first request, where there is no previous execution to name.
  if (conversation.lastExecutionId !== null) labels.last_execution_id = conversation.lastExecutionId;
  if (modelEnum !== null) labels.model_enum = modelEnum;

  return {
    cascadeId: conversation.cascadeId,
    trajectoryId: conversation.trajectoryId,
    requestId: `agent/${conversation.cascadeId}/${Date.now()}/${conversation.trajectoryId}/${step}`,
    labels,
    sessionId: conversation.sessionId,
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
  const tools: GeminiTool[] = [];
  if (input.enableWebSearch && input.runtimeModel.startsWith("gemini-")) {
    tools.push({ googleSearch: {} });
  }
  if (input.tools && input.tools.length > 0) {
    tools.push(...input.tools);
  }
  if (tools.length > 0) {
    request.tools = tools;
  }

  return {
    project: input.projectId,
    model: input.runtimeModel,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: input.requestId,
    request,
  };
}
