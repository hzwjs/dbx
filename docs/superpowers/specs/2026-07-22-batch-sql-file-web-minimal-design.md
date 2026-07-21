# Web 批量执行 SQL 文件最小迁移设计

## 背景与结论

DBX 桌面端已经支持把同一个 SQL 文件按顺序执行到多个同类型连接。Web 端已有上传预览、单目标后台执行、SSE 进度、取消和 200 MiB 文件限制，但 UI 仍只能选择一个目标。

本次只迁移桌面端的“多目标批量执行”能力。Web 服务端负责批次编排和内存任务状态，按用户提交的真实连接 ID 串行调用现有 SQL 文件执行逻辑；不建设临时连接、连接租约或通用任务平台。

## 使用背景

- 现阶段用于小团队内网协作，团队成员彼此完全信任。
- 所有已登录用户等同管理员，可查看和取消全部 Web 批次任务。
- 任务只保存在 `dbx-web` 进程内存中：浏览器刷新或关闭后仍存在，`dbx-web` 重启后清空。

## 目标

1. Web SQL 文件执行对话框可选择多个同类型 SQL 数据库连接。
2. 一个批次内按目标列表顺序严格串行执行；一个目标结束后才开始下一个目标。
3. 不同批次可以并发运行。
4. 复用现有 SQL 文件解析、执行、进度、只读保护和 200 MiB 限制语义。
5. 展示每个目标的进度、成功数、失败数、影响行数、耗时、当前语句和错误明细，状态与桌面端一致。
6. 取消批次时取消当前目标，并把尚未开始的目标标记为 `skipped`。
7. 所有登录用户可在现有 SQL 文件对话框中查看进程内的共享批次，并在刷新后重新连接进度。
8. 保持现有 Web 单目标 API 和桌面端行为兼容。

## 非目标

- 不修改 `crates/dbx-core`、数据库驱动、Agent、JDBC、SSH 隧道或连接生命周期架构。
- 不创建临时连接配置、Scoped Connection Lease、配置快照或驱动版本快照。
- 不增加持久化、Redis、消息队列、RBAC、审计、重试、回滚、删除或保留期管理。
- 不增加跨接口查询取消所有权、驱动变更锁或新的全局内存准入管理器。
- 不建设独立任务中心；共享批次只在现有 SQL 文件对话框内管理。
- 不改变桌面端的本地批次编排方式。

## 方案比较与决策

### 方案 A：浏览器继续逐目标调用现有单目标 API

改动最少，但关闭或刷新浏览器会丢失编排，无法满足共享任务和后台继续执行。

### 方案 B：Web 服务端最小批次编排（采用）

在 `dbx-web` 增加内存注册表和批次接口，服务端对真实连接 ID 串行调用现有执行逻辑。它满足刷新恢复和团队共享，同时把改动限制在 Web 层。

### 方案 C：Core 通用连接租约与任务平台

可以冻结连接配置并扩展到更多任务类型，但需要修改多种驱动和连接生命周期，明显超出桌面能力迁移范围，因此排除。

## 架构边界

```text
Web SQL 文件对话框
  ├─ 上传/预览：继续使用 POST /api/sql-file/preview
  ├─ 提交批次：POST /api/sql-file/batches
  ├─ 恢复列表：GET  /api/sql-file/batches
  ├─ 查看快照：GET  /api/sql-file/batches/{batchId}
  ├─ 订阅更新：GET  /api/sql-file/batches/{batchId}/events
  └─ 取消批次：POST /api/sql-file/batches/{batchId}/cancel
                         │
                         ▼
dbx-web 内存批次注册表
  └─ 每个批次一个后台 worker
       └─ 按提交顺序遍历真实 connection_id
            └─ 复用现有 Web SQL 文件单目标执行辅助逻辑
                 └─ dbx_core::sql_file_import::execute_sql_file_content
```

只允许在 `crates/dbx-web` 中抽取一个共享辅助函数，让原单目标路由和新批次 worker 共同使用相同的文件校验、解码和执行代码。该抽取不得改变原单目标接口的 URL、请求、响应和进度语义。

## 服务端模型

### 批次状态

```text
running -> cancelling -> cancelled
running ----------------> completed
```

- `running`：批次已接收，存在待执行或正在执行的目标。
- `cancelling`：已收到取消请求，正在等待当前目标结束取消流程。
- `cancelled`：当前目标已取消或结束，所有待执行目标已跳过。
- `completed`：所有目标都已到达终态；允许其中存在 `failed` 或 `partial`。

### 目标状态

沿用桌面端状态：`pending | running | success | partial | failed | cancelled | skipped`。

- 收到现有执行器的 `done` 且失败数为 0：`success`。
- 收到 `done` 且失败数大于 0：`partial`。
- 连接准备、只读保护、文件读取或执行发生终止性错误：`failed`，随后继续下一个目标。
- 当前执行器确认取消：`cancelled`。
- 批次取消时尚未开始：`skipped`。

每个目标保留 `connectionId` 和独立 `executionId`，并累计桌面端已有的语句失败明细。

### 注册表

注册表只属于 `WebState`，包含批次快照、批次取消令牌和广播通道。访问者不按用户隔离。列表按创建时间倒序返回进程内全部批次，不做删除和自动清理；服务重启自然清空。

worker 执行数据库 I/O 时不得持有注册表写锁。每次状态变化先短暂更新快照，再广播完整批次快照，避免前端自行合并部分事件产生分歧。

## API 契约

### 创建批次

`POST /api/sql-file/batches`

```json
{
  "connectionIds": ["connection-a", "connection-b"],
  "database": "app_db",
  "filePath": "/server/data/tmp/install.sql",
  "continueOnError": true
}
```

