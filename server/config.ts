import "dotenv/config";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
const env = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4317),
    PUBLIC_BASE_URL: z
      .string()
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        } catch {
          return false;
        }
      }, "PUBLIC_BASE_URL 必须为 HTTP/HTTPS 访问入口，不能包含路径或凭据")
      .transform((value) => value.replace(/\/$/, "")),
    DATA_DIR: z.string().default("./data"),
    DATABASE_URL: z.string().default(""),
    COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
    MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(8).default(2),
    MAX_AUTO_RECOVERIES: z.coerce.number().int().min(0).max(5).default(3),
    RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(900000),
    MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600000),
    MODEL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
    RUN_HEARTBEAT_MS: z.coerce.number().int().min(200).default(5000),
    MAX_AGENT_TURNS: z.coerce.number().int().min(1).max(200).default(40),
    MAX_TOTAL_AGENT_TURNS: z.coerce
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(400),
    MAX_NO_PROGRESS_TURNS: z.coerce.number().int().min(2).max(100).default(12),
  })
  .parse(process.env);
export const config = {
  ...env,
  dataDir: resolve(env.DATA_DIR),
  secure: env.COOKIE_SECURE === "true",
  production: process.env.NODE_ENV
    ? process.env.NODE_ENV === "production"
    : /[\\/]dist[\\/]server[\\/]index\.js$/.test(process.argv[1] ?? ""),
};
mkdirSync(config.dataDir, { recursive: true });
const keyPath = resolve(config.dataDir, "encryption.key");
if (!process.env.APP_ENCRYPTION_KEY && !existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
const key = Buffer.from(
  process.env.APP_ENCRYPTION_KEY || readFileSync(keyPath, "utf8").trim(),
  "hex",
);
if (key.length !== 32)
  throw new Error("APP_ENCRYPTION_KEY 必须是 64 个十六进制字符");
export function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function unseal(value: string): string {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
    "utf8",
  );
}
