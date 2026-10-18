import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Wiki 诊断脚本运行真实工具并输出报告，凭据不进入报告", async () => {
  const product = "wiki/entities/products/demo.md";
  const sale = "wiki/entities/sale-items/demo-v1.5.100-video.md";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/files"))
      res.end(
        JSON.stringify({
          ok: true,
          truncated: false,
          files: [
            { path: "//?/D:/company/" + product },
            { path: "//?/D:/company/" + sale },
          ],
        }),
      );
    else if (url.pathname.endsWith("/files/content")) {
      const path = url.searchParams.get("path");
      if (path === product)
        res.end(
          JSON.stringify({
            content:
              "# Demo\n## 销售项清单\n### v1.5.100（1 项）\n- [[demo-v1.5.100-video|视频管理]]",
          }),
        );
      else if (path === sale)
        res.end(
          JSON.stringify({
            content:
              "---\ntitle: 视频管理\nproduct: Demo\nversion: v1.5.100\nmodule_id: VIDEO\n---\n支持视频管理",
          }),
        );
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), "wiki-script-test-"));
  const output = join(directory, "report.json");
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/diagnose-wiki.ts",
        "--wiki-url",
        `http://127.0.0.1:${port}`,
        "--wiki-project",
        "test",
        "--product-name",
        "Demo",
        "--product-path",
        product,
        "--version",
        "v1.5.100",
        "--query",
        "视频",
        "--output",
        output,
      ],
      {
        env: { ...process.env, LLM_WIKI_API_TOKEN: "diagnostic-secret" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (v) => (logs += v));
    child.stderr.on("data", (v) => (logs += v));
    const code = await new Promise<number | null>((r, j) => {
      child.on("exit", r);
      child.on("error", j);
    });
    assert.equal(code, 0, logs);
    const text = await readFile(output, "utf8");
    assert.ok(!text.includes("diagnostic-secret"));
    const report = JSON.parse(text);
    assert.equal(report.catalogComplete, true);
    assert.equal(report.saleCount, 1);
    assert.ok(
      report.stages.some(
        (s: { name: string; ok: boolean }) =>
          s.name.startsWith("save_assessments") && s.ok,
      ),
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
