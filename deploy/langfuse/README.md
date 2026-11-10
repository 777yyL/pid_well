# 评标AI接入 Langfuse（内网单机测试部署）

本目录是独立的观测服务，不替换评标AI的 PostgreSQL，不需要给模型调用设置代理。评标AI后端通过 Langfuse SDK / OpenTelemetry 异步上报，模型仍按账户中配置的连接调用。配置文件基于 [官方 Compose 部署](https://langfuse.com/self-hosting/deployment/docker-compose) 简化为六个服务：Web、Worker、PostgreSQL、ClickHouse、Redis、MinIO。

## 1. 环境与版本

- Docker Engine + Compose v2；Windows 使用 Docker Desktop 的 Linux containers。
- 官方单机建议至少 4 核、16 GiB 内存、100 GiB 存储；若和评标AI、Embedding服务共机，应额外预留这些服务的资源。
- 本项目使用 JS/TS SDK v6，服务端必须为 Langfuse v4，最低 4.59.0，不能直接接入 v3。见 [官方兼容要求](https://langfuse.com/docs/observability/sdk/overview)。测试配置使用 `4` 标签；正式部署将 `LF_IMAGE_TAG` 固定为验收通过的明确 v4 版本或镜像 digest，Web 与 Worker 保持同版本。
- 需要能拉取 Docker Hub、docker.langfuse.com、cgr.dev 镜像；隔离网络应先在可联网机器拉取并导入内部镜像仓库。

默认只将 Web 的 53000 端口绑定本机。数据库、Redis、ClickHouse、MinIO 不开放宿主机端口。本方案覆盖文本链路观测，未开放浏览器直传媒体附件功能。

## 2. 准备独立配置

以下命令在仓库根目录运行（PowerShell）：

```powershell
Copy-Item deploy/langfuse/.env.example deploy/langfuse/.env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

分别生成七个不同的随机值，填入新配置中的全部密码、SALT、AUTH_SECRET、ENCRYPTION_KEY。不要覆盖已有部署的 `.env`；尤其不能随意更换加密密钥。密码使用随机十六进制，避免数据库 URL 中特殊字符转义问题。这些值均不提交 Git。

本机测试保留默认地址即可。内网同事访问时，将 `LF_BIND_ADDRESS` 改为服务器内网 IP，并将 `LF_PUBLIC_URL` 改为 `http://服务器内网IP:53000`，只向需要的内网网段开放此端口。长期部署推荐反向代理 HTTPS，对外 URL 与 `LF_PUBLIC_URL` 一致。

## 3. 启动观测服务

```powershell
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml config --quiet
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml pull
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml up -d
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml ps
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml logs --tail 100 web worker
```

首次启动会初始化数据和迁移，等待 Web 就绪后打开 `http://localhost:53000`（内网部署使用配置的 URL）。没有默认管理员账号：注册首个账号，创建组织和项目，在项目设置中创建 Public Key / Secret Key。这里的 Key 属于 Langfuse 项目，不是模型 API Key，也不是前一步的数据库密码。

## 4. 接入评标AI

在**仓库根目录**评标AI的 `.env` 中填写：

```dotenv
LANGFUSE_ENABLED=true
LANGFUSE_BASE_URL=http://127.0.0.1:53000
LANGFUSE_PUBLIC_KEY=填写Langfuse项目PublicKey
LANGFUSE_SECRET_KEY=填写Langfuse项目SecretKey
LANGFUSE_TRACING_ENVIRONMENT=company-test
```

`LANGFUSE_BASE_URL` 填服务根地址，不拼接 `/api/public`。地址由评标AI**后端所在位置**决定：

| 评标AI部署方式 | Langfuse地址 |
| --- | --- |
| 同机 Node 进程、本机测试 | `http://127.0.0.1:53000` |
| 同机 Docker 容器 | `http://host.docker.internal:53000`，并使 Web 监听容器可达的宿主机地址 |
| 不同服务器 | `http://Langfuse服务器内网IP:53000` 或 HTTPS 域名 |

容器内的 `127.0.0.1` 指容器自身。Linux 下 `host.docker.internal` 映射宿主机网关，本项目主 Compose 已配置 `host-gateway`；Langfuse若仅绑定宿主机回环地址，Linux容器仍无法访问。此时可将 Langfuse绑定宿主机网关可达地址，或在受防火墙保护的内网测试机上绑定 `0.0.0.0`，并限制来源。

Node 方式需重新启动评标AI后端；Docker 方式在仓库根目录运行下列命令，使新增环境变量进入容器（仅 restart 不会更新容器环境变量）：

```powershell
docker compose up -d --build --force-recreate app
```

重建会短暂中断应用，选择没有任务运行的时间执行。无需重启 Docker 服务，也无需重新导入知识库。

## 5. 验收与排查

1. 在评标AI发起一段含模型与工具调用的新对话，或者小批快速初评。
2. 在 Langfuse 的 Traces 中查找“评标AI执行”。根节点 metadata 带 runId、projectId、mode；Session 使用 conversation_id，可归集同一会话的多次执行。
3. 展开模型 generation，检查模型名称、输入/输出、耗时、Token 用量；展开工具节点，检查工具参数、结果及错误。自动恢复和上下文压缩也有事件记录。
4. 使用小任务验证成功后，再观察真实清单：区分检索耗时、模型耗时、重复工具和重试次数。SDK采用批量异步上报，页面不会逐 Token 同步显示，等当前调用结束及批次刷新后查看。
5. 若没有记录，先从评标AI后端所在网络检查地址可达性；确认已重启应用、Key属于同一个项目且没有混用模型Key；再查看评标AI日志与 Langfuse Web / Worker 日志。Web 能登录不代表 Worker 已正常消费。

本项目自动化测试覆盖 SDK 输出到本地模拟 OTLP 接收器、父子节点、并发隔离和密钥脱敏；这不等于已在你的服务器完成 Langfuse 入库验收，仍需执行上面的真实任务检查。

观测并不自动判断评标准确性，也未把独立的管理员概览生成、后台向量索引等所有进程一并纳入 Agent Trace。自定义模型的费用需在 Langfuse 补充对应价格，Token 用量不等于已准确计算费用。

## 6. 数据与回退

上报内容包含需求、提示词、证据和模型回答，适合部署在公司内网。代码对密钥做脱敏，但不保证自动清除所有个人信息。将 Langfuse项目访问权限限制为维护人员，并约定数据保留周期。

Compose使用独立命名卷持久化，不提供自动备份与高可用。长期部署应为 PostgreSQL、ClickHouse 和 MinIO 做一致性备份，并保管加密密钥；单独备份 PostgreSQL 不足以恢复全部观测数据。升级前备份、固定镜像版本，先在测试环境验证迁移。

如需停用，把评标AI根 `.env` 的 `LANGFUSE_ENABLED` 改为 `false` 并重新启动/创建 app。观测失败已隔离，不会作为评估失败条件。停止本目录服务使用：

```powershell
docker compose --env-file deploy/langfuse/.env -f deploy/langfuse/compose.yaml stop
```

不要执行 `down -v`，以免删除观测历史。该部署不会修改评标AI业务库或其他 Docker 项目。
