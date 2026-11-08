import { pluginRecoverySignature } from '../sdk/pluginRecoveryDefinition.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PluginError } from '../pluginRegistry.js';
import type { PluginOptions, PluginApp } from '../sdk/plugin.js';
import type { PluginCommandContext } from './pluginExecution.js';
import { pluginExecutionError, serializePluginExecutionError } from './pluginExecutorProtocol.js';
import type { PluginExecutionError } from '@mearl/browser-core';

export interface PythonPluginCommand {
  description: string;
  signature: string;
  toolboxOnly: boolean;
  runtimeOnly: boolean;
  recoveryOnly: boolean;
  migrationOnly: boolean;
}

export interface PythonPluginDescriptor {
  commands: PythonPluginCommand[];
  description?: string;
  name?: string;
  toolbox?: unknown;
  pageRuntime?: unknown;
  appProfiles?: unknown;
  stateStorage?: unknown;
  taskRecovery?: unknown;
}

export interface PythonPluginApp {
  state?: PluginApp['state'];
  model?: PluginApp['model'];
  checkpoint?: PluginApp['checkpoint'];
  page?: PluginApp['page'];
  readonly options: Readonly<PluginOptions>;
  invoke(action: string, payload?: Record<string, any>, options?: PluginOptions): Promise<any>;
  progress(message: string): void;
}

interface PythonWorkerMessage {
  [key: string]: unknown;
  type: string;
}

const STDERR_LIMIT = 64 * 1024;

