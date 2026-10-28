import type { Database } from "./db.js";
export interface RecoveryPolicy {
  maxRecoveries: number;
  delaysMs: number[];
  maxTotalTurns?: number;
}
export function isTransientFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : String(error ?? "");
  if (
    /insufficient.quota|quota.exceeded|invalid.api.key|unauthorized|model.not.found|context.length|余额|密钥无效|\b40[0-4]\b/i.test(
      message,
    )
  )
    return false;
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = Number(error.statusCode);
    if ([400, 401, 402, 403, 404, 409, 422].includes(status)) return false;
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  }
  if (
    /insufficient.quota|quota.exceeded|invalid.api.key|unauthorized|model.not.found|context.length|余额|密钥无效/i.test(
      message,
    )
  )
    return false;
  if (
    /429|\b50[0234]\b|rate.limit|fetch.failed|connection|ECONN|ENOTFOUND|ETIMEDOUT|socket|network|timeout|timed.out|terminated|AbortError|连接|网络|请求超时/i.test(
      message,
    )
  )
    return true;
  return error instanceof Error && "cause" in error && error.cause !== error
    ? isTransientFailure(error.cause)
    : false;
}
export async function scheduleRunRecovery(
  db: Database,
  id: string,
  reason: string,
  policy: RecoveryPolicy,
) {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT p.id FROM projects p JOIN runs r ON r.project_id=p.id WHERE r.id=$1 FOR UPDATE OF p",
      [id],
    );
    const [run] = await tx.query<{
      status: string;
      auto_resume_count: number;
      turn_count: number;
    }>(
      "SELECT status,auto_resume_count,turn_count FROM runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      !run ||
      !["running", "failed", "interrupted"].includes(run.status) ||
      run.auto_resume_count >= policy.maxRecoveries ||
      (policy.maxTotalTurns !== undefined &&
        run.turn_count >= policy.maxTotalTurns)
    )
      return null;
    const [other] = await tx.query(
      "SELECT id FROM runs WHERE project_id=(SELECT project_id FROM runs WHERE id=$1) AND id<>$1 AND status IN ('queued','running') LIMIT 1",
      [id],
    );
    if (other) return null;
    const attempt = run.auto_resume_count + 1;
    const delayMs =
      policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)] ??
      30000;
    const resumeAt = new Date(Date.now() + delayMs).toISOString();
    await tx.query(
      "UPDATE runs SET status='queued',error=$1,auto_resume_count=$2,resume_after=$3,updated_at=now() WHERE id=$4",
      [
        `连接暂时中断，系统将在 ${Math.ceil(delayMs / 1000)} 秒后自动继续（${attempt}/${policy.maxRecoveries}）`,
        attempt,
        resumeAt,
        id,
      ],
    );
    await tx.query(
      "INSERT INTO run_events(run_id,type,payload) VALUES($1,'run_retry',$2)",
      [
        id,
        JSON.stringify({
          kind: "resume",
          attempt,
          maxAttempts: policy.maxRecoveries,
          resumeAt,
          reason,
        }),
      ],
    );
    return { attempt, resumeAt };
  });
}
