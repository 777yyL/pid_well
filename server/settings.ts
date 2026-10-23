import { z } from "zod";
import type { Database } from "./db.js";
import { seal, unseal } from "./config.js";
import { AppError } from "./errors.js";
export const settingsSchema = z.object({
  modelBaseUrl: z.url().default("https://api.openai.com/v1"),
  model: z.string().max(200).default(""),
  modelApiKey: z.string().max(4096).optional(),
  wikiBaseUrl: z.url().default("http://127.0.0.1:19828"),
  wikiToken: z.string().max(4096).optional(),
  contextWindow: z.number().int().min(8192).max(2000000).default(64000),
  maxOutputTokens: z.number().int().min(512).max(32768).default(8192),
  requireRequirementConfirmation: z.boolean().default(true),
  defaultWikiProjectId: z.string().trim().max(512).default(""),
});
type StoredSettings = z.infer<typeof settingsSchema>;
const agentSchema = settingsSchema
  .pick({
    modelBaseUrl: true,
    model: true,
    modelApiKey: true,
    contextWindow: true,
    maxOutputTokens: true,
    requireRequirementConfirmation: true,
  })
  .strict();
const wikiSchema = settingsSchema
  .pick({ wikiBaseUrl: true, wikiToken: true, defaultWikiProjectId: true })
  .strict();
export async function loadSettings(
  db: Database,
  userId?: string,
): Promise<StoredSettings> {
  const [row] = await db.query<{ value: StoredSettings }>(
    "SELECT value FROM settings WHERE id=1",
  );
  const global = settingsSchema.parse(row?.value ?? {});
  const [personal] = userId
    ? await db.query<{ value: unknown }>(
        "SELECT value FROM user_agent_settings WHERE user_id=$1",
        [userId],
      )
    : [];
  const agent = agentSchema.parse(personal?.value ?? {});
  const settings = userId
    ? { ...global, ...agent, modelApiKey: agent.modelApiKey ?? "" }
    : global;
  return {
    ...settings,
    modelApiKey: settings.modelApiKey ? unseal(settings.modelApiKey) : "",
    wikiToken: settings.wikiToken ? unseal(settings.wikiToken) : "",
  };
}
export async function settingsView(db: Database, userId: string) {
  const s = await loadSettings(db, userId);
  const { modelApiKey, ...rest } = agentSchema.strip().parse(s);
  return { ...rest, modelApiKeySet: !!modelApiKey };
}
export async function saveAgentSettings(
  db: Database,
  userId: string,
  input: unknown,
) {
  const previous = agentSchema.strip().parse(await loadSettings(db, userId));
  const parsed = agentSchema.partial().parse(input);
  const patch = Object.fromEntries(
    Object.entries(parsed).filter(([key]) =>
      Object.hasOwn(input as object, key),
    ),
  );
  const value = agentSchema.parse({
    ...previous,
    ...patch,
    modelApiKey:
      patch.modelApiKey === undefined
        ? previous.modelApiKey
        : patch.modelApiKey,
  });
  if (!["http:", "https:"].includes(new URL(value.modelBaseUrl).protocol))
    throw new AppError(422, "仅支持 HTTP / HTTPS 地址");
  if (value.maxOutputTokens >= value.contextWindow / 2)
    throw new AppError(422, "最大输出长度应小于上下文窗口的一半");
  await db.query(
    "INSERT INTO user_agent_settings(user_id,value) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET value=$2,updated_at=now()",
    [
      userId,
      JSON.stringify({
        ...value,
        modelApiKey: value.modelApiKey ? seal(value.modelApiKey) : "",
      }),
    ],
  );
}
export async function wikiSettingsView(db: Database) {
  const settings = await loadSettings(db);
  return {
    wikiBaseUrl: settings.wikiBaseUrl,
    wikiTokenSet: !!settings.wikiToken,
    defaultWikiProjectId: settings.defaultWikiProjectId,
  };
}
export async function saveWikiSettings(db: Database, input: unknown) {
  const previous = await loadSettings(db);
  const parsed = wikiSchema.partial().parse(input);
  const patch = Object.fromEntries(
    Object.entries(parsed).filter(([key]) =>
      Object.hasOwn(input as object, key),
    ),
  );
  if (patch.defaultWikiProjectId === "current")
    throw new AppError(422, "请选择明确的知识库项目，不能绑定 current");
  await saveSettings(db, { ...previous, ...patch });
}
export async function defaultWikiProject(db: Database) {
  const settings = await loadSettings(db);
  if (
    !settings.defaultWikiProjectId ||
    settings.defaultWikiProjectId === "current"
  )
    throw new AppError(
      422,
      "管理员尚未设置默认产品知识库，请联系管理员在知识库配置中完成设置",
    );
  return settings.defaultWikiProjectId;
}
export async function saveSettings(db: Database, input: unknown) {
  const parsed = settingsSchema.parse(input);
  const previous = await loadSettings(db);
  for (const url of [parsed.modelBaseUrl, parsed.wikiBaseUrl]) {
    if (!["http:", "https:"].includes(new URL(url).protocol))
      throw new AppError(422, "仅支持 HTTP / HTTPS 地址");
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
    throw new AppError(422, "最大输出长度应小于上下文窗口的一半");
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
