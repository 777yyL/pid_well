export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Workspace-Request", "1");
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: options.credentials ?? "same-origin",
    signal: options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(
            options.body instanceof FormData ? 180000 : 20000,
          ),
        ])
      : AbortSignal.timeout(options.body instanceof FormData ? 180000 : 20000),
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new Error(
        "服务响应超时，正在重新连接。任务可能仍在执行，请勿重复提交",
      );
    if (error instanceof TypeError)
      throw new Error("无法连接服务，正在重新连接。请检查网络连接");
    throw error;
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "服务连接失败" }));
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