// Bootstrap 随 Node client 分发，Python 插件无需额外安装宿主 SDK。
const PYTHON_BOOTSTRAP = String.raw`
import asyncio
import importlib.util
import inspect
import json
import os
import signal
import sys
from types import MappingProxyType

_protocol_output = sys.stdout
sys.stdout = sys.stderr


def _send(message):
    encoded = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    _protocol_output.write(encoded + "\n")
    _protocol_output.flush()
    if message.get("type") in ("result", "error"):
        if _receive().get("type") != "terminal_ack":
            raise RuntimeError("Mearl 宿主未确认执行终态")


def _receive():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Mearl 宿主已断开")
    message = json.loads(line)
    if not isinstance(message, dict):
        raise RuntimeError("Mearl 宿主发送了无效消息")
    return message


def _resolve(value):
    if inspect.isawaitable(value):
        return asyncio.run(value)
    return value


class _Signal:
    def __init__(self):
        self.aborted = False

    def throw_if_aborted(self):
        if self.aborted:
            raise RuntimeError("插件命令已取消")


class _CommandContext:
    def __init__(self, app, identity):
        self.identity = MappingProxyType({**identity, "host": MappingProxyType(identity["host"])})
        self.signal = _Signal()
        self.invoke = app.invoke
        self.progress = app.progress
        self.state = lambda collection, operation, payload=None: app.state(collection, operation, {**({"instanceId": identity["page"]["instanceId"]} if identity.get("page") else {}), **(payload or {})})
        self.model = app.model
        self.checkpoint = app.checkpoint
        self.recovery = identity.get("recovery")
        self.page = _BoundPage(app, identity["page"]["instanceId"]) if identity.get("page") else None
        app.identity = identity

    def cancel(self, *_):
        self.signal.aborted = True
        self.signal.throw_if_aborted()


class _BoundPage:
    def __init__(self, app, instance_id):
        self._app = app
        self._instance_id = instance_id

    def send(self, message, options=None):
        return self._app.page("send", {"instanceId": self._instance_id, "message": message, **({"timeoutSec": options["timeoutSec"]} if options and "timeoutSec" in options else {})})

    def get(self):
        return self._app.page("get", {"instanceId": self._instance_id})


class _InvocationError(RuntimeError):
    def __init__(self, message, code=None, details=None, metadata=None):
        super().__init__(message)
        self.code = code
        self.details = details
        self.metadata = metadata
        for key, value in (metadata or {}).items():
            if not key.startswith("_") and key not in ("code", "details", "metadata"):
                setattr(self, key, value)


class _App:
    def __init__(self, options):
        self.options = MappingProxyType(options)
        self.commands = []
        self.registering = True
        self.executing = False
        self.request_id = 0
        self.responses = {}
        self.observers = {}

    def command(self, signature, handler=None, description=""):
        return self._register_command(signature, handler, description, False)

    def toolboxCommand(self, signature, handler=None, description=""):
        return self._register_command(signature, handler, description, True)

    def runtimeCommand(self, signature, handler=None, description=""):
        return self._register_command(signature, handler, description, False, runtime_only=True)

    def recoveryCommand(self, command, handler=None):
        return self._register_command(command, handler, "", False, True)

    def checkpointMigration(self, command, handler=None):
        return self._register_command(command, handler, "", False, False, True)

    def _register_command(self, signature, handler, description, toolbox_only, recovery_only=False, migration_only=False, runtime_only=False):
        if not self.registering:
            raise RuntimeError("命令只能在入口注册阶段声明")
        if not isinstance(signature, str):
            raise TypeError("命令签名必须为字符串")
        if not isinstance(description, str):
            raise TypeError("命令 description 必须为字符串")

        def add(candidate):
            if not callable(candidate):
                raise TypeError("命令 handler 必须可调用")
            self.commands.append({
                "signature": signature,
                "description": description,
                "handler": candidate,
                "toolboxOnly": toolbox_only,
                "runtimeOnly": runtime_only,
                "recoveryOnly": recovery_only,
                "migrationOnly": migration_only,
            })
            return candidate

        if handler is None:
            return add
        add(handler)
        return None

    def invoke(self, action, payload=None, options=None, on_progress=None):
        if not self.executing:
            raise RuntimeError("app.invoke 只能在命令执行期间调用")
        if not isinstance(action, str) or not action:
            raise TypeError("app.invoke action 必须为非空字符串")
        if payload is None:
            payload = {}
        if options is None:
            options = {}
        if not isinstance(payload, dict) or not isinstance(options, dict):
            raise TypeError("app.invoke payload 和 options 必须为字典")
        self.request_id += 1
        request_id = self.request_id
        if on_progress is not None:
            if not callable(on_progress):
                raise TypeError("on_progress 必须为可调用对象")
            self.observers[request_id] = on_progress
        _send({
            "type": "invoke",
            "id": request_id,
            "action": action,
            "payload": payload,
            "options": options,
            "stream": on_progress is not None,
        })
        try:
            while request_id not in self.responses:
                message = _receive()
                if message.get("type") == "invoke-progress":
                    observer = self.observers.get(message.get("id"))
                    if observer:
                        _resolve(observer(message.get("progress")))
                elif message.get("type") == "response" and isinstance(message.get("id"), int):
                    self.responses[message["id"]] = message
                else:
                    raise RuntimeError("Mearl 宿主返回了无效的 invoke 响应")
            response = self.responses.pop(request_id)
        finally:
            self.observers.pop(request_id, None)
        error = response.get("error")
        if isinstance(error, dict):
            raise _InvocationError(str(error.get("message", "调用失败")), error.get("code"), error.get("details"), error.get("metadata"))
        return response.get("result")

    def state(self, collection, operation, payload=None):
        return self.invoke("plugin_state", {**(payload or {}), "plugin": self.identity["plugin"], "collection": collection, "operation": operation})

    def checkpoint(self, data, expectedSequence):
        return self.invoke("plugin_task_checkpoint", {"plugin": self.identity["plugin"], "data":data,"expectedSequence":expectedSequence})

    def model(self, request, on_progress=None):
        return self.invoke("plugin_model", {"plugin": self.identity["plugin"], "operation": "run", "request": request}, on_progress=on_progress)

    def page(self, operation, payload=None):
        if payload is None:
            payload = {}
        if not isinstance(operation, str) or not operation or not isinstance(payload, dict):
            raise TypeError("app.page 需要非空 operation 和字典 payload")
        return self.invoke("plugin_page", {**payload, "plugin": self.identity["plugin"], "operation": operation})

    def progress(self, message):
        if not self.executing:
            raise RuntimeError("app.progress 只能在命令执行期间调用")
        if not isinstance(message, str) or not message:
            raise TypeError("app.progress 需要非空字符串")
        _send({"type": "progress", "message": message})


def _error_message(error):
    if isinstance(error, _InvocationError):
        return str(error)
    detail = str(error)
    return type(error).__name__ + (": " + detail if detail else "")


phase = "load"
try:
    if sys.version_info < (3, 9):
        current = ".".join(str(part) for part in sys.version_info[:3])
        raise RuntimeError("需要 Python 3.9 或更高版本，当前为 " + current)

    initial = _receive()
    mode = initial.get("mode")
    options = initial.get("options", {})
    if mode not in ("describe", "run") or not isinstance(options, dict):
        raise RuntimeError("Mearl 宿主发送了无效的初始化消息")

    entry = os.path.abspath(sys.argv[1])
    entry_directory = os.path.dirname(entry)
    if entry_directory not in sys.path:
        sys.path.insert(0, entry_directory)
    spec = importlib.util.spec_from_file_location("mearl_skill_plugin", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 Python 插件入口")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    plugin_name = getattr(module, "name", None)
    plugin_description = getattr(module, "description", None)
    plugin_toolbox = getattr(module, "toolbox", None)
    if plugin_name is not None and not isinstance(plugin_name, str):
        raise TypeError("入口的 name 必须为字符串")
    if plugin_description is not None and not isinstance(plugin_description, str):
        raise TypeError("入口的 description 必须为字符串")
    if plugin_toolbox is not None and not isinstance(plugin_toolbox, dict):
        raise TypeError("入口的 toolbox 必须为对象")
    plugin_app_profiles = getattr(module, "appProfiles", None)
    register = getattr(module, "register", None)
    if not callable(register) and plugin_app_profiles is None:
        raise TypeError("入口必须导出 register(app) 函数")

    app = _App(options)
    if callable(register):
        _resolve(register(app))
    app.registering = False
    if not app.commands and plugin_app_profiles is None:
        raise RuntimeError("入口未注册任何命令")

    descriptor = {
        "type": "ready",
        "commands": [
            {"signature": item["signature"], "description": item["description"], "toolboxOnly": item["toolboxOnly"], "runtimeOnly": item["runtimeOnly"], "recoveryOnly": item["recoveryOnly"], "migrationOnly": item["migrationOnly"]}
            for item in app.commands
        ],
    }
    if plugin_name is not None:
        descriptor["name"] = plugin_name
    if plugin_description is not None:
        descriptor["description"] = plugin_description
    if plugin_toolbox is not None:
        descriptor["toolbox"] = plugin_toolbox
    if getattr(module, "pageRuntime", None) is not None:
        descriptor["pageRuntime"] = module.pageRuntime
    if getattr(module, "stateStorage", None) is not None:
        descriptor["stateStorage"] = module.stateStorage
    if getattr(module, "taskRecovery", None) is not None:
        descriptor["taskRecovery"] = module.taskRecovery
    if plugin_app_profiles is not None:
        descriptor["appProfiles"] = plugin_app_profiles
    _send(descriptor)

    acknowledgement = _receive()
    if acknowledgement.get("type") != "ready_ack":
        raise RuntimeError("Mearl 宿主未确认插件注册信息")
    if mode == "run":
        command_name = initial.get("command")
        command_input = initial.get("input")
        if not isinstance(command_name, str) or not isinstance(command_input, dict):
            raise RuntimeError("Mearl 宿主发送了无效的命令")
        selected = next(
            (item for item in app.commands if item["signature"].strip().split()[0] == command_name and item["runtimeOnly"] == (initial.get("runtime") is True) and item["recoveryOnly"] == (initial.get("recovery") is True) and item["migrationOnly"] == (initial.get("recovery") == "migration")),
            None,
        )
        if selected is None:
            raise RuntimeError("未知子命令: " + command_name)
        phase = "run"
        command_context = _CommandContext(app, initial["identity"])
        signal.signal(signal.SIGTERM, command_context.cancel)
        app.executing = True
        try:
            handler = selected["handler"]
            try:
                inspect.signature(handler).bind(command_input, command_context)
                takes_context = True
            except TypeError:
                takes_context = False
            result = _resolve(handler(command_input, command_context) if takes_context else handler(command_input))
        finally:
            app.executing = False
        _send({"type": "result", "result": result})
except BaseException as error:
    response = {"type": "error", "phase": phase, "message": _error_message(error)}
    code = getattr(error, "code", None)
    if isinstance(code, str):
        response["code"] = code
    for field in ("details", "metadata"):
        value = getattr(error, field, None)
        if isinstance(value, dict):
            response[field] = value
    try:
        _send(response)
    except BaseException as serialization_error:
        _send({
            "type": "error",
            "phase": phase,
            "message": "返回值无法 JSON 序列化: " + _error_message(serialization_error),
        })
    sys.exit(1)
`;

