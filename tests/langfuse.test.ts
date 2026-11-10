import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

test("Langfuse SDK 本地 OTLP 上报包含模型、工具、并发回复和脱敏证据", async () => {
  const bodies: string[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    bodies.push(body.toString("utf8"));
    paths.push(request.url!);
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.LANGFUSE_ENABLED = "true";
  process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
  const { LangfuseRuns, shutdownLangfuse } =
    await import("../server/langfuse.js");
  try {
    const observer = new LangfuseRuns();
    observer.start({
      id: "test-run",
      project_id: "test-project",
      conversation_id: "test-session",
      user_id: "test-user",
      input: "test requirement",
    });
    observer.event("test-run", "model_request", {
      callId: "a",
      model: "test-model",
      context: {
        apiKey: "credential-must-not-export",
        messages: ["requirement evidence"],
      },
    });
    observer.event("test-run", "model_request", {
      callId: "b",
      model: "test-model",
      context: "second request",
    });
    observer.event("test-run", "model_response", {
      callId: "b",
      response: { content: "second response", usage: { input: 20, output: 3 } },
    });
    observer.event("test-run", "model_response", {
      callId: "a",
      response: {
        content: "first response",
        usage: { input: 10, output: 2, cacheRead: 4 },
        stopReason: "stop",
      },
    });
    observer.event("test-run", "tool_execution_start", {
      toolCallId: "t",
      toolName: "wiki_read",
      args: { path: "wiki/test.md" },
    });
    observer.event("test-run", "tool_execution_end", {
      toolCallId: "t",
      toolName: "wiki_read",
      result: "tool evidence",
      isError: false,
    });
    observer.event("test-run", "run_finished", { status: "completed" });
    observer.close();
    await shutdownLangfuse();
    const payload = bodies.join("\n");
    assert.ok(
      paths.some((path) => path.includes("otel")),
      paths.join(","),
    );
    for (const content of [
      "test-model",
      "wiki_read",
      "test-session",
      "test-user",
      "first response",
      "second response",
      "test-run",
      "[REDACTED]",
    ])
      assert.ok(payload.includes(content), `OTLP 缺少 ${content}`);
    assert.ok(!payload.includes("credential-must-not-export"));
    // SDK calls remain safe even after its exporter has been stopped.
    assert.doesNotThrow(() => observer.event("unknown", "model_request", {}));
  } finally {
    await shutdownLangfuse();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
