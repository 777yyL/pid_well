import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import { requireUser } from "./auth.js";
import { z } from "zod";
import { CapabilityService } from "./capability.js";
import {
  capabilityCreateSchema,
  capabilityQuestionSchema,
} from "../shared/capability.js";

export async function capabilityRoutes(app: FastifyInstance, db: Database) {
  const service = new CapabilityService(db);
  await service.recover();
  app.addHook("onClose", () => service.close());
  const id = (request: { params: unknown }) =>
    z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
  app.get("/api/capability/sessions", async (request) =>
    service.list(requireUser(request)),
  );
  app.post(
    "/api/capability/sessions",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const result = await service.create(
        requireUser(request),
        capabilityCreateSchema.parse(request.body),
      );
      return reply.code(202).send(result);
    },
  );
  app.get("/api/capability/sessions/:id", async (request) =>
    service.get(id(request), requireUser(request)),
  );
  app.post("/api/capability/sessions/:id/turns", async (request, reply) => {
    const input = capabilityQuestionSchema.parse(request.body);
    const user = requireUser(request);
    const sessionId = id(request);
    await service.start(sessionId, user, input.question, input.focusPaths);
    return reply.code(202).send(await service.get(sessionId, user));
  });
  app.post("/api/capability/sessions/:id/cancel", async (request) =>
    service.cancel(id(request), requireUser(request)),
  );
  app.get("/api/capability/sessions/:id/pages/:pageId", async (request) =>
    service.evidence(
      id(request),
      z
        .string()
        .uuid()
        .parse((request.params as { pageId: string }).pageId),
      requireUser(request),
    ),
  );
  app.post("/api/capability/sessions/:id/attach", async (request) =>
    service.attach(
      id(request),
      requireUser(request),
      z
        .object({
          projectId: z.string().uuid(),
          turnId: z.string().uuid(),
          path: z.string().regex(/^wiki\/entities\/(?:sale-items\/)?[^/\\]+\.md$/),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/capability/sessions/:id/pages/:pageId/graph", async (request) =>
    service.graph(id(request), z.string().uuid().parse((request.params as { pageId: string }).pageId), requireUser(request)),
  );
  app.get("/api/capability/sessions/:id/pages/:pageId/related", async (request) =>
    service.relatedPage(id(request), z.string().uuid().parse((request.params as { pageId: string }).pageId), z.string().startsWith("wiki/").parse((request.query as { path: string }).path), requireUser(request)),
  );
  return service;
}
