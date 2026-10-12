import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { ZodError } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";
import { openDatabase, migrate, type Database } from "./db.js";
import { attachAuth } from "./auth.js";
import { routes } from "./api.js";
import { AgentRunner } from "./agent.js";
import { shareRoutes } from "./shares.js";
export async function createApp(db: Database, serveWeb = false) {
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url?.replace(
            /(\/(?:share|api\/shared)\/)[A-Za-z0-9_-]+/g,
            "$1[redacted]",
          ),
          hostname: request.hostname,
          remoteAddress: request.ip,
        }),
      },
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(multipart);
  attachAuth(app, db);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (request) =>
      request.user ? `user:${request.user.id}` : `ip:${request.ip}`,
    errorResponseBuilder: () => ({
      statusCode: 429,
      message: "请求过于频繁，请稍后重试；已有任务仍会在服务端继续执行",
    }),
  });
  const runner = new AgentRunner(db);
  routes(app, db, runner);
  shareRoutes(app, db);
  app.setErrorHandler((error, request, reply) => {
    const dbCode = (error as { code?: string }).code;
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      });
    }
    if (dbCode === "23505")
      return reply
        .code(409)
        .send({ error: "记录已存在，或该项目已有正在执行的任务" });
    if (dbCode === "23503")
      return reply.code(400).send({ error: "关联记录不存在" });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500)
      request.log.error(
        { name: (error as Error).name, code: dbCode },
        "request failed",
      );
    return reply.code(status).send({
      error: status === 500 ? "服务处理失败，请重试" : (error as Error).message,
    });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Referrer-Policy",
      request.url.startsWith("/share/") ||
        request.url.startsWith("/api/shared/")
        ? "no-referrer"
        : "same-origin",
    );
    return payload;
  });
  if (serveWeb) {
    if (config.production) {
      await app.register(staticPlugin, {
        root: resolve("dist/web"),
        prefix: "/",
      });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/"))
          return reply.code(404).send({ error: "接口不存在" });
        return reply.sendFile("index.html");
      });
    } else {
      const { createServer } = await import("vite");
      const vite = await createServer({
        server: {
          middlewareMode: true,
          hmr: { port: config.PORT + 1 },
          watch: {
            ignored: [
              "**/data/**",
              "**/backups/**",
              "**/coverage/**",
              `${config.dataDir.replaceAll("\\", "/")}/**`,
            ],
          },
        },
        appType: "custom",
      });
      app.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith("/api/")) return;
        await new Promise<void>((done, reject) => {
          const finish = () => {
            reply.hijack();
            done();
          };
          reply.raw.once("finish", finish);
          vite.middlewares(request.raw, reply.raw, (error?: unknown) => {
            reply.raw.off("finish", finish);
            if (error) reject(error);
            else done();
          });
        });
      });
      app.get("/*", async (request, reply) => {
        if (request.url.startsWith("/api/"))
          return reply.code(404).send({ error: "接口不存在" });
        return reply
          .type("text/html")
          .send(
            await vite.transformIndexHtml(
              request.url,
              await readFile(resolve("index.html"), "utf8"),
            ),
          );
      });
      app.addHook("onClose", () => vite.close());
    }
  }
  app.addHook("onClose", async () => runner.close());
  return { app, runner };
}
async function main() {
  const db = await openDatabase();
  await migrate(db);
  await db.query(
    "UPDATE documents SET status='failed',error='解析被服务重启中断，请重新上传' WHERE status='parsing'",
  );
  const { app, runner } = await createApp(db, true);
  await app.listen({ host: config.HOST, port: config.PORT });
  await runner.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
if (process.argv[1] && /server[\\/]index\.(?:ts|js)$/.test(process.argv[1]))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "启动失败");
    process.exit(1);
  });
