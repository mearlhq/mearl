# @mearl/daemon-core

[简体中文](README.md) | [English](README.en.md)

Mearl 各 Node 包共享的守护进程生命周期原语：进程存活探测、JSON 记录注册表、日志滚动，以及一个 detached 守护进程管理器。

把 `cloud-server`、`cloud-connector`、`native-host` 里原本各写一份、容易彼此漂移的 daemon 逻辑（`isAlive`、原子读写注册表、日志滚动、按 key 派生路径）收敛到这一处，确保「写方」和「读方」对**记录位置与格式**始终一致。

此包只在 Node 中运行，可以作为普通依赖使用，也可以由执行宿主打包内联。

## API

### 进程存活

```typescript
isAlive(pid: number | undefined | null): boolean
isProcessGroupAlive(group: number): boolean
```

用 signal-0 探测进程是否存活（`EPERM` 视为存活——进程存在但属于他人）。Linux 同时读取 `/proc/<pid>/stat`，将已退出、尚未回收的 zombie 和 dead 状态视为已停止；主线程退出但仍有其他线程时，以及无法读取状态时，保守视为存活。

POSIX 进程组检查包含根进程退出后仍存活的后代。Linux 只有在两次检查得到相同的已退出成员及创建身份时，才确认组内执行已停止；活跃后代、成员变化和权限或读取失败都会保留清理未确认状态。Windows 不使用 POSIX 进程组检查。

### 路径派生（多实例）

```typescript
DAEMON_HOME                                 // ~/.mearl
hashKey(key: string): string                // sha256(key) 前 16 位十六进制
keyedDir(subdir: string): string            // ~/.mearl/<subdir>
keyedConfigFile(subdir, key): string        // ~/.mearl/<subdir>/<hash>.json
keyedLogFile(subdir, key): string           // ~/.mearl/<subdir>/<hash>.log
```

多实例子系统（如按 `serverUrl` 区分的连接器）用这些 helper 派生每实例的文件路径。**所有读写方都必须经由它们派生路径**，这样彼此才不会对记录位置产生分歧。

### 记录注册表

```typescript
interface DaemonRecord { pid: number; startedAt?: string; [k: string]: unknown }

ensureDir(dir: string): void
writeRecord(file: string, record: DaemonRecord): void   // 跨进程加锁，临时文件 + rename 原子写
claimRecord(file: string, record: DaemonRecord): boolean // 仅在文件不存在时原子占用
readRecord<T>(file: string): T | null
removeRecord(file: string): void
removeRecordIfPid(file: string, pid: number): boolean   // 仅删除指定进程仍拥有的记录
writeRecordIfPid(file: string, pid: number, record: DaemonRecord): boolean
removeInvalidRecord(file: string): boolean              // 清理无法解析的残留记录
listRecordFiles(dir: string): string[]                  // 目录下所有 *.json 绝对路径
readLiveRecords<T>(dir: string): T[]                    // 读取存活记录，并顺带清理死记录
```

### 守护进程管理器

```typescript
createDaemon(opts: CreateDaemonOptions): Daemon
```

围绕一对 `(configFile, logFile)` 构建单实例守护进程管理器。`start()` 先原子占用启动锁，
再以 `--foreground` detached 方式拉起消费方 CLI，并立即写入带子进程 pid 的 `starting`
记录。子进程就绪后覆盖该记录，父进程据此确认启动完成。并发 `start()` 会复用正在启动或
已经运行的子进程。多实例子系统按实例 key 派生各自的 `configFile` / `logFile`。

```typescript
interface CreateDaemonOptions {
  name: string;            // 日志标签，如 'CloudServer' / 'CloudConnector'
  scriptPath: string;      // 可重新拉起的 CLI 脚本绝对路径（消费方打包后的 cli.js）
  configFile: string;      // 本实例的 JSON 记录文件（由前台子进程写入）
  logFile: string;         // 本实例的日志文件
  foregroundArgs?: string[];   // 追加在 `--foreground` 之后的 argv
  readyTimeoutMs?: number;     // 等待子进程写记录的超时（默认 15000ms）
  formatInfo?: (record: DaemonRecord) => string | null;  // 起来后额外打印的信息
  startingRecord?: (pid: number, startedAt: string) => DaemonRecord;
}

interface Daemon {
  start(): Promise<void>;
  stop(expectedPid?: number): Promise<void>; // 指定 PID 时仅停止仍匹配的实例
  restart(): Promise<void>;
  status(): void;
  logs(lines?: number): void;
  running(): DaemonRecord | null;
}
```

> `scriptPath` 必须是消费方自己的 `cli.js`：用打包进 cli 入口的某个模块里的 `fileURLToPath(import.meta.url)` 计算。daemon-core 自身被独立解析时，它的 `import.meta.url` 指向 daemon-core，而不是 cli。

### 日志

```typescript
rotateLogIfNeeded(logFile: string, maxBytes?: number): void  // 超限则滚动为 <log>.1，默认 5MB
tailFile(logFile: string, lines: number): string
```

## 使用方

- **cloud-server** —— `createDaemon`（单实例，`~/.mearl/cloud-server.json`）
- **cloud-connector** —— `createDaemon`（多实例，按 `serverUrl` 区分，`~/.mearl/connectors/<hash>.json`）+ `readLiveRecords` 列举
- **native-host** —— 仅用原语（`isAlive` / `keyedConfigFile` / `readRecord` / `readLiveRecords` 等）读取连接器共享注册表，以发现/接管/列举连接器


`@mearl/daemon-core/capabilities` 的 `NodeCapabilityRegistry` 可在第三个构造参数传入 `hooks`，只加载这些绑定引用的模块。选择本身仍完整校验，目标模块字节按摘要验证，提交仍核对当前选择；忽略的模块不执行。该局部实例适用于安装 CLI 等只需要少量本机服务的宿主，不替代完整 Native Host 的激活与就绪回执。省略 `hooks` 时保持完整加载。
