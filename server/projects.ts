import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import { requireUser, accessProject } from "./auth.js";
import { AppError } from "./errors.js";
import { z } from "zod";
import { resolve, basename, dirname } from "node:path";
import { rm, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export function projectRoutes(app: FastifyInstance, db: Database) {
  const pending = new Map<string, Promise<void>>();
  const releases = new WeakMap<FastifyRequest, () => void>();
  app.addHook("onResponse", async (request) => {
    releases.get(request)?.();
    releases.delete(request);
  });
  // Archived projects remain readable. Every project mutation is rejected centrally.
  app.addHook("preHandler", async (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (!request.user) return;
    const path = request.url.split("?")[0];
    let projectId: string | undefined;
    const project = path.match(/^\/api\/projects\/([\w-]+)/);
    if (project) {
      projectId = project[1];
    } else {
      const conversation = path.match(/^\/api\/conversations\/([\w-]+)/);
      if (conversation) {
        const [row] = await db.query<{ project_id: string }>(
          "SELECT project_id FROM conversations WHERE id=$1",
          [z.string().uuid().parse(conversation[1])],
        );
        projectId = row?.project_id;
      }
    }
    if (projectId) {
      const id = z.string().uuid().parse(projectId);
      const previous = pending.get(id);
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending.set(id, wait);
      await previous;
      releases.set(request, () => {
        release();
        if (pending.get(id) === wait) pending.delete(id);
      });
      const p = await accessProject(db, request.user, id);
      if (
        p.archived_at &&
        !/\/(archive|restore)$/.test(path) &&
        request.method !== "DELETE"
      )
        throw new AppError(409, "项目已归档，请先恢复项目再操作");
    }
  });
  const owned = async (
    tx: Database,
    request: Parameters<typeof requireUser>[0],
  ) => {
    const user = requireUser(request);
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [id]);
    const project = await accessProject(tx, user, id);
    if (project.owner_id !== user.id && user.role !== "admin")
      throw new AppError(403, "仅项目负责人或管理员可管理项目");
    const [active] = await tx.query(
      "SELECT id FROM runs WHERE project_id=$1 AND status IN ('queued','running')",
      [id],
    );
    const [parsing] = await tx.query(
      "SELECT id FROM documents WHERE project_id=$1 AND status='parsing'",
      [id],
    );
    if (active || parsing)
      throw new AppError(
        409,
        "项目正在执行任务或解析文件，请等待完成或先停止任务",
      );
    return { id, project };
  };
  app.put("/api/projects/:id", async (request) =>
    db.transaction(async (tx) => {
      const { id } = await owned(tx, request);
      const value = z
        .object({
          name: z.string().trim().min(1).max(120),
          description: z.string().max(5000).default(""),
        })
        .parse(request.body);
      await tx.query("UPDATE projects SET name=$1,description=$2 WHERE id=$3", [
        value.name,
        value.description,
        id,
      ]);
      return { ok: true };
    }),
  );
  for (const action of ["archive", "restore"] as const)
    app.post(`/api/projects/:id/${action}`, async (request) =>
      db.transaction(async (tx) => {
        const { id } = await owned(tx, request);
        await tx.query(
          `UPDATE projects SET archived_at=${action === "archive" ? "now()" : "NULL"} WHERE id=$1`,
          [id],
        );
        return { ok: true };
      }),
    );
  app.delete("/api/projects/:id", async (request) => {
    const moved: { source: string; target: string }[] = [];
    const staging = resolve(config.dataDir, "deletions", randomUUID());
    if (dirname(staging) !== resolve(config.dataDir, "deletions"))
      throw new AppError(500, "删除目录异常");
    try {
      await db.transaction(async (tx) => {
        const { id, project } = await owned(tx, request);
        const { name } = z.object({ name: z.string() }).parse(request.body);
        if (name !== project.name)
          throw new AppError(400, "输入的项目名称不一致");
        for (const [table, folder] of [
          ["documents", "uploads"],
          ["artifacts", "artifacts"],
        ]) {
          const files = await tx.query<{ storage_name: string }>(
            `SELECT storage_name FROM ${table} WHERE project_id=$1`,
            [id],
          );
          for (const file of files) {
            if (
              basename(file.storage_name) !== file.storage_name ||
              [".", ".."].includes(file.storage_name)
            )
              throw new AppError(500, "文件存储路径异常");
            await mkdir(staging, { recursive: true });
            const source = resolve(config.dataDir, folder, file.storage_name),
              target = resolve(staging, `${folder}-${file.storage_name}`);
            try {
              await rename(source, target);
              moved.push({ source, target });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
        }
        await tx.query(
          "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id=$1)",
          [id],
        );
        await tx.query(
          "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=$1)",
          [id],
        );
        for (const table of [
          "audit_log",
          "result_shares",
          "assessments",
          "requirements",
          "snapshots",
          "documents",
          "artifacts",
          "product_scopes",
          "runs",
          "conversations",
          "project_members",
        ])
          await tx.query(`DELETE FROM ${table} WHERE project_id=$1`, [id]);
        await tx.query("DELETE FROM projects WHERE id=$1", [id]);
      });
    } catch (error) {
      for (const file of moved.reverse())
        await rename(file.target, file.source);
      throw error;
    }
    await rm(staging, { recursive: true, force: true });
    return { ok: true };
  });
}
