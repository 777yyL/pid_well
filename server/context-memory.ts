import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Database } from "./db.js";
import { productScope } from "./product-scope.js";

export interface Checkpoint {
  summary: string;
  readRanges: Record<string, [number, number][]>;
  compressions: number;
  updatedAt?: string;
}
export const emptyCheckpoint = (): Checkpoint => ({
  summary: "",
  readRanges: {},
  compressions: 0,
});

export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && range[0] <= previous[1] + 1)
      previous[1] = Math.max(previous[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

/** Only successful read results count as completed reading. */
export function updateReadRanges(
  checkpoint: Checkpoint,
  messages: AgentMessage[],
) {
  const calls = new Map<
    string,
    { documentId: string; start: number; count: number }
  >();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const part of message.content) {
        if (part.type === "toolCall" && part.name === "read_document")
          calls.set(
            part.id,
            part.arguments as {
              documentId: string;
              start: number;
              count: number;
            },
          );
      }
    if (message.role !== "toolResult" || message.isError) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    try {
      const body = JSON.parse(
        message.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
      );
      const start = call.start ?? 1;
      const end = Math.min(body.total, start + (call.count ?? 200) - 1);
      if (!Number.isInteger(end) || end < start) continue;
      checkpoint.readRanges[call.documentId] = mergeRanges([
        ...(checkpoint.readRanges[call.documentId] ?? []),
        [start, end],
      ]);
    } catch {
      /* A malformed tool response must not invent reading progress. */
    }
  }
}

/** Keep complete assistant/tool-result groups and the current user instruction. */
export function recentContext(
  messages: AgentMessage[],
  budget: number,
): AgentMessage[] {
  const groups: AgentMessage[][] = [];
  for (const message of messages.filter((m) => m.role !== "system")) {
    if (
      message.role === "toolResult" &&
      groups.at(-1)?.[0].role === "assistant"
    )
      groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  const selected: AgentMessage[][] = [];
  let size = 0;
  for (const group of groups.toReversed()) {
    const cost = JSON.stringify(group).length;
    if (selected.length && size + cost > budget) break;
    selected.unshift(group);
    size += cost;
  }
  const latestUser = messages.findLast((m) => m.role === "user");
  const result = selected.flat();
  if (latestUser && !result.includes(latestUser)) result.unshift(latestUser);
  return result;
}

export function summaryInput(messages: AgentMessage[]) {
  return messages
    .slice(-120)
    .map((m) => {
      if (m.role === "user") return { role: m.role, content: m.content };
      if (m.role === "assistant")
        return {
          role: m.role,
          content: m.content.filter((p) => p.type !== "thinking"),
        };
      if (m.role === "toolResult")
        return {
          role: m.role,
          toolName: m.toolName,
          isError: m.isError,
          content: m.content
            .filter((p) => p.type === "text")
            .map((p) =>
              p.text.slice(
                0,
                m.toolName === "read_document" || m.toolName === "wiki_read"
                  ? 200
                  : 1500,
              ),
            ),
        };
      return null;
    })
    .filter(Boolean);
}

export async function durableFacts(
  db: Database,
  projectId: string,
  conversationId: string,
) {
  const [project] = await db.query(
    "SELECT name,description,wiki_project_id FROM projects WHERE id=$1",
    [projectId],
  );
  const [conversation] = await db.query(
    "SELECT plan FROM conversations WHERE id=$1",
    [conversationId],
  );
  const documents = await db.query(
    "SELECT id,name,status,jsonb_array_length(lines) AS total FROM documents WHERE project_id=$1",
    [projectId],
  );
  const [requirements] = await db.query(
    "SELECT count(*)::int AS total,count(*) FILTER(WHERE confirmed)::int AS confirmed FROM requirements WHERE project_id=$1",
    [projectId],
  );
  const [assessments] = await db.query(
    "SELECT count(*)::int AS total,count(*) FILTER(WHERE reviewed)::int AS reviewed,count(*) FILTER(WHERE source='human')::int AS human FROM assessments WHERE project_id=$1",
    [projectId],
  );
  const findings = await db.query(
    "SELECT data FROM audit_log WHERE project_id=$1 AND action='finding' ORDER BY id DESC LIMIT 10",
    [projectId],
  );
  return {
    project,
    plan: conversation?.plan,
    productScope: await productScope(db, projectId),
    documents,
    requirements,
    assessments,
    findings,
  };
}
