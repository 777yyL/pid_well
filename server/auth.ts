import { promisify } from "node:util";
import {
  scrypt as scryptCallback,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import type { User } from "../shared/domain.js";
import { AppError } from "./errors.js";
import { config } from "./config.js";
const scrypt = promisify(scryptCallback);
declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const result = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${result.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, expected] = hash.split(":");
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}
export function requireUser(request: FastifyRequest): User {
  if (!request.user) throw new AppError(401, "请先登录");
  return request.user;
}
export function requireAdmin(request: FastifyRequest): User {
  const user = requireUser(request);
  if (user.role !== "admin") throw new AppError(403, "需要管理员权限");
  return user;
}
export function attachAuth(app: FastifyInstance, db: Database) {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers["x-workspace-request"] !== "1")
        throw new AppError(403, "请求缺少来源校验");
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host)
        throw new AppError(403, "不接受跨站请求");
    }
    const token = request.cookies.workspace_session;
    if (token) {
      const [user] = await db.query<User>(
        `SELECT u.id,u.username,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now() AND u.active=true`,
        [tokenHash(token)],
      );
      request.user = user ?? null;
    }
  });
}
export async function issueSession(db: Database, userId: string) {
  const token = randomBytes(32).toString("hex");
  await db.query("DELETE FROM sessions WHERE expires_at<now()");
  await db.query(
    "INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    [tokenHash(token), userId],
  );
  return {
    token,
    options: {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: config.secure,
      path: "/",
      maxAge: 604800,
    },
  };
}
export async function accessProject(
  db: Database,
  user: User,
  projectId: string,
) {
  const [project] = await db.query(
    `SELECT p.* FROM projects p WHERE p.id=$1 AND (p.owner_id=$2 OR $3='admin' OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2))`,
    [projectId, user.id, user.role],
  );
  if (!project) throw new AppError(404, "项目不存在或无访问权限");
  return project;
}
