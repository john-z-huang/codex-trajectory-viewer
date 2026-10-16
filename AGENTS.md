# 项目开发指引

## 项目目标与技术栈

- 本项目是 Codex 本地运行轨迹查看器：React + Vite 前端和 Node.js 本地 HTTP 服务，使用 JavaScript / JSX（ES modules）。
- JSONL rollout 是会话轨迹的规范来源；SQLite 仅提供线程元数据、分页历史与关联目标等补充信息。
- 服务仅绑定本机回环地址。会话数据不上传、不复制到远端，也不依赖远程服务。
- 项目分组按会话 cwd 的完整路径字符串进行。优先使用 SQLite `threads.cwd`，缺失时回退到 JSONL `session_meta.cwd`；无 cwd 的会话归入“项目未知”。同名目录必须能通过完整路径区分。只能使用记录中已有的路径字符串，不扫描项目目录、不读取 CODEX_HOME 以外的数据，也不通过 Git remote 推断项目。

## 项目结构与模块职责

```text
src/
  main.jsx                     浏览器入口与根组件挂载
  components/
    SessionViewer.jsx          会话列表状态、搜索、刷新与页面组合
    SessionSidebar.jsx          项目分组和会话侧栏
    SessionWorkspace.jsx       工作区、会话标签和持续挂载的标签面板
    SessionPanel.jsx            单个标签的详情加载状态与详情视图连接
    SessionDetail.jsx           会话元数据、子代理、时间线和 SQLite 补充区
    Timeline.jsx                Rollout 时间线展示
    SqliteSupplement.jsx        SQLite 来源状态、表格和历史分页控件
    MarkdownContent.jsx         Markdown 安全渲染
  hooks/
    useSessionDetail.js         会话详情读取与 SQLite 历史分页状态
  lib/
    formatters.js               日期和子代理状态文案
    markdown-components.js      Markdown 渲染节点
    markdown-content.js         Rollout/MCP 文本项的 Markdown 判定
    projects.js                 按完整 cwd 分组、排序和搜索会话
    rollout.js                  JSONL 逐行解析及时间线模型
    session-identity.js         子代理身份归一化、标题和会话类型
    session-tabs.js             会话标签状态转换
  styles/
    *.css                       按基础、导航、工作区、时间线、SQLite、项目、
                                Markdown、布局、标签和响应式职责拆分的样式
  style.css                     样式模块入口；导入顺序影响 CSS 级联
server/
  index.js                      本地 HTTP 服务组合、启动及公开导出
  session-discovery.js          rollout 发现、摘要和会话身份元数据
  session-api.js                会话列表/详情 API 及响应组装
  static-files.js               生产构建静态文件服务
  sqlite-reader.js               只读 SQLite 元数据、历史和目标读取
  subagents.js                   子代理发现、关联和活动状态
test/                            Node 内置测试；数据必须来自隔离的合成 fixtures
```

- 新增或修改 UI 时优先放入对应组件；跨组件的详情/分页状态放在 hook，纯数据处理放在 `src/lib/`。
- `server/index.js` 负责依赖组合和本地服务启动；路由数据处理、rollout 发现与静态文件服务分别维护在独立模块中。保持 `createAppServer`、`discoverSessions` 的现有导出。
- CSS 从 `src/style.css` 统一导入。拆分或调整导入时须保留既有选择器、声明与级联结果。

## CODEX_HOME 只读红线

- 只能读取并展示 Codex 执行记录；绝不修改任何已有记录。
- 严禁对 `CODEX_HOME` 下任何文件执行写入、追加、删除、截断、重命名、移动、替换或迁移，包括 JSONL、SQLite 数据库及 SQLite 伴随文件。
- SQLite 必须以只读模式打开。禁止运行 Codex migrations，禁止写事务、建表、修复、压缩、checkpoint 或其他可能改变数据库及伴随文件的操作。
- 服务只从配置的 `CODEX_HOME` 会话目录发现 JSONL（`sessions`、`archived_sessions`），并只打开明确列出的数据库：`state_5.sqlite`、`thread_history_1.sqlite`、`goals_1.sqlite`。不要按扩展名扫描数据库；首版不要读取日志、记忆和队列库。
- SQLite 文件位置来自 `CODEX_SQLITE_HOME`（未设置时使用 `CODEX_HOME`），不得由请求参数指定路径。会话详情只接受当前发现列表中的不透明 ID，不提供任意文件读取接口。
- 缺少数据库、表、字段或遇到 schema 漂移时应返回可读状态并优雅降级，不能因此阻断可用的 JSONL 轨迹。
- 测试只能使用隔离的合成 JSONL / SQLite fixtures。不得读取真实本机 Codex transcripts 或数据库 rows；验证只读行为时比较合成文件读取前后的内容或哈希。

## Rollout 解析要求

- 每行独立解析，保留原始顺序及原始 JSON。未知事件和损坏行应显示为可读记录/告警，不得丢弃或中断整份会话。
- 兼容 Codex rollout 中 `event_msg` 的 keyed event 和 `payload.type` discriminator 结构。
- SQLite `thread_history_1.sqlite` 是分页历史投影，不替代 JSONL 规范轨迹。关联依赖已发现会话的 thread/session ID；历史通过 `thread_id`、`turn_id` 关联。
- 缺少或无法识别的字段不应触发修复真实数据库的尝试。
- user/assistant 正文以及工具结果中已识别的文本项可以按 CommonMark 渲染。工具结果若为 JSON 内容列表，按原顺序抽取文本对象的 `text`；图像、音频、加密、未知项及非文本结构保留纯文本/原始 JSON 视图。
- MCP `result.content` 的文本项适用相同规则。不要把工具调用参数、shell stdout/stderr、元数据或整个 JSON 对象自动当作 Markdown；原始 JSON 始终保留为纯文本查看。
- Markdown 使用 React 节点渲染，禁用原始 HTML；链接须过滤脚本类和 `data:` 等危险协议。Markdown 图片只显示替代文本，不自动请求外部资源。新增解析和渲染验收使用合成数据。

## 本地开发与验证

- Node.js 版本要求见 `package.json` 的 `engines`；依赖安装后可运行 `npm run dev`，本地 API 和 Vite 均绑定回环地址。
- `npm test` 运行 Node 内置测试；`npm run build` 生成生产前端；`npm start` 启动生产服务。
- 涉及行为或界面变更时，增加/调整隔离合成数据覆盖对应需求，再运行相关测试和生产构建。不得为测试方便而接入真实 CODEX_HOME。
- 保持 API/前端本地数据流，不引入上传或遥测会话内容的能力。
