import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Segmented, Skeleton, Tag } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Snapshot } from "../shared/domain";
import { api } from "./api";

export function KnowledgeMarkdown({ text }: { text: string }) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (front)
    return (
      <>
        <details className="knowledge-metadata">
          <summary>页面元数据</summary>
          <pre>{front[1]}</pre>
        </details>
        <KnowledgeMarkdown text={text.slice(front[0].length)} />
      </>
    );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ alt }) => (
          <span className="knowledge-image-note">
            图片：{alt || "原文图片"}
          </span>
        ),
        a: ({ href, children }) =>
          href && /^https?:\/\//i.test(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function KnowledgeReader({
  target,
  onClose,
}: {
  target: { id: string; start?: number; end?: number } | null;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [mode, setMode] = useState("markdown"),
    [attempt, setAttempt] = useState(0);
  const highlight = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSnapshot(null);
    setError("");
    setMode("markdown");
    if (!target) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void api<Snapshot>(`/snapshots/${target.id}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target, attempt]);
  useEffect(() => {
    if (mode === "source")
      highlight.current?.scrollIntoView({ block: "center" });
  }, [mode, snapshot]);
  const lines = snapshot?.content.split(/\r?\n/) ?? [];
  return (
    <Drawer
      title="知识库原文"
      open={!!target}
      onClose={onClose}
      width={860}
      className="knowledge-reader"
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 9 }} />
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="原文加载失败"
          description={error}
          action={
            <Button onClick={() => setAttempt((x) => x + 1)}>重试</Button>
          }
        />
      ) : (
        snapshot && (
          <>
            <div className="knowledge-reader-heading">
              <Tag>Markdown · 固定证据快照</Tag>
              <h2>
                {snapshot.content.match(/^#\s+(.+)$/m)?.[1] ||
                  snapshot.path.split(/[\\/]/).pop()?.replace(/\.md$/i, "")}
              </h2>
              <p>{snapshot.path}</p>
            </div>
            <div className="knowledge-reader-toolbar">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: "markdown", label: "阅读正文" },
                  { value: "source", label: "原文与行号" },
                ]}
              />
              {target?.start && (
                <Button onClick={() => setMode("source")}>
                  定位引用 L{target.start}–L{target.end ?? target.start}
                </Button>
              )}
            </div>
            {target?.start && (
              <div className="knowledge-citation">
                <b>
                  本次引用 · L{target.start}–L{target.end ?? target.start}
                </b>
                <KnowledgeMarkdown
                  text={lines
                    .slice(target.start - 1, target.end ?? target.start)
                    .join("\n")}
                />
              </div>
            )}
            {mode === "markdown" ? (
              <article className="knowledge-markdown">
                <KnowledgeMarkdown text={snapshot.content} />
              </article>
            ) : (
              <div className="source-document knowledge-source">
                {lines.map((line, index) => (
                  <div
                    key={index}
                    ref={index + 1 === target?.start ? highlight : undefined}
                    className={
                      target?.start &&
                      index + 1 >= target.start &&
                      index + 1 <= (target.end ?? target.start)
                        ? "highlight"
                        : ""
                    }
                  >
                    <span>L{index + 1}</span>
                    <p>{line || " "}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )
      )}
    </Drawer>
  );
}