服务端生成 `batchId` 和每个目标的 `executionId`，校验连接列表非空且没有重复项，并复用现有上传目录路径校验。响应为初始完整快照。

目标连接使用提交时的已保存真实连接 ID。执行到某个目标时，现有连接配置或驱动若已被修改，该目标允许失败；首版不冻结配置，也不阻止管理员修改配置。

完整快照固定为以下 camelCase 结构；列表、详情和 SSE 都使用同一结构：

```ts
interface SqlFileBatchSnapshot {
  batchId: string;
  fileName: string;
  database: string;
  continueOnError: boolean;
  status: "running" | "cancelling" | "completed" | "cancelled";
  createdAtMs: number;
  updatedAtMs: number;
  targets: SqlFileBatchTarget[];
  summary: {
    success: number;
    partial: number;
    failed: number;
    cancelled: number;
    skipped: number;
  };
}

interface SqlFileBatchTarget {
  connectionId: string;
  executionId: string;
  status: "pending" | "running" | "success" | "partial" | "failed" | "cancelled" | "skipped";
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
  elapsedMs: number;
  statementSummary: string;
  error: string;
  failures: Array<{
    statementIndex: number;
    statementSummary: string;
    error: string;
  }>;
}
```

### 查询与订阅

- `GET /api/sql-file/batches` 返回完整快照数组。
- `GET /api/sql-file/batches/{batchId}` 返回指定完整快照；不存在时返回现有 `AppError` 风格错误。
- `GET /api/sql-file/batches/{batchId}/events` 建立 SSE，连接后先发送当前完整快照，后续每次变化再次发送完整快照。前端断线后通过 GET 快照再重连，不依赖事件补发。

### 取消

`POST /api/sql-file/batches/{batchId}/cancel`

```json
{ "cancelled": true }
```

首次对运行中批次取消返回 `true`。不存在、已经终态或已经请求取消时返回 `false`。取消令牌同时供批次循环和当前单目标执行器观察；取消后不得启动新目标。

所有接口继续使用现有 Web 登录中间件，不增加新的权限模型。

## 执行流程

1. 前端沿用现有上传预览，获得服务端 `filePath`、文件名和预览内容。
2. 前端以一个基准连接限制候选项为同一 `db_type`，与桌面端选择规则一致。
3. 前端根据提交时连接配置逐个完成现有生产环境确认；任一确认被拒绝则不提交批次。
4. 服务端创建初始快照并立即返回，然后启动后台 worker。
5. worker 按目标顺序把目标置为 `running`，使用真实连接 ID 构造现有 `SqlFileRequest` 并调用共享单目标辅助逻辑。
6. 现有 `SqlFileProgress` 被映射到目标状态；每次更新广播完整批次快照。
7. 单个目标失败不终止批次；`continueOnError` 只控制该目标内部遇到语句错误后是否继续，语义不变。
8. 所有目标结束后批次进入 `completed`；取消流程结束后进入 `cancelled`。

## 前端行为

- Web 模式把现有单选连接控件切换为与桌面端相同的同类型多选交互；桌面模式仍使用现有 `useSqlFileBatchExecution`。
- Web 模式使用独立、轻量的 HTTP 批次客户端/组合函数，不把服务端编排塞进桌面端组合函数。
- Web 模式复用现有批次进度、汇总和目标详情 UI，不新增页面。
- 打开对话框时加载共享批次列表，并订阅当前选中批次；新建批次后自动选中它。
- 有多个批次时，在对话框内提供紧凑的批次选择器。关闭对话框不取消任务；重新打开或刷新页面后可从列表恢复。
- 不要求把服务端共享批次持久化到现有浏览器内存 `useExportTracker`；SQL 文件对话框是首版的权威查看和取消入口。

## 并发、错误与资源语义

- 同批次严格串行；不同批次通过独立 worker 并发。
- 每个 worker 同一时刻最多执行一个目标，沿用现有单目标 200 MiB 文件上限。
- 首版不增加跨批次内存总量限制；小团队需要自行控制并发批次数。
- SSE 接收者滞后或暂时离线不影响 worker；客户端通过完整快照恢复。
- 元数据刷新仍由前端在看到目标 `success` 或 `partial` 后尽力触发，刷新失败不改写终态。
- Web 服务重启导致全部任务和状态丢失，这是明确接受的首版限制。

## 测试与验收

### 服务端

1. 两个目标的开始顺序严格为 A 结束后 B 开始。
2. A 失败后 B 仍会执行。
3. `continueOnError` 原样传入每个 `SqlFileRequest`。
4. 取消当前目标后，其余 `pending` 目标全部为 `skipped`，且不再调用执行器。
5. 两个批次可以同时进入运行态，彼此取消令牌互不影响。
6. 列表、详情和 SSE 向不同登录会话返回相同共享快照。
7. 未登录请求仍被现有认证中间件拒绝。
8. 原单目标路由测试继续通过。

### 前端

1. Web 可选择多个同类型目标，不能混入不同类型连接。
2. 创建请求保留目标顺序、数据库和 `continueOnError`。
3. 目标进度、失败明细和汇总与服务端完整快照一致。
4. 对话框关闭重开和页面刷新后能从列表恢复运行中批次并重连 SSE。
5. 取消调用批次取消接口，不再逐目标从浏览器编排。
6. 桌面端仍使用现有本地批次组合函数，原 39 项相关测试保持通过。

### 范围验收

- `git diff custom/main...HEAD -- crates/dbx-core` 必须为空。
- 不得新增临时连接、Scoped Lease、驱动锁、持久化任务表或外部基础设施依赖。
- 现有 `/api/sql-file/execute`、`/progress/{executionId}`、`/cancel` 接口保持兼容。
- 新增代码应集中在 Web 批次路由/状态、Web HTTP 客户端/组合函数、现有对话框适配和对应测试，不做无关重构。
