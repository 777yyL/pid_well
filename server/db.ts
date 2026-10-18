import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { resolve } from "node:path";
import { config } from "./config.js";
export interface Database {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  url = config.DATABASE_URL,
  directory = resolve(config.dataDir, "postgres"),
): Promise<Database> {
  if (url) {
    const pool = new Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    const lock = await pool.connect();
    const locked = await lock.query(
      "SELECT pg_try_advisory_lock(78103452) AS locked",
    );
    if (!locked.rows[0].locked) {
      lock.release();
      await pool.end();
      throw new Error(
        "同一数据库已有工作台实例运行。当前版本使用单实例任务调度。",
      );
    }
    const wrap = (client: { query: Function }): Database => ({
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await client.query(sql, params)).rows as T[],
      transaction: async () => {
        throw new Error("不支持嵌套事务");
      },
      close: async () => {},
    });
    const db: Database = {
      ...wrap(pool),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      close: async () => {
        await lock.query("SELECT pg_advisory_unlock(78103452)");
        lock.release();
        await pool.end();
      },
    };
    return db;
  }
  const engine = new PGlite(directory);
  await engine.waitReady;
  const wrap = (client: { query: Function }): Database => ({
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as T[],
    transaction: async () => {
      throw new Error("不支持嵌套事务");
    },
    close: async () => {},
  });
  return {
    ...wrap(engine),
    transaction: (fn) => engine.transaction((tx) => fn(wrap(tx))),
    close: () => engine.close(),
  };
}
const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS settings (id integer PRIMARY KEY CHECK(id=1), value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bootstrap (id integer PRIMARY KEY CHECK(id=1))`,
  `CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', wiki_project_id text NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS project_members (project_id uuid REFERENCES projects(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id), PRIMARY KEY(project_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS conversations (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), title text NOT NULL, context jsonb NOT NULL DEFAULT '[]', plan jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS runs (id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), project_id uuid NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id), input text NOT NULL, idempotency_key uuid NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')), error text, turn_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_active_project_run ON runs(project_id) WHERE status IN ('queued','running')`,
  `CREATE TABLE IF NOT EXISTS messages (id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), run_id uuid REFERENCES runs(id), role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS run_events (id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS run_events_lookup ON run_events(run_id,id)`,
  `CREATE TABLE IF NOT EXISTS documents (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, storage_name text NOT NULL, hash text NOT NULL, status text NOT NULL, error text, lines jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS requirements (id text NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), data jsonb NOT NULL, confirmed boolean NOT NULL DEFAULT false, PRIMARY KEY(project_id,id))`,
  `CREATE TABLE IF NOT EXISTS snapshots (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), path text NOT NULL, content text NOT NULL, hash text NOT NULL, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,path,hash))`,
  `CREATE TABLE IF NOT EXISTS assessments (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), requirement_id text NOT NULL, data jsonb NOT NULL, source text NOT NULL CHECK(source IN ('agent','human')), reviewed boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,requirement_id), FOREIGN KEY(project_id,requirement_id) REFERENCES requirements(project_id,id))`,
  `CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, project_id uuid REFERENCES projects(id), user_id uuid REFERENCES users(id), run_id uuid REFERENCES runs(id), action text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS artifacts (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), name text NOT NULL, storage_name text NOT NULL, format text NOT NULL, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS checkpoint jsonb NOT NULL DEFAULT '{"summary":"","readRanges":{},"compressions":0}'`,
  `CREATE TABLE IF NOT EXISTS product_scopes (project_id uuid PRIMARY KEY REFERENCES projects(id),revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','legacy')),recommendations jsonb NOT NULL DEFAULT '[]',selected jsonb NOT NULL DEFAULT '[]',strategy text NOT NULL DEFAULT '',confirmed_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now())`,
  `INSERT INTO product_scopes(project_id,status) SELECT p.id,CASE WHEN EXISTS(SELECT 1 FROM assessments a WHERE a.project_id=p.id) THEN 'legacy' ELSE 'pending' END FROM projects p ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS result_shares (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),created_by uuid NOT NULL REFERENCES users(id),token_hash text UNIQUE NOT NULL,token_cipher text NOT NULL,snapshot jsonb NOT NULL,artifact_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS result_shares_project ON result_shares(project_id,created_at DESC)`,
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS capability_sessions (id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),wiki_project_id text NOT NULL,source_project_id uuid REFERENCES projects(id) ON DELETE CASCADE,title text NOT NULL,status text NOT NULL DEFAULT 'idle',data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS capability_sessions_user ON capability_sessions(user_id,updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS capability_pages (id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES capability_sessions(id) ON DELETE CASCADE,turn_id uuid NOT NULL,path text NOT NULL,content text NOT NULL,hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,path,hash))`,
];
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    for (const sql of migrations) await tx.query(sql);
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING",
    );
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING",
    );
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING",
    );
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING",
    );
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING",
    );
  });
}
export async function audit(
  db: Database,
  projectId: string | null,
  userId: string | null,
  runId: string | null,
  action: string,
  data: unknown,
) {
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO audit_log(project_id,user_id,run_id,action,data) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [projectId, userId, runId, action, JSON.stringify(data)],
  );
  return row.id;
}
