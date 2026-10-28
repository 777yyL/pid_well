import { z } from "zod";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import type { RequirementInput } from "../shared/domain.js";

export const coverageSchema = z.object({
  documentId: z.string().uuid(),
  entries: z
    .array(
      z.object({
        id: z.string().min(1),
        lineStart: z.number().int().positive(),
        lineEnd: z.number().int().positive(),
        status: z.enum(["extracted", "excluded", "pending"]),
        reason: z.string().min(1),
        requirementIds: z.array(z.string()),
        subrequirementIds: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(2000),
});
export async function saveCoverage(
  db: Database,
  projectId: string,
  input: unknown,
  actor: { userId?: string; runId?: string },
) {
  const value = coverageSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      projectId,
    ]);
    const [doc] = await tx.query<{ lines: string[] }>(
      "SELECT lines FROM documents WHERE project_id=$1 AND id=$2 AND status='ready'",
      [projectId, value.documentId],
    );
    if (!doc) throw new AppError(422, "覆盖记录必须来自已解析文档");
    const [prior] = await tx.query<{ user_id: string | null }>(
      "SELECT user_id FROM audit_log WHERE project_id=$1 AND action='source_coverage' AND data->>'documentId'=$2 ORDER BY id DESC LIMIT 1",
      [projectId, value.documentId],
    );
    if (prior?.user_id && !actor.userId)
      throw new AppError(409, "人工原文覆盖记录不可由 Agent 覆盖");
    const requirements = await tx.query<{ id: string; data: RequirementInput }>(
      "SELECT id,data FROM requirements WHERE project_id=$1",
      [projectId],
    );
    if (new Set(value.entries.map((e) => e.id)).size !== value.entries.length)
      throw new AppError(422, "原文条目编号不能重复");
    for (const entry of value.entries) {
      if (entry.lineEnd < entry.lineStart || entry.lineEnd > doc.lines.length)
        throw new AppError(422, "覆盖条目行号超出原文");
      const linked = entry.requirementIds.map((id) =>
        requirements.find((r) => r.id === id),
      );
      if (
        linked.some(
          (r) =>
            !r ||
            r.data.documentId !== value.documentId ||
            r.data.lineStart < entry.lineStart ||
            r.data.lineEnd > entry.lineEnd,
        )
      )
        throw new AppError(422, "覆盖条目与关联要求原文不一致");
      if (entry.status === "extracted" && !linked.length)
        throw new AppError(422, "已抽取条目必须关联要求");
    }
    await audit(
      tx,
      projectId,
      actor.userId ?? null,
      actor.runId ?? null,
      "source_coverage",
      value,
    );
    return sourceCoverage(tx, projectId);
  });
}
export async function sourceCoverage(db: Database, projectId: string) {
  const docs = await db.query<{ id: string; name: string; lines: string[] }>(
    "SELECT id,name,lines FROM documents WHERE project_id=$1 AND status='ready'",
    [projectId],
  );
  const records = await db.query<{
    data: z.infer<typeof coverageSchema>;
    user_id: string | null;
  }>(
    "SELECT DISTINCT ON(data->>'documentId') data,user_id FROM audit_log WHERE project_id=$1 AND action='source_coverage' ORDER BY data->>'documentId',id DESC",
    [projectId],
  );
  return docs.map((doc) => {
    const record = records.find((r) => r.data.documentId === doc.id);
    const entries = record?.data.entries ?? [];
    const uncheckedLines = doc.lines.flatMap((text, i) =>
      text.trim() &&
      !entries.some(
        (e) =>
          e.status !== "pending" && e.lineStart <= i + 1 && e.lineEnd >= i + 1,
      )
        ? [i + 1]
        : [],
    );
    return {
      documentId: doc.id,
      name: doc.name,
      entries,
      uncheckedLines,
      status: !record
        ? "unchecked"
        : uncheckedLines.length || entries.some((e) => e.status === "pending")
          ? "pending"
          : record.user_id
            ? "human_checked"
            : "ai_checked",
    };
  });
}
