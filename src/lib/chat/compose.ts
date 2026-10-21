import { t } from "../../i18n/index.js";
import type { GeminiContent, GeminiPart } from "../antigravity/envelope.js";
import type { Warning } from "./diagnostics.js";
import { recallSignature } from "./signatures.js";

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  thoughtSignature?: string;
}

export interface ChatMessage {
  role: string;
  content: string | null | unknown[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

function textOf(content: unknown): string {
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const text = (block as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

function collectDroppedContent(content: unknown, msgIdx: number, diagnostics: Warning[]): void {
  if (!Array.isArray(content)) return;
  for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
    const block = content[blockIdx];
    if (typeof block === "string") continue;
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        continue;
      }
      if (typeof b.text === "string" && !b.type) {
        continue;
      }
      let mediaType = "unknown";
      if (typeof b.type === "string" && b.type !== "text") {
        mediaType = b.type;
      } else if ("image_url" in b) {
        mediaType = "image_url";
      } else if ("input_audio" in b) {
        mediaType = "input_audio";
      } else if ("file" in b) {
        mediaType = "file";
      }
      const field =
        mediaType !== "unknown"
          ? `messages[${msgIdx}].content[${blockIdx}].${mediaType}`
          : `messages[${msgIdx}].content[${blockIdx}]`;
      diagnostics.push({
        field,
        reason: t("warn.droppedMedia", { type: mediaType }),
      });
    }
  }
}

function parseArgs(raw: string | undefined): { args: Record<string, unknown>; isInvalid?: boolean } {
  if (!raw) return { args: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, isInvalid: true };
  } catch {
    return { args: {}, isInvalid: true };
  }
}

function pushTurn(contents: GeminiContent[], role: "user" | "model", parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

/**
 * Converts OpenAI messages into Antigravity `contents`.
 * A tool-result turn becomes a `functionResponse` in a user turn, and the
 * Gemini `thoughtSignature` is preserved because without it the backend
 * rejects multi-turn continuity.
 *
 * `strictThoughtSignatures` (native Gemini path): a tool call the wrapper cannot sign —
 * no client signature and nothing in the bank — is textualized together with its
 * result, because an unsigned functionCall part makes the upstream reject the whole
 * request with 400 "missing a thought_signature" (measured). Signature-less calls
 * happen when the client made them through the 3p bridge (which signs nothing) or
 * before a server restart emptied the bank.
 */
export function toContents(
  messages: ChatMessage[],
  opts: { strictThoughtSignatures?: boolean } = {},
): {
  contents: GeminiContent[];
  systemInstruction: string;
  diagnostics: Warning[];
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(t("chat.messagesEmpty"));
  }

  const strict = opts.strictThoughtSignatures === true;
  const contents: GeminiContent[] = [];
  const systemParts: string[] = [];
  const diagnostics: Warning[] = [];

  // The upstream requires functionResponse.name to name the functionCall it answers.
  // `name` on an OpenAI tool message is optional and clients pair by tool_call_id, so
  // the authoritative name comes from the paired call; a placeholder ("tool") made the
  // native Gemini path reject the whole request with a generic 400 (measured).
  // Active tool names are tracked chronologically to prevent tool_call_id collisions
  // across turns from polluting earlier turns.
  const activeToolNames = new Map<string, string>();
  // Calls textualized under `strictThoughtSignatures`; their responses must be
  // textualized too, or the orphan functionResponse breaks the same rule.
  // State is tracked sequentially and removed once the response is consumed.
  const activeTextualized = new Set<string>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const message = messages[msgIdx]!;
    collectDroppedContent(message.content, msgIdx, diagnostics);
    const role = (message.role ?? "").toLowerCase();

    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      const toolCalls = message.tool_calls ?? [];
      for (const call of toolCalls) {
        const name = call.function?.name;
        if (typeof call.id === "string" && call.id && typeof name === "string" && name) {
          activeToolNames.set(call.id, name);
          activeTextualized.delete(call.id);
        }
      }
      for (let callIdx = 0; callIdx < toolCalls.length; callIdx++) {
        const call = toolCalls[callIdx]!;
        const name = call.function?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        const { args, isInvalid } = parseArgs(call.function?.arguments);
        if (isInvalid) {
          diagnostics.push({
            field: `messages[${msgIdx}].tool_calls[${callIdx}].function.arguments`,
            reason: t("warn.invalidToolArgs"),
          });
        }
        // OpenAI clients drop the non-standard thoughtSignature when echoing the
        // assistant turn back; the wrapper remembers it and reattaches it, because the
        // upstream rejects an unsigned history (see signatures.ts). The bank is
        // authoritative over an echo, which a client may have truncated.
        const signature = (call.id ? recallSignature(call.id) : null) ?? call.thoughtSignature ?? null;
        if (strict && signature === null) {
          if (typeof call.id === "string" && call.id) {
            activeTextualized.add(call.id);
          }
          parts.push({ text: `used tool "${name}" with arguments ${call.function?.arguments ?? "{}"}` });
          continue;
        }
        const part: GeminiPart = {
          functionCall: {
            name,
            args,
            ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
          },
        };
        if (signature !== null) {
          (part as { thoughtSignature?: string }).thoughtSignature = signature;
        }
        parts.push(part);
      }
      pushTurn(contents, "model", parts);
      continue;
    }

    if (role === "tool") {
      const text = textOf(message.content);
      const callId = message.tool_call_id ?? "";
      const fallbackName = (message.name && message.name !== "tool" ? message.name : undefined) ?? "tool";
      const name = (callId ? activeToolNames.get(callId) : undefined) ?? fallbackName;

      if (strict && callId && activeTextualized.has(callId)) {
        activeTextualized.delete(callId);
        pushTurn(contents, "user", [
          { text: `tool "${name}" returned: ${text}` },
        ]);
        continue;
      }
      const part: GeminiPart = {
        functionResponse: {
          name,
          response: /^error/i.test(text) ? { error: text } : { output: text },
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
        },
      };
      pushTurn(contents, "user", [part]);
      continue;
    }

    const text = textOf(message.content);
    if (text) pushTurn(contents, "user", [{ text }]);
  }

  return { contents, systemInstruction: systemParts.join("\n\n"), diagnostics };
}
