import type { Database } from "./db.js";
import { loadSettings } from "./settings.js";
import { AppError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
export const PRODUCT_OVERVIEW_PATH = "wiki/overview.md";
export class WikiClient {
  constructor(
    private db: Database,
    private signal?: AbortSignal,
  ) {}
  async request(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const settings = await loadSettings(this.db);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (settings.wikiToken)
      headers.Authorization = `Bearer ${settings.wikiToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const signal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const response = await fetch(
      `${settings.wikiBaseUrl.replace(/\/$/, "")}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new AppError(502, `LLM Wiki 请求失败（HTTP ${response.status}）`);
    const data = (await response.json()) as Record<string, unknown>;
    if (data.ok === false)
      throw new AppError(502, "LLM Wiki 返回失败，请检查项目和接口配置");
    return data;
  }
  projects() {
    return this.request("/api/v1/projects");
  }
  async files(projectId: string): Promise<string[]> {
    const result = await this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?root=wiki&recursive=true&maxFiles=10000`,
    );
    const paths = new Set<string>();
    const visit = (value: unknown): void => {
      if (
        typeof value === "string" &&
        value.startsWith("wiki/") &&
        value.endsWith(".md")
      )
        paths.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object")
        Object.values(value).forEach(visit);
    };
    visit(result);
    return [...paths];
  }
  search(projectId: string, query: string, topK = 5) {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/search`,
      { query, topK, includeContent: true },
    );
  }
  graph(projectId: string, query: string) {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/graph?q=${encodeURIComponent(query)}&limit=30`,
    );
  }
  async read(projectId: string, path: string) {
    if (!path.startsWith("wiki/") || path.includes("..") || path.includes("\\"))
      throw new AppError(400, "只允许读取 wiki/ 下的页面");
    const result = await this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
    );
    if (typeof result.content !== "string")
      throw new AppError(502, "知识库读取响应缺少 content 字段");
    return result.content;
  }
}
export async function snapshotPage(
  db: Database,
  projectId: string,
  path: string,
  content: string,
) {
  const hash = createHash("sha256").update(content).digest("hex");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = frontmatter ? parseYaml(frontmatter[1]) : null;
  const kind =
    path === PRODUCT_OVERVIEW_PATH
      ? "overview"
      : meta?.type === "product" ||
          meta?.tags?.includes("product") ||
          path.includes("/products/")
        ? "product"
        : "page";
  const [snapshot] = await db.query<{
    id: string;
    path: string;
    content: string;
    hash: string;
    kind: string;
  }>(
    `INSERT INTO snapshots(id,project_id,path,content,hash,kind) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,path,hash) DO UPDATE SET hash=EXCLUDED.hash RETURNING *`,
    [randomUUID(), projectId, path, content, hash, kind],
  );
  return snapshot;
}
