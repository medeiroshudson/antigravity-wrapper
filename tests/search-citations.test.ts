import { describe, expect, it } from "vitest";
import { formatCitationsFooter, extractStructuredGrounding } from "../src/lib/chat/grounding.js";

describe("search grounding formatting and citations", () => {
  it("formats citations footer with deduplicated sources", () => {
    const metadata = {
      webSearchQueries: ["Nobel 2024"],
      groundingChunks: [
        { web: { uri: "https://example.com/a", title: "Site A" } },
        { web: { uri: "https://example.com/b", title: "Site B" } },
        { web: { uri: "https://example.com/a", title: "Site A Duplicate" } },
      ],
    };

    const footer = formatCitationsFooter(metadata);
    expect(footer).toContain("### Fontes consultadas");
    expect(footer).toContain("- [Site A](https://example.com/a)");
    expect(footer).toContain("- [Site B](https://example.com/b)");
    // Duplicate excluded:
    expect(footer.match(/https:\/\/example\.com\/a/g)).toHaveLength(1);
    expect(footer.startsWith("\n\n---\n### Fontes consultadas\n")).toBe(true);
  });

  it("extracts hostname when title is empty or missing", () => {
    const metadata = {
      groundingChunks: [
        { web: { uri: "https://news.google.com/article/123", title: "" } },
        { web: { uri: "https://blog.example.org/post/456" } },
      ],
    };
    const footer = formatCitationsFooter(metadata);
    expect(footer).toContain("- [news.google.com](https://news.google.com/article/123)");
    expect(footer).toContain("- [blog.example.org](https://blog.example.org/post/456)");
  });

  it("returns empty string when no chunks exist", () => {
    expect(formatCitationsFooter(undefined)).toBe("");
    expect(formatCitationsFooter({})).toBe("");
    expect(formatCitationsFooter({ groundingChunks: [] })).toBe("");
  });

  it("returns empty string when chunks have no valid web uris", () => {
    expect(formatCitationsFooter({ groundingChunks: [{ web: {} }] })).toBe("");
    expect(formatCitationsFooter({ groundingChunks: [{ web: { uri: "" } }] })).toBe("");
    expect(formatCitationsFooter({ groundingChunks: [{}] })).toBe("");
  });

  it("extracts structured grounding for response choices", () => {
    const metadata = {
      webSearchQueries: ["term"],
      groundingChunks: [{ web: { uri: "https://foo.com", title: "Foo" } }],
    };
    const structured = extractStructuredGrounding(metadata);
    expect(structured).toEqual({
      webSearchQueries: ["term"],
      sources: [{ title: "Foo", url: "https://foo.com" }],
    });
  });

  it("extracts structured grounding with deduplication and hostname fallback", () => {
    const metadata = {
      webSearchQueries: ["term"],
      groundingChunks: [
        { web: { uri: "https://foo.com", title: "Foo" } },
        { web: { uri: "https://foo.com", title: "Foo Duplicate" } },
        { web: { uri: "https://bar.org/sub", title: "" } },
      ],
    };
    const structured = extractStructuredGrounding(metadata);
    expect(structured).toEqual({
      webSearchQueries: ["term"],
      sources: [
        { title: "Foo", url: "https://foo.com" },
        { title: "bar.org", url: "https://bar.org/sub" },
      ],
    });
  });

  it("returns undefined for extractStructuredGrounding when no queries and no sources exist", () => {
    expect(extractStructuredGrounding(undefined)).toBeUndefined();
    expect(extractStructuredGrounding({})).toBeUndefined();
    expect(extractStructuredGrounding({ groundingChunks: [] })).toBeUndefined();
    expect(extractStructuredGrounding({ webSearchQueries: [] })).toBeUndefined();
  });
});
