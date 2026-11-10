import { AppError } from "./errors.js";
import { z } from "zod";
import { config, seal, unseal } from "./config.js";
import type { Database } from "./db.js";
export const semanticSettingsSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z
      .string()
      .trim()
      .refine(
        (v) =>
          !v ||
          (() => {
            try {
              const u = new URL(v);
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
          })(),
        "请输入 HTTP/HTTPS API 地址",
      ),
    model: z.string().trim().max(200),
    apiKey: z.string().max(4096).optional(),
    revision: z.string().trim().min(1).max(100),
    topK: z.number().int().min(1).max(100),
    mode: z.enum(["keyword", "vector", "hybrid"]).default("keyword"),
    minSimilarity: z.number().min(-1).max(1).optional(),
    timeoutMs: z.number().int().min(1000).max(180000),
  })
  .strict();
export type SemanticSettings = z.infer<typeof semanticSettingsSchema>;
export function defaultSemanticSettings(): SemanticSettings {
  return {
    enabled: config.SEMANTIC_RETRIEVAL_ENABLED,
    baseUrl: config.EMBEDDING_BASE_URL,
    model: config.EMBEDDING_MODEL,
    apiKey: config.EMBEDDING_API_KEY,
    revision: config.EMBEDDING_REVISION,
    topK: config.SEMANTIC_TOP_K,
    timeoutMs: config.EMBEDDING_TIMEOUT_MS,
    mode: config.SEMANTIC_RETRIEVAL_ENABLED ? "hybrid" : "keyword",
  };
}
export async function loadSemanticSettings(
  db: Database,
): Promise<SemanticSettings> {
  const [row] = await db.query<{ value: SemanticSettings }>(
    "SELECT value FROM semantic_settings WHERE id=1",
  );
  if (!row) return defaultSemanticSettings();
  return {
    ...defaultSemanticSettings(),
    ...row.value,
    apiKey: row.value.apiKey ? unseal(row.value.apiKey) : "",
  };
}
export function semanticSettingsView(value: SemanticSettings) {
  const { apiKey, ...publicValue } = value;
  return { ...publicValue, apiKeySet: Boolean(apiKey) };
}
export async function resolveSemanticSettings(db: Database, input: unknown) {
  const parsed = semanticSettingsSchema.parse(input);
  const previous = await loadSemanticSettings(db);
  return {
    ...parsed,
    apiKey: parsed.apiKey === undefined ? previous.apiKey : parsed.apiKey,
  };
}
export async function saveSemanticSettings(db: Database, input: unknown) {
  const value = await resolveSemanticSettings(db, input);
  if (value.enabled && (!value.baseUrl || !value.model))
    throw new AppError(422, "启用语义检索前请填写 Embedding 地址和模型");
  await db.query(
    "INSERT INTO semantic_settings(id,value) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET value=$1",
    [
      JSON.stringify({
        ...value,
        apiKey: value.apiKey ? seal(value.apiKey) : "",
      }),
    ],
  );
  return semanticSettingsView(value);
}
