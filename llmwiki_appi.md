## API + MCP

通过本地 HTTP API 将 LLM Wiki 开放给你的脚本和工具，也可以额外启用内置 MCP 服务供智能体客户端访问。

启用本地 HTTP API

关闭后，即使已配置 token，除 /health 外的所有接口都会返回 503。可作为不清空 token 的临时关闭开关。

允许无 token 访问

仅用于可信的本地智能体。启用后，这台机器上的任何进程或浏览器页面都可以调用 API。

允许 API 和 Clip server 局域网访问

重启应用后，API 和 Clip server 会监听 0.0.0.0，而不是 127.0.0.1。仅在可信网络中使用，除非完全信任局域网，否则请保留 token 鉴权。

状态

运行中，无需鉴权

服务地址

http://127.0.0.1:19828

/health 始终无需鉴权。其他接口遵循下方的访问模式，但 Agent 对话、取消和单页向量化始终需要 token。

### 访问令牌

通过 `Authorization: Bearer <token>` 或 `X-LLM-Wiki-Token: <token>` 发送。启用无认证访问后，读取类接口可以省略 token，但 Agent 对话、取消和单页向量化接口始终需要 token。环境变量 LLM_WIKI_API_TOKEN 优先生效。

读取类接口已开放，但 Agent 对话仍使用此 token



请妥善保管。任何能访问这台机器 localhost 的进程拿到 token 后，都能通过 API 读取你的项目内容。

推荐使用 Authorization header —— 将 token 放在 ?token=… 查询参数里会泄露到 shell 历史、日志和 Referer。

### 示例请求

```
curl http://127.0.0.1:19828/api/v1/projects
```

### Agent 对话与流式输出

向 /chat POST 消息。默认在 Agent 完成后返回一个 JSON 文档；设置 stream: true 或发送 Accept: text/event-stream 可在执行过程中接收 SSE 事件。

JSON 模式

省略 stream 或设为 false。请求会在完整 Agent 回合结束后返回。

SSE 模式

事件顺序为 meta、增量 agent 事件，最后是 done、cancelled 或 error。done 包含完整汇总结果。

Agent 对话及其取消接口始终需要 token，即使读取类接口允许无认证访问。

```
curl -N -X POST \
  -H "Authorization: Bearer <your-token>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  http://127.0.0.1:19828/api/v1/projects/current/chat \
  -d '{"message":"Summarize this knowledge base.","stream":true}'
```

### 接口列表

把 {id} 替换为项目 UUID、项目文件系统路径，或字面量 'current'。

GET/api/v1/health— 存活探针。无需鉴权。

GET/api/v1/projects— 列出所有已知项目及其 ID 和路径。

GET/api/v1/projects/{id}/files— ?root=wiki|sources|all；?recursive=false；?maxFiles=N（≤10000）。

GET/api/v1/projects/{id}/files/content— ?path=wiki/index.md —— 仅文本文件，最大 2 MB。

GET/api/v1/projects/{id}/reviews— ?status=unresolved|resolved|all；?type=missing-page；?limit=N。默认返回未解决的 Review 项。

PATCH/api/v1/projects/{id}/reviews/{reviewId}— 更新单个 Review 项。JSON body：{ resolved?, action? }（resolved 默认为 true；传 false 可重新打开）。使用 Review 标签页的刷新按钮重新读取。

POST/api/v1/projects/{id}/reviews/resolve— 批量解决 Review 项。JSON body：{ ids, action? }。返回 { resolved, notFound, count }。

POST/api/v1/projects/{id}/search— JSON body：{ query, topK?, includeContent?, queryEmbedding? }。配置嵌入后使用统一的关键词 + 向量检索。

GET/api/v1/projects/{id}/graph— ?q=…&nodeType=…&limit=N —— 基于 wiki/*.md 的双链图谱。

POST/api/v1/projects/{id}/sources/rescan— 使用你的资料文件夹监控配置触发后端重新扫描。

POST/api/v1/projects/{id}/pages/embed— 为一个已有的 wiki/*.md 页面建立向量索引。JSON body：{ path, force? }。返回 revision 和写入的分块数量。始终需要 Token。

POST/api/v1/projects/{id}/chat— Agent 对话。默认返回 JSON；使用 stream: true 或 Accept: text/event-stream 可启用 SSE 流式输出。此接口始终需要 Token。

POST/api/v1/projects/{id}/chat/{sessionId}/cancel— 取消指定会话当前正在执行的 Agent 回合。此接口始终需要 Token。

启用 MCP 访问

MCP 复用本地 API 和同一套 token 规则。保持 HTTP API 启用后，将 MCP 客户端连接到内置 Node 服务即可。

### MCP 使用说明

先执行一次 `npm run mcp:build`，然后让 MCP 客户端运行下面的服务配置。除非启用了无认证访问，否则需要设置 LLM_WIKI_API_TOKEN。

```
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": [
        "\\\\?\\D:\\DevTools\\LLM Wiki\\mcp-server\\dist\\src\\index.js"
      ]
    }
  }
}
```