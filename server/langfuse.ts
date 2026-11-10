import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  LangfuseOtelSpanAttributes,
  type LangfuseGeneration,
} from "@langfuse/tracing";
import { config } from "./config.js";
import { redactObservation } from "./observation.js";

type Root = ReturnType<typeof startObservation>;
type Child = ReturnType<typeof startObservation>;
type RunInfo = {
  id: string;
  project_id: string;
  conversation_id: string;
  user_id: string;
  input: string;
  evaluation_mode?: string;
  auto_resume_count?: number;
};

let sdk: NodeSDK | undefined;
let initialized = false;
function enabled() {
  if (!config.LANGFUSE_ENABLED) return false;
  if (!initialized) {
    initialized = true;
    if (
      !config.LANGFUSE_PUBLIC_KEY ||
      !config.LANGFUSE_SECRET_KEY ||
      !config.LANGFUSE_BASE_URL
    ) {
      console.warn("Langfuse 未启用：请配置地址、Public Key 和 Secret Key");
      return false;
    }
    try {
      sdk = new NodeSDK({
        spanProcessors: [
          new LangfuseSpanProcessor({
            baseUrl: config.LANGFUSE_BASE_URL,
            publicKey: config.LANGFUSE_PUBLIC_KEY,
            secretKey: config.LANGFUSE_SECRET_KEY,
            environment: config.LANGFUSE_TRACING_ENVIRONMENT,
            exportMode: "batched",
            timeout: 5,
            mask: ({ data }) => redactObservation(data),
          }),
        ],
        instrumentations: [],
      });
      sdk.start();
    } catch {
      sdk = undefined;
      console.warn("Langfuse 初始化失败，评估继续执行");
    }
  }
  return Boolean(sdk);
}

// Explicit parents keep concurrent quick-assessment calls in their own generations.
export class LangfuseRuns {
  private runs = new Map<
    string,
    { root: Root; children: Map<string, Child> }
  >();
  start(run: RunInfo) {
    try {
      if (!enabled()) return;
      this.finish(run.id, { status: "interrupted" });
      const root = startObservation(
        "评标AI执行",
        {
          input: redactObservation(run.input),
          metadata: {
            runId: run.id,
            projectId: run.project_id,
            mode: run.evaluation_mode,
            recovery: run.auto_resume_count ?? 0,
          },
        },
        { asType: "agent" },
      );
      root.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
        run.conversation_id,
      );
      root.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_USER_ID,
        run.user_id,
      );
      this.runs.set(run.id, { root, children: new Map() });
    } catch {
      /* Observability must not stop assessment. */
    }
  }
  event(runId: string, type: string, payload: Record<string, unknown>) {
    try {
      const state = this.runs.get(runId);
      if (!state) return;
      const p = redactObservation(payload) as Record<string, unknown>;
      const parentSpanContext = state.root.otelSpan.spanContext();
      if (type === "model_request" || type === "tool_execution_start") {
        const model = type === "model_request";
        const key = `${model ? "model" : "tool"}:${p.callId ?? p.toolCallId}`;
        const child = model
          ? startObservation(
              "模型调用",
              { model: String(p.model), input: p.context },
              { asType: "generation", parentSpanContext },
            )
          : startObservation(
              String(p.toolName),
              { input: p.args },
              { asType: "tool", parentSpanContext },
            );
        state.children.set(key, child);
      } else if (type === "model_response" || type === "tool_execution_end") {
        const model = type === "model_response";
        const key = `${model ? "model" : "tool"}:${p.callId ?? p.toolCallId}`;
        const child = state.children.get(key);
        const response = p.response as
          | {
              usage?: Record<string, number>;
              stopReason?: string;
              errorMessage?: string;
            }
          | undefined;
        const error =
          p.error ||
          p.isError ||
          ["error", "aborted"].includes(response?.stopReason ?? "");
        child?.update({
          output: model ? p.response : p.result,
          level: error ? "ERROR" : "DEFAULT",
          statusMessage: error
            ? String(p.error ?? response?.errorMessage ?? "工具或模型失败")
            : undefined,
        });
        if (model && response?.usage) {
          const u = response.usage;
          // Pi input excludes cache tokens. Preserve cache categories without double counting.
          const generation = child as LangfuseGeneration;
          generation?.update({
            usageDetails: {
              input: u.input ?? 0,
              output: u.output ?? 0,
              input_cache_read: u.cacheRead ?? 0,
              input_cache_write: u.cacheWrite ?? 0,
            },
          });
        }
        child?.end();
        state.children.delete(key);
      } else if (type === "run_finished") this.finish(runId, p);
      else if (["run_retry", "context_compaction"].includes(type))
        startObservation(
          type,
          { input: p },
          { asType: "event", parentSpanContext },
        );
    } catch {
      /* SDK failures are isolated from business execution. */
    }
  }
  finish(runId: string, output: Record<string, unknown>) {
    const state = this.runs.get(runId);
    if (!state) return;
    this.runs.delete(runId);
    try {
      for (const child of state.children.values())
        child
          .update({ level: "WARNING", statusMessage: "执行结束前调用未完成" })
          .end();
      const clean = redactObservation(output);
      state.root.update({
        output: clean,
        level: output.status === "failed" ? "ERROR" : "DEFAULT",
      });

      state.root.end();
    } catch {
      /* Best effort cleanup. */
    }
  }
  close() {
    for (const id of this.runs.keys())
      this.finish(id, { status: "interrupted" });
  }
}

export async function shutdownLangfuse() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    console.warn("Langfuse 关闭上报未完成");
  }
}
