import type { CatalogEntry } from "../../src/config/models.js";

/**
 * The catalog one active account returned on 2026-10-13, filtered to the ids the
 * registry accepts. Measured, not invented: the display labels are the backend's own,
 * including the collisions and the mis-stated degrees that forced identity onto the id
 * (spec §3.5).
 */
export const CATALOG: readonly CatalogEntry[] = [
  { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)", maxTokens: 250_000, maxOutputTokens: 64_000, supportsThinking: true, thinkingBudget: 1024 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", maxTokens: 250_000, maxOutputTokens: 64_000, supportsThinking: true, thinkingBudget: 1024 },
  { id: "gemini-2.5-flash", displayName: "Gemini 3.5 Flash Lite", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-2.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-2.5-flash-thinking", displayName: "Gemini 3.5 Flash Lite", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: 1024 },
  { id: "gemini-3-flash", displayName: "Gemini 3 Flash", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-3-flash-agent", displayName: "Gemini 3.5 Flash (High)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.5 Flash Lite", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-3.5-flash-extra-low", displayName: "Gemini 3.5 Flash (Low)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 1000 },
  { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", maxTokens: 1_048_576, maxOutputTokens: 65_535, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash (Medium)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 4000 },
  { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: -1 },
  { id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 1000 },
  { id: "gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 4000 },
  { id: "gemini-3.8-flash-tiered", displayName: "-", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: -1 },
  { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", maxTokens: 131_072, maxOutputTokens: 32_768, supportsThinking: true, thinkingBudget: 8192 },
];
