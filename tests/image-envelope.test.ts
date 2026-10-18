import { describe, expect, it } from "vitest";
import { parseAspectRatio, buildImageEnvelope } from "../src/lib/images/envelope.js";

describe("image envelope and aspect ratio translation", () => {
  it("translates square sizes to 1:1", () => {
    expect(parseAspectRatio("1024x1024").aspectRatio).toBe("1:1");
    expect(parseAspectRatio("512x512").aspectRatio).toBe("1:1");
    expect(parseAspectRatio("256x256").aspectRatio).toBe("1:1");
    expect(parseAspectRatio("square").aspectRatio).toBe("1:1");
    expect(parseAspectRatio("1:1").aspectRatio).toBe("1:1");
    expect(parseAspectRatio(undefined).aspectRatio).toBe("1:1");
    expect(parseAspectRatio("").aspectRatio).toBe("1:1");
  });

  it("translates portrait sizes to 9:16", () => {
    expect(parseAspectRatio("1024x1792").aspectRatio).toBe("9:16");
    expect(parseAspectRatio("720x1280").aspectRatio).toBe("9:16");
    expect(parseAspectRatio("portrait").aspectRatio).toBe("9:16");
    expect(parseAspectRatio("9:16").aspectRatio).toBe("9:16");
  });

  it("translates landscape sizes to 16:9", () => {
    expect(parseAspectRatio("1792x1024").aspectRatio).toBe("16:9");
    expect(parseAspectRatio("1280x720").aspectRatio).toBe("16:9");
    expect(parseAspectRatio("landscape").aspectRatio).toBe("16:9");
    expect(parseAspectRatio("16:9").aspectRatio).toBe("16:9");
  });

  it("falls back to 1:1 with warning on unknown size", () => {
    const res = parseAspectRatio("800x600");
    expect(res.aspectRatio).toBe("1:1");
    expect(res.warning).toBeDefined();
  });

  it("builds upstream image_gen envelope with required fields", () => {
    const envelope = buildImageEnvelope({
      projectId: "aicode-consumers",
      prompt: "A beautiful sunset over mountains",
      aspectRatio: "16:9",
    });

    expect(envelope.project).toBe("aicode-consumers");
    expect(envelope.model).toBe("gemini-3.1-flash-image");
    expect(envelope.requestType).toBe("image_gen");
    expect(envelope.userAgent).toBe("antigravity");
    expect(envelope.requestId).toMatch(/^image_gen\/\d+\/[a-f0-9-]+\/1$/);
    expect(envelope.request.contents[0].parts[0].text).toBe("A beautiful sunset over mountains");
    expect(envelope.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(envelope.request.generationConfig.candidateCount).toBe(1);
  });
});
