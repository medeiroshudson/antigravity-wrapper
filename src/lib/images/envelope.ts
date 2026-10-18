import { randomUUID } from "node:crypto";
export { antigravityHeaders } from "../antigravity/rpc.js";

export type ImageAspectRatio = "1:1" | "9:16" | "16:9";

export interface ParseAspectRatioResult {
  aspectRatio: ImageAspectRatio;
  warning?: string;
}

export function parseAspectRatio(size?: string): ParseAspectRatioResult {
  if (!size || size.trim() === "") {
    return { aspectRatio: "1:1" };
  }

  const normalized = size.trim().toLowerCase();

  switch (normalized) {
    case "1:1":
    case "1024x1024":
    case "512x512":
    case "256x256":
    case "square":
      return { aspectRatio: "1:1" };

    case "9:16":
    case "1024x1792":
    case "720x1280":
    case "portrait":
      return { aspectRatio: "9:16" };

    case "16:9":
    case "1792x1024":
    case "1280x720":
    case "landscape":
      return { aspectRatio: "16:9" };

    default:
      return {
        aspectRatio: "1:1",
        warning: `Unsupported size "${size}". Supported sizes/ratios: 1024x1024 (1:1), 1024x1792 (9:16), 1792x1024 (16:9). Defaulting to 1:1.`,
      };
  }
}

export interface ImageEnvelopeInput {
  projectId: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
}

export interface AntigravityImageRequest {
  project: string;
  model: "gemini-3.1-flash-image";
  requestType: "image_gen";
  userAgent: "antigravity";
  requestId: string;
  request: {
    contents: Array<{
      role: "user";
      parts: Array<{ text: string }>;
    }>;
    generationConfig: {
      imageConfig: {
        aspectRatio: ImageAspectRatio;
      };
      candidateCount: number;
    };
  };
}

export function buildImageEnvelope(input: ImageEnvelopeInput): AntigravityImageRequest {
  const timestamp = Date.now();
  const uuid = randomUUID();
  return {
    project: input.projectId,
    model: "gemini-3.1-flash-image",
    requestType: "image_gen",
    userAgent: "antigravity",
    requestId: `image_gen/${timestamp}/${uuid}/1`,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: input.prompt }],
        },
      ],
      generationConfig: {
        imageConfig: {
          aspectRatio: input.aspectRatio,
        },
        candidateCount: 1,
      },
    },
  };
}
