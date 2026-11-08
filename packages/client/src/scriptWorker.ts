import { getStructure } from '@mearl/browser-core';
import { serializeScriptError } from './scriptErrors.js';

const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let sequence = 0;
let session: unknown;
const call = (method: string, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send!({ type: 'call', id, method, args });
  });
process.on('disconnect', () => process.exit(1));
process.on('message', async (message: any) => {
  if (message.type === 'response') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    session = message.session ?? session;
    if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
    else entry.resolve(message.result);
    return;
  }
  if (message.type !== 'start') return;
  session = message.session;
  const api = Object.fromEntries(
    message.methods.map((method: string) => [method, (...args: unknown[]) => call(method, args)]),
  );
  api.structure = getStructure;
  Object.defineProperty(api, 'session', { get: () => session, enumerable: true });
  Object.defineProperty(globalThis, 'mearl', { value: Object.freeze(api), configurable: true });
  let failure;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      'mearl',
      '"use strict";\n' + message.code + '\n//# sourceURL=mearl-script.js',
    );
    await fn(api);
    if (pending.size)
      throw Object.assign(new Error('Script finished with unawaited SDK calls'), {
        code: 'SCRIPT_PENDING_CALLS',
      });
  } catch (error) {
    failure = serializeScriptError(error);
  }
  await Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
  process.send!(failure ? { type: 'error', error: failure } : { type: 'done' });
});