function pythonExecutable(): string {
  return process.env.MEARL_PYTHON?.trim() || 'python3';
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDescriptor(message: PythonWorkerMessage): PythonPluginDescriptor {
  if (!Array.isArray(message.commands)) throw new Error('Python 插件未返回命令列表');
  const commands = message.commands.map(value => {
    if (
      !isObject(value) ||
      typeof value.signature !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.toolboxOnly !== 'boolean' ||
      typeof value.runtimeOnly !== 'boolean'
    ) {
      throw new Error('Python 插件返回了无效的命令描述');
    }
    return {
      signature: value.signature,
      description: value.description,
      toolboxOnly: value.toolboxOnly,
      runtimeOnly: value.runtimeOnly,
      recoveryOnly: value.recoveryOnly === true,
      migrationOnly: value.migrationOnly === true,
    };
  });
  if (message.name !== undefined && typeof message.name !== 'string') {
    throw new Error('Python 插件返回了无效的 name');
  }
  if (message.description !== undefined && typeof message.description !== 'string') {
    throw new Error('Python 插件返回了无效的 description');
  }
  return {
    commands,
    ...(typeof message.name === 'string' ? { name: message.name } : {}),
    ...(typeof message.description === 'string' ? { description: message.description } : {}),
    ...(message.toolbox !== undefined ? { toolbox: message.toolbox } : {}),
    ...(message.pageRuntime !== undefined ? { pageRuntime: message.pageRuntime } : {}),
    ...(message.stateStorage !== undefined ? { stateStorage: message.stateStorage } : {}),
    ...(message.taskRecovery !== undefined ? { taskRecovery: message.taskRecovery } : {}),
    ...(message.appProfiles !== undefined ? { appProfiles: message.appProfiles } : {}),
  };
}

function bridgedError(message: PythonWorkerMessage): Error {
  const detail = typeof message.message === 'string' ? message.message : 'Python 插件执行失败';
  const restored = pluginExecutionError({
    message: detail,
    ...(typeof message.code === 'string' ? { code: message.code } : {}),
    ...(isObject(message.details) ? { details: message.details } : {}),
    ...(isObject(message.metadata) ? { metadata: message.metadata } : {}),
  });
  if (typeof message.code === 'string' && /^PLUGIN_[A-Z0-9_]+$/.test(message.code)) {
    return Object.assign(new PluginError(message.code, detail), restored);
  }
  return restored;
}

function errorResponse(error: unknown): PluginExecutionError {
  const serialized = serializePluginExecutionError(error);
  if (error instanceof PluginError) {
    const prefix = `${error.code}: `;
    return {
      ...serialized,
      code: error.code,
      message: error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message,
    };
  }
  return serialized;
}

async function runPythonWorker(
  entry: string,
  initial: Record<string, unknown>,
  app?: PythonPluginApp,
  signal?: AbortSignal,
  expectedDescriptor?: PythonPluginDescriptor,
): Promise<{ descriptor: PythonPluginDescriptor; result?: unknown }> {
  return new Promise((resolve, reject) => {
    const executable = pythonExecutable();
    const child = spawn(executable, ['-u', '-c', PYTHON_BOOTSTRAP, entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let descriptor: PythonPluginDescriptor | undefined;
    let outcome: { error?: Error; hasResult?: boolean; result?: unknown } | undefined;
    let protocolError: Error | undefined;
    let stderr = '';

    const failProtocol = (error: unknown) => {
      if (protocolError) return;
      protocolError = error instanceof Error ? error : new Error(String(error));
      cancel();
    };
    const write = (message: Record<string, unknown>) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        failProtocol(error);
      }
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', () => undefined);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalStopRequested = false;
    const armKill = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        terminalStopRequested =
          !protocolError &&
          !signal?.aborted &&
          Boolean(outcome || (initial.mode === 'describe' && descriptor));
        child.kill('SIGKILL');
      }, 1000);
      killTimer.unref();
    };
    const cancel = () => {
      child.kill('SIGTERM');
      armKill();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            `未找到 ${executable}，Python 插件需要 Python 3.9 或更高版本` +
              '（可通过 MEARL_PYTHON 指定解释器）',
          ),
        );
      } else {
        reject(error);
      }
    });

    lines.on('line', line => {
      if (protocolError) return;
      let message: PythonWorkerMessage;
      try {
        const value: unknown = JSON.parse(line);
        if (!isObject(value) || typeof value.type !== 'string') {
          throw new Error('消息不是对象');
        }
        message = value as PythonWorkerMessage;
      } catch (error) {
        failProtocol(
          new Error(
            `Python 插件输出了无效协议消息: ${line.slice(0, 200)}`,
            error instanceof Error ? { cause: error } : undefined,
          ),
        );
        return;
      }

      if (message.type === 'ready') {
        try {
          if (descriptor) throw new Error('Python 插件重复发送 ready');
          descriptor = parseDescriptor(message);
          if (initial.mode === 'run') {
            if (
              expectedDescriptor &&
              pluginRecoverySignature(descriptor) !== pluginRecoverySignature(expectedDescriptor)
            )
              throw new PluginError(
                'PLUGIN_DECLARATION_CHANGED',
                'Python execution declaration differs from its loaded metadata',
              );
          }
          write({ type: 'ready_ack' });
          if (initial.mode === 'describe') armKill();
        } catch (error) {
          failProtocol(error);
        }
        return;
      }
      if (message.type === 'progress') {
        if (!app || typeof message.message !== 'string') {
          failProtocol(new Error('Python 插件发送了无效的 progress 消息'));
          return;
        }
        try {
          app.progress(message.message);
        } catch (error) {
          failProtocol(error);
        }
        return;
      }
      if (message.type === 'invoke') {
        if (
          !app ||
          typeof message.id !== 'number' ||
          typeof message.action !== 'string' ||
          !isObject(message.payload) ||
          !isObject(message.options)
        ) {
          failProtocol(new Error('Python 插件发送了无效的 invoke 消息'));
          return;
        }
        const { action, payload, options } = message;
        void Promise.resolve()
          .then(() =>
            action === 'plugin_task_checkpoint' && app.checkpoint
              ? app.checkpoint(payload.data, payload.expectedSequence as number)
              : action === 'plugin_model' && payload.operation === 'run' && app.model
                ? app.model(
                    payload.request,
                    message.stream
                      ? {
                          onProgress: progress => {
                            if (!signal?.aborted && !outcome)
                              write({ type: 'invoke-progress', id: message.id, progress });
                          },
                        }
                      : undefined,
                  )
                : action === 'plugin_state' && app.state
                  ? app.state(payload.collection as string, payload.operation as string, payload)
                  : action === 'plugin_page' && app.page
                    ? app.page(payload.operation as string, payload)
                    : app.invoke(action, payload, options),
          )
          .then(result => {
            write({
              type: 'response',
              id: message.id,
              result: result === undefined ? null : result,
            });
          })
          .catch(error => {
            write({ type: 'response', id: message.id, error: errorResponse(error) });
          });
        return;
      }
      if (message.type === 'result') {
        if (!outcome) outcome = { hasResult: true, result: message.result };
        write({ type: 'terminal_ack' });
        armKill();
        return;
      }
      if (message.type === 'error') {
        if (!outcome) outcome = { error: bridgedError(message) };
        write({ type: 'terminal_ack' });
        armKill();
        return;
      }
      failProtocol(new Error(`Python 插件发送了未知消息类型: ${message.type}`));
    });

    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      if (killTimer) clearTimeout(killTimer);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Plugin command cancelled'));
        return;
      }
      if (protocolError) {
        reject(protocolError);
        return;
      }
      if (outcome?.error) {
        reject(outcome.error);
        return;
      }
      if (code !== 0 && !terminalStopRequested) {
        reject(
          new Error(
            stderr.trim() || `Python 插件进程异常退出${code === null ? '' : ` (exit ${code})`}`,
          ),
        );
        return;
      }
      if (!descriptor) {
        reject(new Error('Python 插件未返回注册信息'));
        return;
      }
      if (initial.mode === 'run' && !outcome?.hasResult) {
        reject(new Error('Python 插件未返回执行结果'));
        return;
      }
      resolve({ descriptor, ...(outcome?.hasResult ? { result: outcome.result } : {}) });
    };
    // Acknowledged frames precede process exit; inherited pipes cannot delay completion.
    child.once('exit', finish);
    child.once('close', finish);

    write(initial);
  });
}

export async function describePythonPlugin(
  entry: string,
  options: Readonly<PluginOptions>,
): Promise<PythonPluginDescriptor> {
  const { descriptor } = await runPythonWorker(entry, { mode: 'describe', options });
  return descriptor;
}

export async function runPythonPluginCommand(
  entry: string,
  command: string,
  input:
    | Record<string, any>
    | import('@mearl/browser-core').PluginCheckpointMigrationInput,
  app: PythonPluginApp,
  context: PluginCommandContext,
  recovery: boolean | 'migration' = false,
  expectedDescriptor?: PythonPluginDescriptor,
  runtimeOnly = false,
): Promise<unknown> {
  const { result } = await runPythonWorker(
    entry,
    {
      mode: 'run',
      command,
      input,
      options: app.options,
      identity: context.identity,
      recovery,
      runtime: runtimeOnly,
    },
    app,
    context.signal,
    expectedDescriptor,
  );
  return result;
}
