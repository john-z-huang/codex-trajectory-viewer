# Codex 本地运行轨迹查看器

一个使用 React、Vite 和 Node.js 构建的本地只读查看器，用于浏览 Codex rollout JSONL 会话轨迹，并查看 SQLite 提供的会话元数据、分页历史和目标信息。

## 功能

- 发现活动与归档 JSONL 会话；按工作目录完整路径分组，支持搜索项目和会话。优先使用 SQLite `threads.cwd`，缺失时回退到 rollout `session_meta.cwd`；没有工作目录的会话归入“项目未知”。
- 显示子代理身份、父会话和执行状态；子代理可作为独立会话打开。Guardian 会话单独标识，不按子代理处理。
- 侧栏与会话详情独立滚动。每个会话在应用内只保留一个标签；再次从侧栏或会话详情打开时激活已有标签。已打开面板持续挂载，切换后保留会话内容与阅读位置，关闭标签后释放对应面板资源。
- 每个会话内提供「JSONL 轨迹 / SQLite 历史」来源标签，默认展示 JSONL；切换后保留两侧分页、搜索、展开状态和各自阅读位置，支持方向键与 Home/End 切换。
- SQLite 历史按用户消息、助手回复、推理、命令、文件变更和工具结果分类展示，并提供轮次、线程及目标摘要。未知类型和损坏内容保留可读提示与完整原始行入口。
- 按 JSONL 原始行序展示消息、工具调用、工具结果、未知事件和损坏行。用户/助手正文及已识别的工具文本项支持 Markdown；原始 JSON 和命令输出仍以纯文本呈现。
- 时间线和侧栏只挂载可见窗口。会话按 32 个物理行分页，支持首尾定位、原始行号跳转及区分大小写的原文查找；跨页保留折叠和阅读状态。
- 原始 JSON 展开后才读取当前片段，关闭后释放；超长内容可分段阅读或下载完整原文。“复制对话”保持完整可读文本，超长记录仅在点击复制时临时读取和渲染。
- Markdown 渲染禁用原始 HTML，过滤危险链接协议，图片只显示替代文本，不自动请求远程图片。
- 页面首次打开时读取本地快照，此后新内容仅通过手动点击「刷新」加载。翻页、查找、原文读取和复制遇到版本变化只提示刷新，并保留已显示内容。

## 开发

需要 Node.js `^22.13.0` 或 `>=23.0.0`（内置只读 SQLite reader 与 Vite 8 的运行要求）。

服务端使用锁定版本的 TypeScript 6.x 编译为 Node ESM；React/Vite 展示端保持 JavaScript/JSX。服务端类型检查范围只覆盖 `server/`，构建产物放在 `server-dist/`，与前端 `dist/` 分开。

```sh
npm install
npm run dev
```

开发模式下，Vite 页面和 API 服务分别监听 `127.0.0.1`，浏览器访问 <http://127.0.0.1:5173>。API 服务默认端口为 `4317`，可用 `PORT` 覆盖。

```sh
npm run typecheck:server
npm test
npm run build
npm start
```

构建后，`npm start` 在 `http://127.0.0.1:4317` 同时提供静态页面与 API。可通过 `CODEX_HOME=/path/to/codex-home` 指定 rollout 数据目录；未设置时使用 `~/.codex`。SQLite 默认从同一目录读取，也可用 `CODEX_SQLITE_HOME=/path/to/sqlite-home` 单独指定。

## HTTP API

- `GET /api/sessions` 返回从允许的会话目录发现并补充 SQLite 元数据的会话摘要。
- `GET /api/sessions/:id` 返回已发现会话的详情、JSONL 原文、SQLite 补充数据和关联子代理。`:id` 是不透明会话 ID，不接受文件路径。
- `GET /api/sessions/:id?view=history&historyPage=1&supplementRevision=...` 只返回 SQLite 补充数据，不读取或返回完整 JSONL。正式页面携带窗口返回的 `supplementRevision`，数据库或 WAL 变化时返回 `409`，需手动刷新；省略版本参数保留旧 API 兼容。`historyPage` 默认第 1 页，每页 50 条；兼容详情接口也接受该参数。
- `GET /api/sessions/:id?view=window&line=1` 返回会话元数据、SQLite 补充数据、子代理摘要，以及包含目标行的 32 行窗口。响应中的 `rollout` 提供版本 `revision`、总行数和当前行范围；超长行保留定位信息，原文另行读取。
- `GET /api/sessions/:id?view=page&revision=...&line=33` 只返回该版本的行窗口。每行最多返回 64 KiB 原始 UTF-8 内容，超限行通过原文接口访问；JSON 转义后的响应字节数可能更大。
- `GET /api/sessions/:id?view=raw&revision=...&line=1&offset=0` 返回最多 16 KiB、保持 UTF-8 字符完整的原文片段。`offset` 是行内字节偏移，后续请求使用响应的 `nextOffset`；`view=download&revision=...&line=1` 流式下载完整单行原文。
- `GET /api/sessions/:id?view=search&revision=...&q=...&afterLine=0` 在原始行中进行区分大小写的字面量查找，返回下一条匹配行号；查询最多 256 个 UTF-16 code units，不跨行匹配。

