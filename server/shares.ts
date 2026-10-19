import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { accessProject, requireUser } from "./auth.js";
import { config, seal, unseal } from "./config.js";
import { AppError } from "./errors.js";
import { captureReport, createReport } from "./reports.js";
import { summarizeSales } from "./sale-entity.js";
import { accuracySummary, assessmentEvidence } from "../shared/accuracy.js";
import type { SharedResult } from "../shared/share.js";
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const shareUrl = (request: FastifyRequest, token: string) =>
  `${config.PUBLIC_BASE_URL || `${request.protocol}://${request.headers.host}`}/share/${token}`;
const tokenParam = (request: FastifyRequest) => {
  const token = (request.params as { token: string }).token;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AppError(404, "分享链接已失效或不存在");
  return token;
};
export function shareRoutes(app: FastifyInstance, db: Database) {
  const projectId = (request: FastifyRequest) =>
    z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
  const lookup = async (request: FastifyRequest) => {
    const token = tokenParam(request);
    const [share] = await db.query<{
      snapshot: SharedResult;
      artifact_ids: string[];
      expires_at: string;
    }>(
      "SELECT snapshot,artifact_ids,expires_at FROM result_shares WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
      [hashToken(token)],
    );
    if (!share) throw new AppError(404, "分享链接已失效或不存在");
    return share;
  };
  app.post("/api/projects/:id/shares", async (request) => {
    const user = requireUser(request),
      id = projectId(request);
    await accessProject(db, user, id);
    const { days } = z
      .object({ days: z.number().int().min(1).max(365).default(30) })
      .parse(request.body ?? {});
    const [active] = await db.query(
      "SELECT id FROM runs WHERE project_id=$1 AND status IN ('queued','running')",
      [id],
    );
    if (active) throw new AppError(409, "请等待当前任务结束后分享成果");
    const frozen = await captureReport(db, id);
    const procurement = summarizeSales(frozen.rows, frozen.pages);
    const files = [];
    for (const [format, kind] of [
      ["xlsx", "full"],
      ["xlsx", "sales"],
      ["html", "full"],
    ] as const) {
      const file = await createReport(db, id, format, kind, frozen);
      files.push({ id: file.id, name: file.name, kind, format });
    }
    const token = randomBytes(32).toString("base64url"),
      shareId = randomUUID();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const snapshot: SharedResult = {
      projectName: frozen.project.name,
      generatedAt: frozen.generatedAt,
      strategy: frozen.scope.strategy,
      sourceCoverage: frozen.sourceCoverage,
      expiresAt,
      files,
      rows: frozen.rows.map((row) => ({
        requirementId: row.requirementId,
        module: row.module,
        requirement_raw: row.requirement_raw,
        product: row.product,
        version: row.version,
        sales: row.sales,
        level: row.level,
        ok: row.ok,
        hard: row.hard,
        no: row.no,
        note: row.note,
        accuracySummary: accuracySummary(row),
        criteria: row.criteria,
        dependencies: row.dependencies,
        mustSelect: row.mustSelect,
        source: row.source,
        revision: row.revision,
        evidence: assessmentEvidence(row).map((proof) => ({
          quote: proof.quote,
          lineStart: proof.lineStart,
          lineEnd: proof.lineEnd,
          path:
            frozen.pages.find((page) => page.id === proof.snapshotId)?.path ??
            "知识库证据",
        })),
      })),
      procurementIssues: procurement.issues,
      componentReuse: procurement.reused,
      sales: procurement.sales.map(({ entity, requirements }) => ({
        ...entity,
        requirements: [...requirements],
      })),
    };
    const [share] = await db.query<{
      id: string;
      created_at: string;
      expires_at: string;
      revoked_at: null;
    }>(
      "INSERT INTO result_shares(id,project_id,created_by,token_hash,token_cipher,snapshot,artifact_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at,expires_at,revoked_at",
      [
        shareId,
        id,
        user.id,
        hashToken(token),
        seal(token),
        JSON.stringify(snapshot),
        files.map((file) => file.id),
        expiresAt,
      ],
    );
    await audit(db, id, user.id, null, "share_created", {
      id: shareId,
      expiresAt,
      artifactIds: files.map((file) => file.id),
    });
    return { ...share, url: shareUrl(request, token) };
  });
  app.get("/api/projects/:id/shares", async (request) => {
    const id = projectId(request);
    await accessProject(db, requireUser(request), id);
    const shares = await db.query<{
      id: string;
      token_cipher: string;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      "SELECT id,token_cipher,created_at,expires_at,revoked_at FROM result_shares WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
      [id],
    );
    return shares.map(({ token_cipher, ...share }) => ({
      ...share,
      url: shareUrl(request, unseal(token_cipher)),
    }));
  });
  app.post("/api/projects/:id/shares/:shareId/revoke", async (request) => {
    const id = projectId(request),
      user = requireUser(request);
    await accessProject(db, user, id);
    const shareId = z
      .string()
      .uuid()
      .parse((request.params as { shareId: string }).shareId);
    const [share] = await db.query(
      "UPDATE result_shares SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND project_id=$2 RETURNING id",
      [shareId, id],
    );
    if (!share) throw new AppError(404, "分享不存在");
    await audit(db, id, user.id, null, "share_revoked", { id: shareId });
    return { ok: true };
  });
  app.get("/api/shared/:token", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    const share = await lookup(request);
    return { ...share.snapshot, expiresAt: share.expires_at };
  });
  app.get(
    "/api/shared/:token/artifacts/:artifactId",
    async (request, reply) => {
      const share = await lookup(request);
      const artifactId = (request.params as { artifactId: string }).artifactId;
      if (!share.artifact_ids.includes(artifactId))
        throw new AppError(404, "分享中不存在此文件");
      const [file] = await db.query<{
        name: string;
        storage_name: string;
        format: string;
      }>("SELECT name,storage_name,format FROM artifacts WHERE id=$1", [
        artifactId,
      ]);
      if (!file) throw new AppError(404, "文件不存在");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      reply.type(
        file.format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/html;charset=utf-8",
      );
      return readFile(resolve(config.dataDir, "artifacts", file.storage_name));
    },
  );
}
