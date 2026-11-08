import { expect, it, vi } from 'vitest';
import { invokePageEvalWithArgs } from '../pageEvalArguments';

it('invokes a small function and JSON data through the existing page_eval action', async () => {
  const invoke = vi.fn().mockResolvedValue({ result: 42 });
  await expect(
    invokePageEvalWithArgs(invoke, {
      tabId: 7,
      worldId: 'my-tool',
      expression: 'data => data.value',
      args: [{ value: 42 }],
      executionWorld: 'isolated',
      observe: false,
    }),
  ).resolves.toEqual({ result: 42 });
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      expression: expect.stringContaining('JSON.parse'),
      executionWorld: 'isolated',
      worldId: 'my-tool',
      observe: false,
    }),
  );
});
it.each([false, true])(
  'bounds large JSON messages and cleans isolated transfers (failure=%s)',
  async failure => {
    const pageWindow: Record<string, unknown> = {};
    let chunks = 0;
    const invoke = vi.fn(async ({ expression }) => {
      expect(Buffer.byteLength(expression)).toBeLessThan(256 * 1024);
      if (expression.includes("|| ''") && ++chunks === 2 && failure)
        throw new Error('transfer failed');
      return { result: new Function('window', `return ${expression}`)(pageWindow) };
    });
    const data = 'a'.repeat(48 * 1024 - 2) + '😀' + '设计'.repeat(50_000);
    const result = invokePageEvalWithArgs(invoke, {
      tabId: 7,
      worldId: 'my-tool',
      expression: 'data => data',
      args: [data],
      executionWorld: 'isolated',
    });
    if (failure) await expect(result).rejects.toThrow('transfer failed');
    else await expect(result).resolves.toEqual({ result: data });
    expect(pageWindow).toEqual({});
  },
);
it('validates the target before transmitting and rejects circular data', async () => {
  const invoke = vi.fn();
  await expect(
    invokePageEvalWithArgs(invoke, {
      tabId: -1,
      worldId: 'my-tool',
      expression: 'data => data',
      args: [],
    }),
  ).rejects.toThrow('target tab');
  const data: any = {};
  data.self = data;
  await expect(
    invokePageEvalWithArgs(invoke, {
      tabId: 7,
      worldId: 'my-tool',
      expression: 'data => data',
      args: [data],
      executionWorld: 'isolated',
    }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
it('observes only the business function when transferring large arguments', async () => {
  const pageWindow: Record<string, unknown> = {};
  const invoke = vi.fn(async ({ expression }) => ({
    result: new Function('window', `return ${expression}`)(pageWindow),
  }));
  await invokePageEvalWithArgs(invoke, {
    tabId: 7,
    expression: '(first, second) => first.length + second',
    args: ['x'.repeat(100000), 3],
    observe: { timeoutMs: 10 },
    diagnostics: true,
  });
  const requests = invoke.mock.calls.map(([request]) => request);
  expect(requests.filter(request => request.observe !== false)).toHaveLength(1);
  expect(requests.find(request => request.observe !== false)).toMatchObject({
    observe: { timeoutMs: 10 },
    diagnostics: true,
  });
  expect(pageWindow).toEqual({});
});
it('preserves observed business failures and stops unsuccessful transport requests', async () => {
  const failure = { action: { success: false, error: 'business failure' } };
  const invoke = vi.fn().mockResolvedValue(failure);
  await expect(
    invokePageEvalWithArgs(invoke, {
      tabId: 7,
      expression: '() => 42',
      args: [],
      diagnostics: true,
    }),
  ).resolves.toEqual(failure);
  invoke.mockClear();
  await expect(
    invokePageEvalWithArgs(invoke, {
      tabId: 7,
      expression: 'value => value',
      args: ['x'.repeat(100000)],
    }),
  ).rejects.toThrow('business failure');
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1][0].expression).toMatch(/^delete window/);
});
it.each([0, 100000])(
  'preserves JSON own fields and prototypes for %s padding characters',
  async padding => {
    const data = JSON.parse('{"__proto__":{"marker":true},"normal":42}');
    data.padding = 'x'.repeat(padding);
    const pageWindow = {};
    const invoke = vi.fn(async ({ expression }) => ({
      result: new Function('window', `return ${expression}`)(pageWindow),
    }));
    await expect(
      invokePageEvalWithArgs(invoke, {
        tabId: 7,
        expression:
          'data => ({ keys: Object.keys(data), ownProto: Object.hasOwn(data, "__proto__"), inherited: "marker" in data, normalPrototype: Object.getPrototypeOf(data) === Object.prototype })',
        args: [data],
      }),
    ).resolves.toEqual({
      result: {
        keys: ['__proto__', 'normal', 'padding'],
        ownProto: true,
        inherited: false,
        normalPrototype: true,
      },
    });
    expect(pageWindow).toEqual({});
  },
);
