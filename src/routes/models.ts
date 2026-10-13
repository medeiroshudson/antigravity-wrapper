import type { FastifyInstance } from "fastify";
import { getPublicModels } from "../config/models.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async (_request, reply) => {
    try {
      const data = getPublicModels().map((model) => ({
        id: model.id,
        object: "model" as const,
        owned_by: "antigravity",
        ...(model.contextWindow > 0
          ? { context_length: model.contextWindow, max_model_len: model.contextWindow }
          : {}),
        ...(model.maxTokens > 0 ? { max_output_tokens: model.maxTokens } : {}),
      }));
      reply.status(200).send({ object: "list", data });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 500);
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
