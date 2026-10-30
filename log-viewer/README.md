# Codex 日志查看器

独立的本机日志读取服务与 React Web Client，用于查看轨迹查看器生成的 `server`、`http`、`browser` JSONL 日志。代码、依赖清单、锁文件、构建产物与进程均位于本目录，不导入上级项目的 `server/` 或 `src/`，也不调用轨迹查看器 API。轨迹服务停止后，仍可独立查看已有日志。

## 开发与启动

需要 Node.js `^22.13.0` 或 `>=23.0.0`。

```sh
cd log-viewer
npm ci
npm run dev
```

开发页面为 `http://127.0.0.1:5174`，专用 API 服务为 `http://127.0.0.1:4318`。Vite 只代理到该日志服务；两个端口与轨迹查看器的 `5173` / `4317` 分开。开发端口被占用时直接报错。

```sh
npm run typecheck:server
npm test
npm run build
npm start
```

生产构建写入本目录的 `server-dist/`（TypeScript 服务端）和 `dist/`（JSX 页面）；`npm start` 在 `http://127.0.0.1:4318` 同时提供页面、资源与只读 API。也可以从仓库根运行 `npm --prefix log-viewer run build` 或 `npm --prefix log-viewer start`，无需构建、启动轨迹查看器。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `CTV_LOG_ROOT` | `~/.local/state/codex-trajectory-viewer/logs` | 由运维配置的唯一日志根；请求不能指定磁盘路径 |
| `CTV_LOG_VIEWER_PORT` | `4318` | 日志服务端口；Vite 代理读取同一变量 |

```sh
CTV_LOG_ROOT=/absolute/path/to/logs CTV_LOG_VIEWER_PORT=4328 npm start
```

两项配置仅作用于日志查看器，不改变轨迹查看器或其日志写入位置。

## 查看方式

- 侧栏按日期分组，可按日期、文件来源或实例 ID 查找日志。最多显示 500 个匹配文件，可继续筛选缩小范围。
- 支持最多 8 个文件标签。切换时保留筛选、分页、原文展开和滚动位置；关闭标签释放页面与请求。
- 每页最多 100 个物理行，支持前后页、首页、末页和原始行号定位。筛选支持级别、记录来源、原文字面查找，以及精确的 `operation_id` / `request_id`；文本区分大小写，最多 256 个字符。
- 点击记录中的操作或请求 ID，可在当前文件内筛选关联记录；查看其他来源时打开相应文件并使用相同 ID 筛选。
- 未知字段保留；每条记录摘要最多显示 24 个附加字段，其余可展开原始 JSON。损坏 JSON、非对象记录和空行均保留原始行号与原文。
- 记录内容只按文本展示，不执行 HTML、不自动加载链接或远程图片。复制失败时可展开原文手动复制。
- 「刷新日志」更新文件列表及已打开文件；「刷新此文件」更新当前文件并返回首页。不会自动轮询或追随新增记录。
- 页面分页使用服务端签名的快照版本。日志追加后仍可读取、筛选和下载旧边界；已有内容改写、截断或文件替换后返回 `409`，保留已显示内容并提示手动刷新。服务重启后旧版本需要刷新。
- 「下载快照文件」流式下载当前版本边界内的完整文件。单行预览最多 64 KiB，过长行显示提示，可下载查看完整原文；原文字面查找仍覆盖超长行的完整内容。因无法完整解析，超长行不参与级别及关联字段筛选。

## 本机部署

本目录可独立复制到同一台机器的其他位置：

```sh
cd /path/to/standalone-log-viewer
npm ci
npm run build
CTV_LOG_ROOT=/absolute/path/to/logs npm start
```

预构建部署只需本目录的 `package.json`、`package-lock.json`、`server-dist/` 和 `dist/`：

```sh
npm ci --omit=dev
CTV_LOG_ROOT=/absolute/path/to/logs npm start
```

预构建服务端仅使用 Node 内置模块，Web Client 依赖已打入静态文件。两种方式均无需上级仓库、上级 `node_modules`、轨迹服务或 Codex 数据目录。应以可读取日志的本机用户运行；服务固定绑定 `127.0.0.1`。本实现不提供公网监听、远程部署或日志上传。

## API 与读取边界

- `GET /api/logs` 返回文件列表和安全跳过计数。
- `GET /api/logs/:id` 读取分页；参数为 `limit`（1–100）、`afterLine`、`line`（正整数或 `last`）、`revision`、`level`、`source`、`q`、`operationId`、`requestId`。
- `GET /api/logs/:id/download?revision=...` 下载该版本的文件。

仅接受当前发现文件的不透明 ID；仅接受 `GET` 和本机 Host，不提供日志上报、编辑、删除或清理接口。日志根不存在时返回空列表，不创建目录。配置的根解析为真实目录，只发现其中真实 `YYYY-MM-DD` 日期目录内符合 `server|http|browser-<32位十六进制实例ID>-<分片号>.jsonl` 的文件；忽略 owner/active 侧车和未知文件，拒绝日期目录及日志文件的符号链接、硬链接及目录越界。打开使用只读句柄，源日志始终不修改。

单文件读取上限为 10 MiB，与现有写入器默认单片上限一致；超限返回 `413`。发现扫描最多处理 20,000 个目录项，超限返回 `503`，避免无界扫描。读取按块处理，单行预览、查询与页面条数均有上限；请求关闭后取消扫描或下载。筛选和版本校验会重新读取快照文件，较多文件并发阅读会增加本机 I/O。下载检查后源文件若再次改写，传输仍可能失败，不保证抵御正在发生的任意并发改写。

测试仅使用隔离合成日志和临时静态目录，覆盖原文件哈希不变、日期/路径/链接安全、坏行、中文/大行、筛选和分页、追加及版本冲突、下载取消、StrictMode、标签生命周期和错误状态。没有读取真实本机日志、Codex transcripts 或 SQLite 数据。
