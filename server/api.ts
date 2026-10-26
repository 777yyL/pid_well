import { projectKnowledge, overviewMarkdown } from "./structured-knowledge.js";
import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { saveCoverage, sourceCoverage } from "./source-coverage.js";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import {
  requireUser,
  requireAdmin,
  accessProject,
  hashPassword,
  verifyPassword,
  issueSession,
  tokenHash,
} from "./auth.js";
import { config } from "./config.js";
import { productScope, selectProducts } from "./product-scope.js";
import { AppError } from "./errors.js";
import {
  settingsView,
  saveAgentSettings,
  wikiSettingsView,
  saveWikiSettings,
  defaultWikiProject,
  loadSettings,
} from "./settings.js";
import { WikiClient, snapshotPage, PRODUCT_OVERVIEW_PATH } from "./wiki.js";
import { parseDocument, supportedExtensions } from "./documents.js";
import {
  assessmentRows,
  saveAssessments,
  supplementSubrequirements,
} from "./assessment.js";
import { assessmentSchema, type User, type Run } from "../shared/domain.js";
import { createReport } from "./reports.js";
import { AgentRunner, compatibleModel, publicModelError } from "./agent.js";
const idSchema = z.string().uuid();
const credentials = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/),
  password: z.string().min(10).max(256),
  displayName: z.string().min(1).max(80).optional(),
});
export function routes(
  app: FastifyInstance,
  db: Database,
  runner: AgentRunner,
) {
  const param = (request: { params: unknown }, name: string) =>
    idSchema.parse((request.params as Record<string, string>)[name]);
  app.get("/api/health", async () => {
    await db.query("SELECT 1");
    return {
      ok: true,
      storage: config.DATABASE_URL ? "postgresql" : "pglite",
      version: "0.1.0",
    };
  });
  app.get("/api/auth/me", async (request) => {
    const [row] = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users",
    );
    return { user: request.user, needsSetup: row.count === 0 };
  });
  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = credentials.parse(request.body);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        const [row] = await tx.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM users",
        );
        if (row.count) throw new AppError(409, "管理员已经初始化");
        await tx.query("INSERT INTO bootstrap(id) VALUES(1)");
        await tx.query(
          "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            input.username,
            input.displayName ?? input.username,
            await hashPassword(input.password),
            "admin",
          ],
        );
      });
      const session = await issueSession(db, id);
      reply.setCookie("workspace_session", session.token, session.options);
      return { ok: true };
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = z
        .object({ username: z.string().max(40), password: z.string().max(256) })
        .parse(request.body);
      const [user] = await db.query<User & { password_hash: string }>(
        "SELECT * FROM users WHERE username=$1 AND active=true",
        [input.username],
      );
      const valid = await verifyPassword(
        input.password,
        user?.password_hash ??
          "00000000000000000000000000000000:" + "00".repeat(64),
      );
      if (!user || !valid) throw new AppError(401, "账号或密码不正确");
      const session = await issueSession(db, user.id);
      reply.setCookie("workspace_session", session.token, session.options);
      return { ok: true };
    },
  );
  app.post("/api/auth/logout", async (request, reply) => {
    if (request.cookies.workspace_session)
      await db.query("DELETE FROM sessions WHERE hash=$1", [
        tokenHash(request.cookies.workspace_session),
      ]);
    reply.clearCookie("workspace_session", { path: "/" });
    return { ok: true };
  });
  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = credentials
        .extend({ displayName: z.string().trim().min(1).max(80) })
        .parse(request.body);
      const [initialized] = await db.query(
        "SELECT id FROM users WHERE role='admin' LIMIT 1",
      );
      if (!initialized) throw new AppError(409, "请先初始化管理员账号");
      const id = randomUUID();
      try {
        await db.query(
          "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,'member')",
          [
            id,
            input.username,
            input.displayName,
            await hashPassword(input.password),
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw new AppError(409, "账号已被注册，请换一个账号或直接登录");
        throw error;
      }
      const session = await issueSession(db, id);
      reply.setCookie("workspace_session", session.token, session.options);
      return { ok: true };
    },
  );
  app.post(
    "/api/auth/password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const input = z
        .object({
          currentPassword: z.string().max(256),
          newPassword: z.string().min(10).max(256),
        })
        .parse(request.body);
      const [row] = await db.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id=$1",
        [user.id],
      );
      if (!(await verifyPassword(input.currentPassword, row.password_hash)))
        throw new AppError(401, "当前密码不正确");
      await db.transaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          await hashPassword(input.newPassword),
          user.id,
        ]);
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
        await audit(tx, null, user.id, null, "password_changed", {});
      });
      const session = await issueSession(db, user.id);
      reply.setCookie("workspace_session", session.token, session.options);
      return { ok: true };
    },
  );
  app.get("/api/settings", async (request) => {
    const user = requireUser(request);
    return settingsView(db, user.id);
  });
  app.put("/api/settings", async (request) => {
    const user = requireUser(request);
    await saveAgentSettings(db, user.id, request.body);
    await audit(db, null, user.id, null, "agent_settings_changed", {});
    return settingsView(db, user.id);
  });
  app.get("/api/settings/wiki", async (request) => {
    requireAdmin(request);
    return wikiSettingsView(db);
  });
  app.put("/api/settings/wiki", async (request) => {
    const user = requireAdmin(request);
    await saveWikiSettings(db, request.body);
    await audit(db, null, user.id, null, "wiki_settings_changed", {});
    return wikiSettingsView(db);
  });
  app.post("/api/settings/test", async (request) => {
    const user = requireUser(request);
    const { target } = z
      .object({ target: z.enum(["wiki", "model"]) })
      .parse(request.body);
    if (target === "wiki") {
      requireAdmin(request);
      return new WikiClient(db).projects();
    }
    const settings = await loadSettings(db, user.id);
    if (!settings.model) throw new AppError(422, "先保存模型配置");
    const { models, model } = compatibleModel(settings);
    try {
      const result = await models.completeSimple(
        model,
        {
          messages: [
            { role: "user", content: "请只回复 OK", timestamp: Date.now() },
          ],
        },
        { maxTokens: 32, signal: AbortSignal.timeout(30000) },
      );
      if (result.stopReason === "error")
        throw new Error(result.errorMessage || "provider error");
      return { ok: true, model: settings.model };
    } catch (error) {
      throw new AppError(
        502,
        publicModelError(error instanceof Error ? error.message : ""),
      );
    }
  });
  app.get("/api/wiki/projects", async (request) => {
    const user = requireUser(request);
    const selected =
      user.role === "admin" ? null : await defaultWikiProject(db);
    const data = await new WikiClient(db).projects();
    if (!selected) return data;
    const projects = Array.isArray(data.projects) ? data.projects : [];
    return {
      projects: projects.filter((p: { id?: string }) => p.id === selected),
    };
  });
  app.get("/api/users", async (request) => {
    requireUser(request);
    return db.query<User>(
      "SELECT id,username,display_name,role FROM users WHERE active=true ORDER BY created_at",
    );
  });
  app.post("/api/users", async (request) => {
    const admin = requireAdmin(request);
    const input = credentials.parse(request.body);
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        input.username,
        input.displayName ?? input.username,
        await hashPassword(input.password),
        "member",
      ],
    );
    await audit(db, null, admin.id, null, "user_created", {
      username: input.username,
    });
    return { ok: true };
  });
  app.get("/api/projects", async (request) => {
    const user = requireUser(request);
    return db.query(
      `SELECT p.*,u.display_name AS owner_name,EXISTS(SELECT 1 FROM runs r WHERE r.project_id=p.id AND r.status IN ('queued','running')) AS active_run FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.owner_id=$1 OR $2='admin' OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$1) ORDER BY p.created_at DESC`,
      [user.id, user.role],
    );
  });
  app.post("/api/projects", async (request) => {
    const user = requireUser(request);
    const input = z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(5000).default(""),
      })
      .parse(request.body);
    const wikiProjectId = await defaultWikiProject(db);
    const id = randomUUID();
    await db.query(
      "INSERT INTO projects(id,name,description,wiki_project_id,owner_id) VALUES($1,$2,$3,$4,$5)",
      [id, input.name, input.description, wikiProjectId, user.id],
    );
    await audit(db, id, user.id, null, "project_created", {
      ...input,
      wikiProjectId,
    });
    await db.query(
      "INSERT INTO product_scopes(project_id) VALUES($1) ON CONFLICT DO NOTHING",
      [id],
    );
    return { id };
  });
  app.get("/api/projects/:id", async (request) => {
    const user = requireUser(request);
    const id = param(request, "id");
    const project = await accessProject(db, user, id);
    const [
      conversations,
      documents,
      requirements,
      snapshots,
      runs,
      artifacts,
      findings,
    ] = await Promise.all([
      db.query(
        "SELECT id,project_id,title,plan,created_at FROM conversations WHERE project_id=$1 ORDER BY created_at DESC",
        [id],
      ),
      db.query(
        "SELECT id,name,status,error,jsonb_array_length(lines) AS line_count,'[]'::jsonb AS lines,created_at FROM documents WHERE project_id=$1 ORDER BY created_at",
        [id],
      ),
      db.query<{ data: unknown; confirmed: boolean }>(
        "SELECT data,confirmed FROM requirements WHERE project_id=$1 ORDER BY id",
        [id],
      ),
      db.query(
        "SELECT id,path,substring(content from '(?m)^#[[:space:]]+([^[:cntrl:]]+)') AS title,'' AS content,hash,created_at FROM snapshots WHERE project_id=$1 ORDER BY created_at",
        [id],
      ),
      db.query(
        "SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
        [id],
      ),
      db.query(
        "SELECT id,name,format,manifest,created_at FROM artifacts WHERE project_id=$1 ORDER BY created_at DESC",
        [id],
      ),
      db.query(
        "SELECT id,data,created_at FROM audit_log WHERE project_id=$1 AND action='finding' ORDER BY id DESC",
        [id],
      ),
    ]);
    return {
      project,
      conversations,
      documents,
      requirements: requirements.map((r) => ({
        ...(r.data as object),
        confirmed: r.confirmed,
      })),
      assessments: await assessmentRows(db, id),
      sourceCoverage: await sourceCoverage(db, id),
      snapshots,
      runs,
      artifacts,
      findings,
      productScope: await productScope(db, id),
      searchTrace: await db.query(
        "SELECT id,action,data,created_at FROM audit_log WHERE project_id=$1 AND action IN ('product_scoped_search','product_global_search') ORDER BY id DESC LIMIT 200",
        [id],
      ),
      alternatives: await db.query(
        "SELECT id,data FROM audit_log WHERE project_id=$1 AND action='product_alternative' ORDER BY id DESC LIMIT 100",
        [id],
      ),
    };
  });
  app.post("/api/projects/:id/product-info/refresh", async (request) => {
    const user = requireUser(request),
      id = param(request, "id");
    await accessProject(db, user, id);
    const [project] = await db.query<{ wiki_project_id: string }>(
      "SELECT wiki_project_id FROM projects WHERE id=$1",
      [id],
    );
    const release = await projectKnowledge(db, id, true);
    const content = release
      ? overviewMarkdown(release)
      : await new WikiClient(db).read(
          project.wiki_project_id,
          PRODUCT_OVERVIEW_PATH,
        );
    await snapshotPage(db, id, PRODUCT_OVERVIEW_PATH, content);
    return productScope(db, id);
  });
  app.put("/api/projects/:id/product-scope", async (request) => {
    const user = requireUser(request),
      id = param(request, "id");
    await accessProject(db, user, id);
    return selectProducts(db, id, user.id, request.body);
  });
  app.post("/api/projects/:id/members", async (request) => {
    const user = requireUser(request);
    const id = param(request, "id");
    const project = await accessProject(db, user, id);
    if (project.owner_id !== user.id && user.role !== "admin")
      throw new AppError(403, "只有项目负责人或管理员可以管理成员");
    const input = z.object({ userId: z.string().uuid() }).parse(request.body);
    await db.query(
      "INSERT INTO project_members(project_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, input.userId],
    );
    await audit(db, id, user.id, null, "member_added", input);
    return { ok: true };
  });
  app.get("/api/projects/:id/members", async (request) => {
    const id = param(request, "id");
    await accessProject(db, requireUser(request), id);
    return db.query(
      "SELECT u.id,u.display_name,u.username FROM users u JOIN project_members m ON u.id=m.user_id WHERE m.project_id=$1",
      [id],
    );
  });
  app.get("/api/projects/:id/audit", async (request) => {
    const id = param(request, "id");
    await accessProject(db, requireUser(request), id);
    return db.query(
      "SELECT a.id,a.action,a.data,a.created_at,u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 ORDER BY a.id DESC LIMIT 200",
      [id],
    );
  });
  app.post("/api/projects/:id/conversations", async (request) => {
    const id = param(request, "id");
    await accessProject(db, requireUser(request), id);
    const { title } = z
      .object({ title: z.string().min(1).max(120).default("新会话") })
      .parse(request.body ?? {});
    const conversationId = randomUUID();
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,$3)",
      [conversationId, id, title],
    );
    return { id: conversationId };
  });
  app.get("/api/conversations/:id/messages", async (request) => {
    const id = param(request, "id");
    const [conversation] = await db.query<{ project_id: string }>(
      "SELECT project_id FROM conversations WHERE id=$1",
      [id],
    );
    if (!conversation) throw new AppError(404, "会话不存在");
    await accessProject(db, requireUser(request), conversation.project_id);
    return db.query(
      "SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at,id",
      [id],
    );
  });
  app.post("/api/conversations/:id/runs", async (request) => {
    const user = requireUser(request);
    const id = param(request, "id");
    const input = z
      .object({
        message: z.string().trim().min(1).max(20000),
        mode: z.enum(["quick", "agent"]).default("agent"),
        idempotencyKey: z.string().uuid(),
      })
      .parse(request.body);
    const [conversation] = await db.query<{ project_id: string }>(
      "SELECT project_id FROM conversations WHERE id=$1",
      [id],
    );
    if (!conversation) throw new AppError(404, "会话不存在");
    await accessProject(db, user, conversation.project_id);
    const [existing] = await db.query<{ id: string }>(
      "SELECT id FROM runs WHERE user_id=$1 AND idempotency_key=$2",
      [user.id, input.idempotencyKey],
    );
    if (existing) return existing;
    const settings = await loadSettings(db, user.id);
    if (!settings.model)
      throw new AppError(422, "请先在个人 Agent 配置中设置模型");
    const runId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
        conversation.project_id,
      ]);
      await tx.query(
        "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status,evaluation_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          runId,
          id,
          conversation.project_id,
          user.id,
          input.message,
          input.idempotencyKey,
          "queued",
          input.mode,
        ],
      );
      await tx.query(
        "INSERT INTO messages(id,conversation_id,run_id,role,content) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), id, runId, "user", input.message],
      );
      await tx.query(
        "UPDATE conversations SET title=CASE WHEN title='新会话' THEN $1 ELSE title END,updated_at=now() WHERE id=$2",
        [input.message.slice(0, 30), id],
      );
    });
    return { id: runId };
  });
  app.post("/api/runs/:id/cancel", async (request) => {
    const id = param(request, "id");
    const [run] = await db.query<Run>("SELECT * FROM runs WHERE id=$1", [id]);
    if (!run) throw new AppError(404, "执行不存在");
    await accessProject(db, requireUser(request), run.project_id);
    await runner.cancel(id);
    return { ok: true };
  });
  app.get("/api/runs/:id/events", async (request) => {
    const id = param(request, "id");
    const [run] = await db.query<Run>("SELECT * FROM runs WHERE id=$1", [id]);
    if (!run) throw new AppError(404, "执行不存在");
    await accessProject(db, requireUser(request), run.project_id);
    const query = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const events = await db.query(
      "SELECT id,type,payload,created_at FROM run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 200",
      [id, query.after],
    );
    return { run, events };
  });
  app.post(
    "/api/projects/:id/documents",
    { bodyLimit: 30 * 1024 * 1024 },
    async (request) => {
      const user = requireUser(request);
      const id = param(request, "id");
      await accessProject(db, user, id);
      const file = await request.file({
        limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      });
      if (!file) throw new AppError(400, "请选择文件");
      const name = basename(file.filename.replaceAll("\\", "/"));
      if (!supportedExtensions.has(extname(name).toLowerCase()))
        throw new AppError(400, "支持 DOCX / XLSX / PDF / MD / TXT");
      const buffer = await file.toBuffer();
      const documentId = randomUUID();
      const storageName = documentId + extname(name).toLowerCase();
      const dir = resolve(config.dataDir, "uploads");
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, storageName), buffer, { flag: "wx" });
      const hash = createHash("sha256").update(buffer).digest("hex");
      await db.query(
        "INSERT INTO documents(id,project_id,name,storage_name,hash,status) VALUES($1,$2,$3,$4,$5,$6)",
        [documentId, id, name, storageName, hash, "parsing"],
      );
      try {
        const lines = await parseDocument(name, buffer);
        await db.query("UPDATE documents SET lines=$1,status=$2 WHERE id=$3", [
          JSON.stringify(lines),
          "ready",
          documentId,
        ]);
        await audit(db, id, user.id, null, "document_uploaded", {
          id: documentId,
          name,
          hash,
          lineCount: lines.length,
        });
        return { id: documentId, lineCount: lines.length };
      } catch (error) {
        const reason =
          error instanceof AppError
            ? error.message
            : "文档解析失败，请检查文件是否损坏或加密";
        await db.query("UPDATE documents SET status=$1,error=$2 WHERE id=$3", [
          "failed",
          reason,
          documentId,
        ]);
        throw new AppError(422, reason);
      }
    },
  );
  app.get("/api/documents/:id/download", async (request, reply) => {
    const id = param(request, "id");
    const [doc] = await db.query<{
      project_id: string;
      storage_name: string;
      name: string;
    }>("SELECT * FROM documents WHERE id=$1", [id]);
    if (!doc) throw new AppError(404, "文件不存在");
    await accessProject(db, requireUser(request), doc.project_id);
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
    );
    reply.type("application/octet-stream");
    return readFile(resolve(config.dataDir, "uploads", doc.storage_name));
  });
  app.get("/api/documents/:id/source", async (request) => {
    const id = param(request, "id");
    const [doc] = await db.query<{
      project_id: string;
      lines: string[];
      name: string;
    }>("SELECT project_id,lines,name FROM documents WHERE id=$1", [id]);
    if (!doc) throw new AppError(404, "文件不存在");
    await accessProject(db, requireUser(request), doc.project_id);
    return { name: doc.name, lines: doc.lines };
  });
  app.get("/api/snapshots/:id", async (request) => {
    const id = param(request, "id");
    const [page] = await db.query<{ project_id: string }>(
      "SELECT * FROM snapshots WHERE id=$1",
      [id],
    );
    if (!page) throw new AppError(404, "证据不存在");
    await accessProject(db, requireUser(request), page.project_id);
    return page;
  });
  app.post("/api/projects/:id/requirements/confirm", async (request) => {
    const user = requireUser(request);
    const id = param(request, "id");
    await accessProject(db, user, id);
    const { ids } = z
      .object({
        ids: z
          .array(z.string().regex(/^T-\d+$/))
          .min(1)
          .max(10000),
      })
      .parse(request.body);
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE requirements SET confirmed=true WHERE project_id=$1 AND id=ANY($2::text[])",
        [id, ids],
      );
      await audit(tx, id, user.id, null, "requirements_confirmed", { ids });
    });
    return { ok: true };
  });
  app.put(
    "/api/projects/:id/requirements/:requirementId/subrequirements",
    async (request) => {
      const user = requireUser(request),
        id = param(request, "id");
      await accessProject(db, user, id);
      return supplementSubrequirements(
        db,
        id,
        z
          .string()
          .regex(/^T-\d+$/)
          .parse((request.params as Record<string, string>).requirementId),
        user.id,
        request.body,
      );
    },
  );
  app.put("/api/projects/:id/source-coverage", async (request) => {
    const user = requireUser(request),
      id = param(request, "id");
    await accessProject(db, user, id);
    return saveCoverage(db, id, request.body, { userId: user.id });
  });
  app.put("/api/projects/:id/assessments/:requirementId", async (request) => {
    const user = requireUser(request);
    const id = param(request, "id");
    await accessProject(db, user, id);
    const input = z
      .object({
        assessment: assessmentSchema,
        expectedRevision: z.number().int().positive(),
      })
      .parse(request.body);
    if (
      input.assessment.requirementId !==
      (request.params as Record<string, string>).requirementId
    )
      throw new AppError(400, "条款编号不一致");
    await db.transaction(async (tx) => {
      const [current] = await tx.query<{ revision: number }>(
        "SELECT revision FROM assessments WHERE project_id=$1 AND requirement_id=$2 FOR UPDATE",
        [id, input.assessment.requirementId],
      );
      if (!current || current.revision !== input.expectedRevision)
        throw new AppError(409, "结果已更新，请刷新后重试");
      await saveAssessments(
        { ...tx, transaction: async (fn) => fn(tx) },
        id,
        [input.assessment],
        { userId: user.id, human: true },
      );
    });
    return { ok: true };
  });
  app.post("/api/projects/:id/reports", async (request) => {
    const id = param(request, "id");
    await accessProject(db, requireUser(request), id);
    const { format, kind, stage } = z
      .object({
        format: z.enum(["xlsx", "csv", "html"]),
        kind: z.enum(["full", "sales"]).default("full"),
        stage: z.enum(["formal", "preliminary"]).default("formal"),
      })
      .parse(request.body);
    return createReport(db, id, format, kind, undefined, stage);
  });
  app.get("/api/artifacts/:id", async (request, reply) => {
    const id = param(request, "id");
    const [artifact] = await db.query<{
      project_id: string;
      storage_name: string;
      name: string;
      format: string;
    }>("SELECT * FROM artifacts WHERE id=$1", [id]);
    if (!artifact) throw new AppError(404, "报告不存在");
    await accessProject(db, requireUser(request), artifact.project_id);
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    );
    reply.type(
      artifact.format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : artifact.format === "csv"
          ? "text/csv;charset=utf-8"
          : "text/html;charset=utf-8",
    );
    return readFile(
      resolve(config.dataDir, "artifacts", artifact.storage_name),
    );
  });
}
