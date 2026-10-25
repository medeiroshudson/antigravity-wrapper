import type { FastifyInstance } from "fastify";
import { getPublicModels, getSupportedEfforts } from "../config/models.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async (_request, reply) => {
    try {
      const data = getPublicModels().map((model) => {
        const isImageGen = model.id === "gemini-3.1-flash-image";
        const isVision = /^(gemini-|claude-)/i.test(model.id) || isImageGen;
        const supportedEfforts = getSupportedEfforts(model);

        return {
          id: model.id,
          object: "model" as const,
          owned_by: "antigravity",
          // The backend's label, informative only: it collides across distinct models and
          // must never be used as a key (spec §3.5). `created` is deliberately absent --
          // these objects carry no date at all, unlike the chat completions.
          name: model.label,
          normalized_name: model.label,
          display_name: model.label,
          ...(model.contextWindow > 0
            ? { context_length: model.contextWindow, max_model_len: model.contextWindow }
            : {}),
          ...(model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {}),
          architecture: {
            input_modalities: isVision ? ["text", "image"] : ["text"],
            output_modalities: isImageGen ? ["image"] : ["text"],
          },
          ...(supportedEfforts
            ? {
                reasoning: {
                  supported_efforts: supportedEfforts,
                },
              }
            : {}),
        };
      });
      reply.status(200).send({ object: "list", data });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 500);
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