分页、原文和查找接口都只接受已发现会话的 ID。文件追加、截断、重写或替换使旧版本失效，接口返回 `409`；客户端保留当前已加载内容，等待用户点击「刷新」，不自动获取新窗口。SQLite 版本按整个允许列表中的数据库及 WAL 文件身份校验，其他会话写入也可能要求刷新。索引在服务端内存中按需构建，不写入 Codex 数据目录。

正式页面使用窗口接口；旧完整详情接口保留兼容。每个标签的展示页缓存最多保留 4 页、4 MiB 序列化 UTF-8 数据，被淘汰的页可重新读取。该预算不等于浏览器总堆上限；已打开标签的元数据和阅读状态仍会保留，显式完整复制也会产生临时占用。详情、翻页、查找、原文片段和复制请求共享最多 2 个并发请求，刷新优先处理活动标签并覆盖全部已打开标签。完整原文下载由浏览器直接处理。

## 数据边界

- 服务只扫描 `CODEX_HOME/sessions` 与 `CODEX_HOME/archived_sessions` 下的 `.jsonl` 文件，不跟随符号链接。
- SQLite 仅尝试打开 `CODEX_SQLITE_HOME` 根目录中的 `state_5.sqlite`、`thread_history_1.sqlite` 和 `goals_1.sqlite`，并以 SQLite 原生只读模式访问。不会探测或打开日志、记忆、队列等其他数据库。
- SQLite 查询前先检查表和列。只读取 `threads`、`thread_turns`、`thread_items`、`thread_goals`；按会话 ID / 轮次 ID 参数化关联，schema 缺失或变更会以来源状态显示。
- SQLite 的会话标题、工作目录、模型、`tokens_used`、来源与更新时间补充到 JSONL 已发现的会话摘要中；归档状态以 rollout 所在目录为准。数据库缺失、损坏或无法匹配时继续展示 JSONL 数据。
- `thread_turns` 与 `thread_items` 通过 `historyPage` 参数每页读取 50 行，页面提供前后翻页；其他 SQLite 表每表最多返回 500 行。SQLite 正文和原始行按最多 8,000 个 UTF-16 代码单元分段，原始行仅在展开后序列化，完整内容均可访问。只有已识别的消息正文和工具文本使用安全 Markdown，命令、参数、diff 和未知结构保持纯文本。
- 服务绑定 IPv4 回环地址 `127.0.0.1`。它不写入、复制或上传 Codex 会话数据，也不连接远程服务。
- 每一行单独解析。未知记录保留完整原始 JSON；无效 JSON 行保留原文并显示解析错误，不会中断整份会话。
- 查看器保持 JSONL 物理行序，不按时间戳重排；空行、无时间戳记录及损坏行均可按原始行号定位。复杂或超长记录的预览可以降级为说明，完整原文仍可访问。

## 主要目录结构

```text
src/
  main.jsx                     前端入口
  components/                  侧栏、工作区、标签面板、详情和内容展示
  hooks/useSessionDetail.js    有界轨迹页、手动刷新、查找与历史分页状态
  hooks/useVirtualWindow.js    动态高度窗口、滚动定位与测量清理
  lib/                         Rollout 解析、项目分组、会话身份、标签及 Markdown 处理
  styles/                      按界面职责拆分的样式
  style.css                    样式模块入口
server/
  index.ts                     本地 HTTP 服务组合与启动
  session-discovery.ts         会话发现与摘要
  session-api.ts               会话列表和详情 API
  rollout-reader.ts            有界行窗口、稀疏索引、版本校验、原文与查找
  static-files.ts              生产静态文件服务
  sqlite-reader.ts             只读 SQLite 读取
  subagents.ts                 子代理识别与关联
  types.ts                     服务端输入、会话和响应类型
test/                            使用隔离合成数据的 Node 内置测试
```

## 仓库文档与本地记忆

`AGENTS.md` 是面向仓库贡献者的项目开发指引，可随项目代码公开。`.serena/` 保存本地 Serena 项目状态与记忆，可能包含本机路径和维护记录，由 `.gitignore` 排除。
