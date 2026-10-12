import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "tender-test-data-"));
process.env.DATA_DIR = directory;
process.env.MAX_AGENT_TURNS = "2";
process.env.MAX_TOTAL_AGENT_TURNS = "8";
process.env.MAX_NO_PROGRESS_TURNS = "3";
process.env.MODEL_REQUEST_TIMEOUT_MS = "1000";
process.env.MODEL_IDLE_TIMEOUT_MS = "1000";
process.env.RUN_HEARTBEAT_MS = "200";
process.on("exit", () => {
  const target = resolve(directory);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith("tender-test-data-")
  )
    throw new Error("拒绝清理非测试目录");
  rmSync(target, { recursive: true, force: true });
});
