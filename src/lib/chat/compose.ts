import { t } from "../../i18n/index.js";
import type { GeminiContent, GeminiPart } from "../antigravity/envelope.js";
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
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(t("chat.messagesEmpty"));
  }

  const strict = opts.strictThoughtSignatures === true;
  const contents: GeminiContent[] = [];
  const systemParts: string[] = [];

  // The upstream requires functionResponse.name to name the functionCall it answers.
  // `name` on an OpenAI tool message is optional and clients pair by tool_call_id, so
  // the authoritative name comes from the paired call; a placeholder ("tool") made the
  // native Gemini path reject the whole request with a generic 400 (measured).
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    if ((message.role ?? "").toLowerCase() !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (typeof call.id === "string" && call.id && typeof name === "string" && name) {
        nameByCallId.set(call.id, name);
      }
    }
  }
  // Calls textualized under `strictThoughtSignatures`; their responses must be
  // textualized too, or the orphan functionResponse breaks the same rule.
  const textualized = new Set<string>();

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
        // OpenAI clients drop the non-standard thoughtSignature when echoing the
        // assistant turn back; the wrapper remembers it and reattaches it, because the
        // upstream rejects an unsigned history (see signatures.ts). The bank is
        // authoritative over an echo, which a client may have truncated.
        const signature = (call.id ? recallSignature(call.id) : null) ?? call.thoughtSignature ?? null;
        if (strict && signature === null) {
          textualized.add(call.id ?? "");
          parts.push({ text: `used tool "${name}" with arguments ${call.function?.arguments ?? "{}"}` });
          continue;
        }
        const part: GeminiPart = {
          functionCall: {
            name,
            args: parseArgs(call.function?.arguments),
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
      if (strict && textualized.has(message.tool_call_id ?? "")) {
        pushTurn(contents, "user", [
          { text: `tool "${nameByCallId.get(message.tool_call_id ?? "") ?? message.name ?? "tool"}" returned: ${text}` },
        ]);
        continue;
      }
      const name = nameByCallId.get(message.tool_call_id ?? "") ?? message.name ?? "tool";
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
