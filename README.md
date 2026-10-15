# Codex 本地运行轨迹查看器

一个使用 React、Vite 和 Node.js 构建的本地只读查看器，可浏览 Codex rollout JSONL 中的会话消息、工具调用、工具结果及其他记录。

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

## 数据边界

- 服务只扫描 `CODEX_HOME/sessions` 与 `CODEX_HOME/archived_sessions` 下的 `.jsonl` 文件，不跟随符号链接。
- SQLite 仅尝试打开 `CODEX_SQLITE_HOME` 根目录中的 `state_5.sqlite`、`thread_history_1.sqlite` 和 `goals_1.sqlite`，并以 SQLite 原生只读模式访问。不会探测或打开日志、记忆、队列等其他数据库。
- SQLite 查询前先检查表和列。只读取 `threads`、`thread_turns`、`thread_items`、`thread_goals`；按会话 ID / 轮次 ID 参数化关联，schema 缺失或变更会以来源状态显示。
- SQLite 的会话标题、工作目录、模型、`tokens_used`、来源与更新时间补充到 JSONL 已发现的会话摘要中；归档状态以 rollout 所在目录为准。数据库缺失、损坏或无法匹配时继续展示 JSONL 数据。
- `thread_turns` 与 `thread_items` 通过 `historyPage` 参数每页读取 50 行，页面提供前后翻页；其他 SQLite 表每表最多返回 500 行。单行文本限制在 12,000 个字符。
- `GET /api/sessions` 返回发现到的会话摘要。`GET /api/sessions/:id` 只读取当前发现列表中对应的不透明 ID；客户端不能传入文件路径。
- 服务绑定 IPv4 回环地址 `127.0.0.1`。它不写入、复制或上传 Codex 会话数据，也不连接远程服务。
- 每一行单独解析。未知记录保留完整原始 JSON；无效 JSON 行保留原文并显示解析错误，不会中断整份会话。
- 查看器按记录时间戳排序；时间相同时按 JSONL 原始行序排列。无时间戳记录位于有时间戳记录之后，并保持原始行序。
- 这是手动刷新的只读快照，不提供实时跟随、统计图或跨会话对比。

## 仓库隐私

本机 Agent 指令和 Serena 记忆文件可能包含本地文件系统路径，因此由 `.gitignore` 排除，不纳入公开仓库。
