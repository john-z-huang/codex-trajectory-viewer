# Codex 本地运行轨迹查看器

一个使用 React、Vite 和 Node.js 构建的本地只读查看器，用于浏览 Codex rollout JSONL 会话轨迹，并查看 SQLite 提供的会话元数据、分页历史和目标信息。

## 功能

- 发现活动与归档 JSONL 会话；按工作目录完整路径分组，支持搜索项目和会话。优先使用 SQLite `threads.cwd`，缺失时回退到 rollout `session_meta.cwd`；没有工作目录的会话归入“项目未知”。
- 显示子代理身份、父会话和执行状态；子代理可作为独立会话打开。Guardian 会话单独标识，不按子代理处理。
- 侧栏与会话详情独立滚动。可同时打开多个应用内会话标签；各标签面板持续挂载，切换后保留各自的会话内容与阅读位置。
- 按时间顺序展示消息、工具调用、工具结果、未知事件和损坏行。用户/助手正文及已识别的工具文本项支持 Markdown；原始 JSON 和命令输出仍以纯文本呈现。
- Markdown 渲染禁用原始 HTML，过滤危险链接协议，图片只显示替代文本，不自动请求远程图片。
- 页面通过手动刷新读取本地快照，不提供实时跟随、统计图或跨会话对比。

## 开发

需要 Node.js `^22.13.0` 或 `>=23.0.0`（内置只读 SQLite reader 与 Vite 8 的运行要求）。

```sh
npm install
npm run dev
```

开发模式下，Vite 页面和 API 服务分别监听 `127.0.0.1`，浏览器访问 <http://127.0.0.1:5173>。API 服务默认端口为 `4317`，可用 `PORT` 覆盖。

```sh
npm test
npm run build
npm start
```

构建后，`npm start` 在 `http://127.0.0.1:4317` 同时提供静态页面与 API。可通过 `CODEX_HOME=/path/to/codex-home` 指定 rollout 数据目录；未设置时使用 `~/.codex`。SQLite 默认从同一目录读取，也可用 `CODEX_SQLITE_HOME=/path/to/sqlite-home` 单独指定。

## HTTP API

- `GET /api/sessions` 返回从允许的会话目录发现并补充 SQLite 元数据的会话摘要。
- `GET /api/sessions/:id` 返回已发现会话的详情、JSONL 原文、SQLite 补充数据和关联子代理。`:id` 是不透明会话 ID，不接受文件路径。
- 可选查询参数 `historyPage` 指定 SQLite 历史页，默认第 1 页，每页 50 条。翻页仍使用会话详情接口。

## 数据边界

- 服务只扫描 `CODEX_HOME/sessions` 与 `CODEX_HOME/archived_sessions` 下的 `.jsonl` 文件，不跟随符号链接。
- SQLite 仅尝试打开 `CODEX_SQLITE_HOME` 根目录中的 `state_5.sqlite`、`thread_history_1.sqlite` 和 `goals_1.sqlite`，并以 SQLite 原生只读模式访问。不会探测或打开日志、记忆、队列等其他数据库。
- SQLite 查询前先检查表和列。只读取 `threads`、`thread_turns`、`thread_items`、`thread_goals`；按会话 ID / 轮次 ID 参数化关联，schema 缺失或变更会以来源状态显示。
- SQLite 的会话标题、工作目录、模型、`tokens_used`、来源与更新时间补充到 JSONL 已发现的会话摘要中；归档状态以 rollout 所在目录为准。数据库缺失、损坏或无法匹配时继续展示 JSONL 数据。
- `thread_turns` 与 `thread_items` 通过 `historyPage` 参数每页读取 50 行，页面提供前后翻页；其他 SQLite 表每表最多返回 500 行。单行文本限制在 12,000 个字符。
- 服务绑定 IPv4 回环地址 `127.0.0.1`。它不写入、复制或上传 Codex 会话数据，也不连接远程服务。
- 每一行单独解析。未知记录保留完整原始 JSON；无效 JSON 行保留原文并显示解析错误，不会中断整份会话。
- 查看器按记录时间戳排序；时间相同时按 JSONL 原始行序排列。无时间戳记录位于有时间戳记录之后，并保持原始行序。

## 主要目录结构

```text
src/
  main.jsx                     前端入口
  components/                  侧栏、工作区、标签面板、详情和内容展示
  hooks/useSessionDetail.js    会话详情读取与历史分页状态
  lib/                         Rollout 解析、项目分组、会话身份、标签及 Markdown 处理
  styles/                      按界面职责拆分的样式
  style.css                    样式模块入口
server/
  index.js                     本地 HTTP 服务组合与启动
  session-discovery.js         会话发现与摘要
  session-api.js               会话列表和详情 API
  static-files.js               生产静态文件服务
  sqlite-reader.js              只读 SQLite 读取
  subagents.js                  子代理识别与关联
test/                            使用隔离合成数据的 Node 内置测试
```

## 仓库文档与本地记忆

`AGENTS.md` 是面向仓库贡献者的项目开发指引，可随项目代码公开。`.serena/` 保存本地 Serena 项目状态与记忆，可能包含本机路径和维护记录，由 `.gitignore` 排除。
