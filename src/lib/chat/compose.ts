import { t } from "../../i18n/index.js";
import type { GeminiContent, GeminiPart } from "../antigravity/envelope.js";

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

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
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
 */
export function toContents(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction: string;
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(t("chat.messagesEmpty"));
  }

  const contents: GeminiContent[] = [];
  const systemParts: string[] = [];

  for (const message of messages) {
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
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        const part: GeminiPart = {
          functionCall: {
            name,
            args: parseArgs(call.function?.arguments),
            ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
          },
        };
        if (typeof call.thoughtSignature === "string" && call.thoughtSignature) {
          (part as { thoughtSignature?: string }).thoughtSignature = call.thoughtSignature;
        }
        parts.push(part);
      }
      pushTurn(contents, "model", parts);
      continue;
    }

    if (role === "tool") {
      const text = textOf(message.content);
      const name = message.name ?? "tool";
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

  return { contents, systemInstruction: systemParts.join("\n\n") };
}
