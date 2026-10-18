import { t } from "../../i18n/index.js";

export interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

export interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
}

export interface StructuredGrounding {
  webSearchQueries: string[];
  sources: Array<{ title: string; url: string }>;
}

function resolveTitle(uri: string, title?: string): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(uri);
    return parsed.hostname || uri;
  } catch {
    return uri;
  }
}

function extractSources(chunks?: GroundingChunk[]): Array<{ title: string; url: string }> {
  if (!chunks || chunks.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const sources: Array<{ title: string; url: string }> = [];

  for (const chunk of chunks) {
    const uri = chunk.web?.uri?.trim();
    if (!uri) continue;
    if (seen.has(uri)) continue;
    seen.add(uri);

    const title = resolveTitle(uri, chunk.web?.title);
    sources.push({ title, url: uri });
  }

  return sources;
}

export function formatCitationsFooter(metadata?: GroundingMetadata): string {
  if (!metadata?.groundingChunks || metadata.groundingChunks.length === 0) {
    return "";
  }
  const sources = extractSources(metadata.groundingChunks);
  if (sources.length === 0) {
    return "";
  }
  const heading = t("search.sources");
  const bullets = sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
  return `\n\n---\n### ${heading}\n${bullets}`;
}

export function extractStructuredGrounding(
  metadata?: GroundingMetadata,
): StructuredGrounding | undefined {
  if (!metadata) {
    return undefined;
  }
  const webSearchQueries = metadata.webSearchQueries ? [...metadata.webSearchQueries] : [];
  const sources = extractSources(metadata.groundingChunks);
  if (webSearchQueries.length === 0 && sources.length === 0) {
    return undefined;
  }
  return {
    webSearchQueries,
    sources,
  };
}
