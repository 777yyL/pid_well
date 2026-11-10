import { z } from "zod";
import type { Database } from "./db.js";
import { seal, unseal } from "./config.js";
import { AppError } from "./errors.js";

export const rerankSettingsSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z
      .string()
      .trim()
      .refine((value) => {
        if (!value) return true;
        try {
          const u = new URL(value);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        } catch {
          return false;
        }
      }, "请输入不含凭据或查询参数的 HTTP/HTTPS API 地址"),
    model: z.string().trim().max(200),
    apiKey: z.string().max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(180000),
    candidateLimit: z.number().int().min(1).max(100),
  })
  .strict();
export type RerankSettings = z.infer<typeof rerankSettingsSchema>;
const defaults: RerankSettings = {
  enabled: false,
  baseUrl: "",
  model: "",
  timeoutMs: 10000,
  candidateLimit: 40,
};

export async function loadRerankSettings(
  db: Database,
): Promise<RerankSettings> {
  const [row] = await db.query<{ value: RerankSettings }>(
    "SELECT value FROM rerank_settings WHERE id=1",
  );
  return {
    ...defaults,
    ...row?.value,
    apiKey: row?.value.apiKey ? unseal(row.value.apiKey) : "",
  };
}
export function rerankSettingsView(value: RerankSettings) {
  const { apiKey, ...publicValue } = value;
  return { ...publicValue, apiKeySet: Boolean(apiKey) };
}
export async function resolveRerankSettings(db: Database, input: unknown) {
  const parsed = rerankSettingsSchema.parse(input);
  const previous = await loadRerankSettings(db);
  return {
    ...parsed,
    apiKey: parsed.apiKey === undefined ? previous.apiKey : parsed.apiKey,
  };
}
export async function saveRerankSettings(db: Database, input: unknown) {
  const value = await resolveRerankSettings(db, input);
  if (value.enabled && (!value.baseUrl || !value.model))
    throw new AppError(422, "启用精排前请填写 Rerank 地址和模型");
  await db.query(
    "INSERT INTO rerank_settings(id,value) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET value=$1",
    [
      JSON.stringify({
        ...value,
        apiKey: value.apiKey ? seal(value.apiKey) : "",
      }),
    ],
  );
  return rerankSettingsView(value);
}

export async function requestRerank(
  query: string,
  documents: string[],
  settings: RerankSettings,
  signal: AbortSignal,
): Promise<{ index: number; score: number }[]> {
  signal.throwIfAborted();
  if (!documents.length) return [];
  if (!settings.baseUrl || !settings.model)
    throw new AppError(422, "Rerank 地址或模型未配置");
  const response = await fetch(
    settings.baseUrl.replace(/\/$/, "") + "/rerank",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey
          ? { Authorization: `Bearer ${settings.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        query,
        documents,
        top_n: documents.length,
        return_documents: false,
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.timeoutMs),
      ]),
    },
  );
  if (!response.ok)
    throw new AppError(502, `Rerank 请求失败（HTTP ${response.status}）`);
  const body = (await response.json()) as {
    results?: { index: number; relevance_score: number }[];
  };
  if (!Array.isArray(body.results) || body.results.length !== documents.length)
    throw new AppError(502, "Rerank 返回结果数量无效");
  const seen = new Set<number>();
  for (const row of body.results) {
    if (
      !row ||
      !Number.isInteger(row.index) ||
      row.index < 0 ||
      row.index >= documents.length ||
      seen.has(row.index) ||
      typeof row.relevance_score !== "number" ||
      !Number.isFinite(row.relevance_score)
    )
      throw new AppError(502, "Rerank 返回索引或分数无效");
    seen.add(row.index);
  }
  return body.results
    .map((row) => ({ index: row.index, score: row.relevance_score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
