import { useState, useEffect, useCallback, useRef } from "react";
import { App as AntApp } from "antd";
import type {
  Project,
  Workspace,
  ChatMessage,
  RunEvent,
} from "../shared/domain";
import { api, post } from "./api";
import { createRequestId } from "./request-id";
export type WorkspaceData = Workspace & {
  artifacts: { id: string; name: string; format: string; created_at: string }[];
  findings: {
    id: number;
    data: { category: string; content: string };
    created_at: string;
  }[];
};
export function useWorkspace() {
  const { message } = AntApp.useApp();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(
    localStorage.getItem("workspace.project") ?? "",
  );
  const [conversationId, setConversationId] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streaming, setStreaming] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const selected = useRef({ projectId, conversationId });
  const pendingSubmission = useRef<{
    conversationId: string;
    text: string;
    key: string;
  } | null>(null);
  selected.current = { projectId, conversationId };
  const refreshProjects = useCallback(async () => {
    const rows = await api<Project[]>("/projects");
    setProjects(rows);
    setProjectId((current) =>
      rows.some((p) => p.id === current) ? current : (rows[0]?.id ?? ""),
    );
  }, []);
  const refresh = useCallback(async () => {
    const id = selected.current.projectId;
    if (!id) return;
    const data = await api<WorkspaceData>(`/projects/${id}`);
    if (selected.current.projectId !== id) return;
    setWorkspace(data);
    setLoadError("");
    setConversationId((current) =>
      data.conversations.some((c) => c.id === current)
        ? current
        : (data.conversations[0]?.id ?? ""),
    );
  }, []);
  useEffect(() => {
    void refreshProjects().catch((e) => setLoadError(e.message));
  }, [refreshProjects]);
  useEffect(() => {
    setWorkspace(null);
    setMessages([]);
    setEvents([]);
    setStreaming("");
    setConversationId("");
    if (!projectId) return;
    localStorage.setItem("workspace.project", projectId);
    setLoading(true);
    void refresh()
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, refresh]);
  const loadMessages = useCallback(async () => {
    const id = selected.current.conversationId;
    if (!id) {
      setMessages([]);
      return;
    }
    const rows = await api<ChatMessage[]>(`/conversations/${id}/messages`);
    if (selected.current.conversationId === id) setMessages(rows);
  }, []);
  useEffect(() => {
    setEvents([]);
    setStreaming("");
    void loadMessages().catch((e) => message.error(e.message));
  }, [conversationId, loadMessages, message]);
  const activeRun = workspace?.runs.find(
    (r) => r.status === "running" || r.status === "queued",
  );
  const latestRun = workspace?.runs.find(
    (r) => r.conversation_id === conversationId,
  );
  const runId = latestRun?.id;
  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    setStreaming("");
    let live = true;
    let cursor = 0;
    let busy = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!live || busy) return;
      busy = true;
      try {
        const data = await api<{ events: RunEvent[]; run: { status: string } }>(
          `/runs/${runId}/events?after=${cursor}`,
        );
        if (!live) return;
        setLoadError("");
        const batch = data.events.map((e) => ({ ...e, id: Number(e.id) }));
        if (batch.length) {
          cursor = batch.at(-1)!.id;
          setEvents((previous) => [...previous, ...batch].slice(-500));
          for (const event of batch) {
            if (event.type === "text_delta")
              setStreaming((s) => s + String(event.payload.text ?? ""));
            if (event.type === "assistant_start") setStreaming("");
            if (event.type === "assistant_end") setStreaming("");
          }
          if (batch.some((e) => e.type === "assistant_end"))
            await loadMessages();
          if (
            batch.some((e) =>
              ["tool_execution_end", "plan_updated", "run_finished"].includes(
                e.type,
              ),
            )
          )
            await refresh();
        }
        const terminal = !["queued", "running"].includes(data.run.status);
        if (terminal && batch.length < 200) {
          await Promise.all([loadMessages(), refresh()]);
          setStreaming("");
          return;
        }
      } catch (e) {
        if (live) setLoadError((e as Error).message);
      } finally {
        busy = false;
      }
      if (live) timeout = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [runId, loadMessages, refresh]);
  useEffect(() => {
    if (!projectId) return;
    const timer = setInterval(
      () => void refresh().catch((e) => setLoadError(e.message)),
      5000,
    );
    return () => clearInterval(timer);
  }, [projectId, refresh]);
  async function send(text: string) {
    if (!projectId || !text.trim()) return;
    setSending(true);
    try {
      let id = conversationId;
      if (!id) {
        const created = await post<{ id: string }>(
          `/projects/${projectId}/conversations`,
        );
        id = created.id;
        setConversationId(id);
      }
      if (
        pendingSubmission.current?.conversationId !== id ||
        pendingSubmission.current.text !== text
      )
        pendingSubmission.current = {
          conversationId: id,
          text,
          key: createRequestId(),
        };
      await post(`/conversations/${id}/runs`, {
        message: text,
        idempotencyKey: pendingSubmission.current.key,
      });
      pendingSubmission.current = null;
      await refresh();
      await loadMessages();
    } catch (e) {
      message.error((e as Error).message);
      throw e;
    } finally {
      setSending(false);
    }
  }
  async function newConversation() {
    if (!projectId) return;
    try {
      const result = await post<{ id: string }>(
        `/projects/${projectId}/conversations`,
      );
      await refresh();
      setConversationId(result.id);
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function cancel() {
    if (!activeRun) return;
    try {
      await post(`/runs/${activeRun.id}/cancel`);
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  return {
    projects,
    projectId,
    setProjectId,
    conversationId,
    setConversationId,
    workspace,
    messages,
    events,
    streaming,
    loading,
    loadError,
    sending,
    activeRun,
    latestRun,
    refreshProjects,
    refresh,
    send,
    newConversation,
    cancel,
  };
}
