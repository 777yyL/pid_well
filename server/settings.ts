import { z } from "zod";
import type { Database } from "./db.js";
import { seal, unseal } from "./config.js";
export const settingsSchema = z.object({
  modelBaseUrl: z.url().default("https://api.openai.com/v1"),
  model: z.string().max(200).default(""),
  modelApiKey: z.string().max(4096).optional(),
  wikiBaseUrl: z.url().default("http://127.0.0.1:19828"),
  wikiToken: z.string().max(4096).optional(),
  contextWindow: z.number().int().min(8192).max(2000000).default(64000),
  maxOutputTokens: z.number().int().min(512).max(32768).default(8192),
  requireRequirementConfirmation: z.boolean().default(true),
});
type StoredSettings = z.infer<typeof settingsSchema>;
export async function loadSettings(db: Database): Promise<StoredSettings> {
  const [row] = await db.query<{ value: StoredSettings }>(
    "SELECT value FROM settings WHERE id=1",
  );
  const settings = row?.value ?? settingsSchema.parse({});
  return {
    ...settings,
    modelApiKey: settings.modelApiKey ? unseal(settings.modelApiKey) : "",
    wikiToken: settings.wikiToken ? unseal(settings.wikiToken) : "",
  };
}
export async function settingsView(db: Database) {
  const s = await loadSettings(db);
  const { modelApiKey, wikiToken, ...rest } = s;
  return { ...rest, modelApiKeySet: !!modelApiKey, wikiTokenSet: !!wikiToken };
}
export async function saveSettings(db: Database, input: unknown) {
  const parsed = settingsSchema.parse(input);
  const previous = await loadSettings(db);
  for (const url of [parsed.modelBaseUrl, parsed.wikiBaseUrl]) {
    if (!["http:", "https:"].includes(new URL(url).protocol))
      throw new Error("仅支持 HTTP / HTTPS 地址");
  }
  const value = {
    ...parsed,
    modelApiKey:
      parsed.modelApiKey === undefined
        ? previous.modelApiKey
        : parsed.modelApiKey,
    wikiToken:
      parsed.wikiToken === undefined ? previous.wikiToken : parsed.wikiToken,
  };
  if (value.maxOutputTokens >= value.contextWindow / 2)
    throw new Error("最大输出长度应小于上下文窗口的一半");
  await db.query(
    "INSERT INTO settings(id,value) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET value=$1",
    [
      JSON.stringify({
        ...value,
        modelApiKey: value.modelApiKey ? seal(value.modelApiKey) : "",
        wikiToken: value.wikiToken ? seal(value.wikiToken) : "",
      }),
    ],
  );
}
