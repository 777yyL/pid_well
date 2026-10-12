// Isolated browser QA environment. Never seeds the user's working database.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/index.js";
import { hashPassword } from "../server/auth.js";
const directory = await mkdtemp(join(tmpdir(), "tender-ui-"));
const db = await openDatabase("", directory);
await migrate(db);
const userId = randomUUID();
const projectId = randomUUID();
await db.query(
  "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
  [
    userId,
    "qa_user",
    "界面验证账号",
    await hashPassword("isolated-ui-test"),
    "admin",
  ],
);
await db.query("INSERT INTO bootstrap(id) VALUES(1)");
await db.query(
  "INSERT INTO projects(id,name,description,wiki_project_id,owner_id) VALUES($1,$2,$3,$4,$5)",
  [
    projectId,
    "界面验证项目",
    "仅用于浏览器交互验证，不属于实际业务数据",
    "ec087b7b-beb8-4e7d-920c-b6d169e58a9d",
    userId,
  ],
);
const { app } = await createApp(db, true);
await app.listen({ host: "127.0.0.1", port: 4321 });
async function close() {
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
