/** Runs entirely in the selected document's isolated script world. */
export async function installPluginPageRuntime(
  config: any,
  factory: (host: any) => any,
  connectPort?: (name: string) => any,
): Promise<void> {
  const root = globalThis as any;
  const preceding: Promise<void> = root.__mearlPluginPageInstall ?? Promise.resolve();
  let release!: () => void;
  root.__mearlPluginPageInstall = new Promise<void>(resolve => {
    release = resolve;
  });
  await preceding.catch(() => {});
  try {
    const instances: Map<string, any> = (root.__mearlPluginPageInstances ??= new Map());
    if (instances.has(config.instanceId)) return;
    // Each plugin has its own script world; a document has one owner for that plugin.
    for (const previous of [...instances.values()]) await previous.dispose();
    const controller = new AbortController();
    const pending = new Map<
      number,
      { message: any; resolve: () => void; reject: (error: Error) => void }
    >();
    const requests = new Map<string, AbortController>();
    const cancelled = new Set<string>();
    let sequence = 0;
    let port: any;
    let epoch: string | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let disconnectedAt = Date.now();
    let handler: any;
    let disposed = false;
    let disposal: Promise<void> | undefined;
    let handlerDisposal: Promise<void> | undefined;
    const disposeHandler = () =>
      handler
        ? (handlerDisposal ??= Promise.resolve().then(() => handler?.dispose?.()))
        : Promise.resolve();
    const flush = () => {
      if (!port || !epoch || disposed) return;
      for (const value of pending.values()) port.postMessage({ ...value.message, epoch });
    };
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.resolve()
        .then(disposeHandler)
        .finally(() => {
          if (instances.get(config.instanceId) === record) instances.delete(config.instanceId);
        });
      controller.abort();
      clearTimeout(reconnect);
      for (const request of requests.values()) request.abort();
      requests.clear();
      cancelled.clear();
      for (const item of pending.values()) item.reject(new Error('Plugin page instance ended'));
      pending.clear();
      const previous = port;
      port = undefined;
      previous?.disconnect();
      return disposal;
    };
    const connect = () => {
      if (disposed) return;
      if (Date.now() - disconnectedAt > 30000) {
        void dispose().catch(() => {});
        return;
      }
      try {
        const name = `mearl-plugin-page:${config.instanceId}:${config.token}`;
        const factory = root.__mearlPluginPageConnect ?? connectPort;
        const next = factory ? factory(name) : root.chrome.runtime.connect({ name });
        port = next;
        next.onMessage.addListener((message: any) => {
          if (port !== next || disposed) return;
          if (message.type === 'ready') {
            epoch = message.epoch;
            disconnectedAt = Date.now();
            flush();
          }
          if (message.type === 'accepted') {
            const item = pending.get(message.sequence);
            if (item) {
              pending.delete(message.sequence);
              item.resolve();
            }
          }
          if (message.type === 'dispose') void dispose().catch(() => {});
        });
        next.onDisconnect.addListener(() => {
          if (port !== next || disposed) return;
          if (epoch) disconnectedAt = Date.now();
          port = undefined;
          epoch = undefined;
          reconnect = setTimeout(connect, 250);
        });
      } catch {
        reconnect = setTimeout(connect, 500);
      }
    };
    const host = Object.freeze({
      identity: Object.freeze({
        ...config.identity,
        target: Object.freeze({ ...config.identity.target }),
      }),
      input: config.input,
      signal: controller.signal,
      emit(name: string, payload: unknown): Promise<void> {
        if (disposed) return Promise.reject(new Error('Plugin page instance ended'));
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !Object.hasOwn(config.events, name))
          return Promise.reject(new Error('Undeclared plugin page event'));
        const json = JSON.stringify(payload ?? null);
        if (new TextEncoder().encode(json).length > 32768 || pending.size >= 64)
          return Promise.reject(
            new Error('Plugin page event buffer is full or payload exceeds 32 KiB'),
          );
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          pending.set(id, {
            message: { type: 'event', sequence: id, name, payload: JSON.parse(json) },
            resolve,
            reject,
          });
          flush();
        });
      },
    });
    const record = {
      dispose,
      reconnect: () => {
        if (disposed) return;
        const previous = port;
        port = undefined;
        epoch = undefined;
        clearTimeout(reconnect);
        previous?.disconnect();
        disconnectedAt = Date.now();
        connect();
      },
      cancel: (requestId: string) => {
        if (typeof requestId !== 'string') return;
        requests.get(requestId)?.abort();
        cancelled.add(requestId);
        if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value!);
      },
      send: async (message: unknown, requestId?: string) => {
        if (disposed) throw new Error('Plugin page instance ended');
        if (typeof handler?.receive !== 'function')
          throw new Error('Plugin page runtime has no receive handler');
        const request = new AbortController();
        if (requestId) {
          if (requests.size >= 64) throw new Error('Too many pending page requests');
          if (requests.has(requestId)) throw new Error('Duplicate page request');
          requests.set(requestId, request);
          if (cancelled.has(requestId)) request.abort();
        }
        const stop = () => request.abort();
        controller.signal.addEventListener('abort', stop, { once: true });
        try {
          request.signal.throwIfAborted();
          const result = await handler.receive(
            message,
            Object.freeze({ signal: request.signal, requestId }),
          );
          request.signal.throwIfAborted();
          controller.signal.throwIfAborted();
          return result;
        } finally {
          controller.signal.removeEventListener('abort', stop);
          if (requestId) {
            requests.delete(requestId);
            cancelled.delete(requestId);
          }
        }
      },
    };
    instances.set(config.instanceId, record);
    connect();
    try {
      handler = await factory(host);
    } catch (error) {
      await dispose();
      throw error;
    }
    if (disposed) await disposeHandler();
  } finally {
    release();
  }
}
