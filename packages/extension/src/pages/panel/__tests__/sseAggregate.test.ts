import { describe, it, expect } from 'vitest';
import {
  aggregateSseMessages,
  aggregateParsedFrames,
  parseSseFrames,
  deepParseJson,
  mergeSseValue,
} from '../utils/sseAggregate';
import { SSEMessage } from '../types';

// 构造一条 mtop AI chat 风格的 resp 帧：data.result 是双层 JSON 字符串
const resp = (inner: Record<string, any>): SSEMessage => ({
  event: 'resp',
  data: {
    api: 'mtop.example.chat.stream',
    data: { result: JSON.stringify(inner) },
    ret: ['SUCCESS::调用成功'],
    traceId: 'trace-1',
    v: '2.0',
  },
});

const base = {
  config: { requestExt: { clientType: 'other' } },
  sessionId: 'sess-1',
  status: 'normal',
  responseType: 'LUI',
};

describe('sseAggregate - deepParseJson', () => {
  it('递归解析多层 JSON 字符串', () => {
    expect(deepParseJson('{"a":"{\\"b\\":1}"}')).toEqual({ a: { b: 1 } });
  });
  it('非 JSON 字符串原样返回', () => {
    expect(deepParseJson('你好')).toBe('你好');
    expect(deepParseJson('123abc')).toBe('123abc');
  });
});

describe('sseAggregate - mergeSseValue', () => {
  it('流式文本字段（白名单 key）增量拼接', () => {
    expect(mergeSseValue('你好', '世界', 'message')).toBe('你好世界');
    expect(mergeSseValue('think', 'ing', 'thinking')).toBe('thinking');
  });
  it('全量快照（next 以 acc 为前缀）直接覆盖，不重复拼接', () => {
    expect(mergeSseValue('你好', '你好世界', 'message')).toBe('你好世界');
    expect(mergeSseValue('', '首帧', 'content')).toBe('首帧');
  });
  it('非白名单字符串（枚举/状态字段）取最后一帧，绝不拼接', () => {
    // faiEventType 这类枚举值逐帧不同，拼接会得到乱码
    expect(mergeSseValue('WT_AGENT_TOOL_INVOKE', 'TOOL_INVOKE_SUMMARY', 'faiEventType')).toBe(
      'TOOL_INVOKE_SUMMARY',
    );
    expect(mergeSseValue('normal', 'finished', 'status')).toBe('finished');
    // 无 key（顶层/数组元素）同样取后者
    expect(mergeSseValue('a', 'b')).toBe('b');
  });
  it('无身份键的数组取更长的一方', () => {
    expect(mergeSseValue([], [{}])).toEqual([{}]);
    expect(mergeSseValue([{ a: 1 }], [])).toEqual([{ a: 1 }]);
  });
  it('元素带身份键（id）的数组按 id 累积：新 id 追加', () => {
    expect(mergeSseValue([{ id: 1, v: 'a' }], [{ id: 2, v: 'b' }])).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ]);
  });
  it('同 id 元素深合并：文本字段拼接、枚举取后者', () => {
    expect(
      mergeSseValue(
        [{ id: 1, message: '你', status: 'normal' }],
        [{ id: 1, message: '好', status: 'finish' }],
      ),
    ).toEqual([{ id: 1, message: '你好', status: 'finish' }]);
  });
  it('身份键在数组内不唯一时退回取更长，避免误合并', () => {
    expect(mergeSseValue([{ id: 1 }, { id: 1 }], [{ id: 2 }])).toEqual([{ id: 1 }, { id: 1 }]);
  });
  it('对象递归深合并：白名单字段拼接、其余取后者', () => {
    expect(
      mergeSseValue(
        { message: '你', faiEventType: 'A', keep: 1 },
        { message: '好', faiEventType: 'B', extra: 2 },
      ),
    ).toEqual({ message: '你好', faiEventType: 'B', keep: 1, extra: 2 });
  });
  it('标量取后者', () => {
    expect(mergeSseValue(1, 2)).toBe(2);
  });
});

describe('sseAggregate - aggregateSseMessages', () => {
  it('把增量 message 拼接成完整正文，并保留 envelope 与最终元数据', () => {
    const messages: SSEMessage[] = [
      resp({ ...base, callTool: { name: 'prep' }, message: '', seq: 1 }),
      resp({ ...base, message: '你好', seq: 2 }),
      resp({ ...base, message: '，世界', seq: 3 }),
      resp({ heartBeat: true }),
      resp({ ...base, message: '！', seq: 4 }),
    ];

    const r = aggregateSseMessages(messages);

    // envelope 只保留一份
    expect(r.merged.api).toBe('mtop.example.chat.stream');
    expect(r.merged.ret).toEqual(['SUCCESS::调用成功']);
    // data.result 双层编码被解析成对象
    expect(typeof r.merged.data.result).toBe('object');
    // message 按帧顺序拼接
    expect(r.merged.data.result.message).toBe('你好，世界！');
    // 最终 seq 取最后一帧
    expect(r.merged.data.result.seq).toBe(4);
    // 首帧的 callTool 被保留
    expect(r.merged.data.result.callTool).toEqual({ name: 'prep' });
    // 统计
    expect(r.primaryEvent).toBe('resp');
    expect(r.heartbeatFrames).toBe(1);
    expect(r.mergedFrames).toBe(4);
    expect(r.totalFrames).toBe(5);
  });

  it('嵌套枚举字段（callTool.faiEventType）逐帧不同也不拼接，取最后一帧', () => {
    const messages: SSEMessage[] = [
      resp({ ...base, callTool: { faiEventType: 'WT_AGENT_TOOL_INVOKE', showName: '准备' } }),
      resp({ ...base, callTool: { faiEventType: 'TOOL_INVOKE_SUMMARY', showName: '汇总' } }),
      resp({ ...base, callTool: { faiEventType: 'WT_AGENT_TOOL_CALLING', showName: '调用' } }),
    ];
    const r = aggregateSseMessages(messages);
    expect(r.merged.data.result.callTool.faiEventType).toBe('WT_AGENT_TOOL_CALLING');
    expect(r.merged.data.result.callTool.showName).toBe('调用');
  });

  it('逐帧 append 的组件流（每帧一张卡片、长度恒为 1）按 id 全部累积', () => {
    // 目的地推荐：每帧下发一张卡片，components.length 始终为 1，靠 id/action:append 累积
    const card = (id: number, dest: string) => ({
      id,
      action: 'append',
      itemType: 'image_row',
      data: { images: [{ ext: { poiName: dest } }] },
    });
    const messages: SSEMessage[] = [
      resp({ ...base, message: '为你推荐', seq: 1 }),
      resp({ ...base, components: [card(1, '贵阳')], seq: 2 }),
      resp({ ...base, components: [card(2, '青岛')], seq: 3 }),
      resp({ ...base, components: [card(3, '成都')], seq: 4 }),
    ];

    const r = aggregateSseMessages(messages);
    const comps = r.merged.data.result.components;
    // 三张卡片全部保留，而非只剩最后一帧
    expect(comps).toHaveLength(3);
    expect(comps.map((c: any) => c.id)).toEqual([1, 2, 3]);
    expect(comps.map((c: any) => c.data.images[0].ext.poiName)).toEqual(['贵阳', '青岛', '成都']);
  });

  it('非主事件（trailer）不参与合并，保留在 otherEvents', () => {
    const messages: SSEMessage[] = [
      resp({ ...base, message: 'a', seq: 1 }),
      resp({ ...base, message: 'b', seq: 2 }),
      { event: 'trailer', data: { 'x-retcode': 'SUCCESS' } },
    ];

    const r = aggregateSseMessages(messages);
    expect(r.merged.data.result.message).toBe('ab');
    expect(r.otherEvents).toEqual([{ event: 'trailer', data: { 'x-retcode': 'SUCCESS' } }]);
  });

  it('空输入返回 merged=null', () => {
    const r = aggregateSseMessages([]);
    expect(r.merged).toBeNull();
    expect(r.totalFrames).toBe(0);
  });
});

describe('sseAggregate - 拖动回放（parseSseFrames + slice + aggregateParsedFrames）', () => {
  const messages: SSEMessage[] = [
    resp({ ...base, message: '你好', seq: 1 }),
    resp({ ...base, message: '，世界', seq: 2 }),
    resp({ ...base, message: '！', seq: 3 }),
  ];

  it('解析一次后按 slice 聚合前 N 帧，得到该帧位置的部分结果', () => {
    const frames = parseSseFrames(messages);
    expect(frames).toHaveLength(3);
    // 只聚合前 2 帧 → message 拼到第 2 帧
    const partial = aggregateParsedFrames(frames.slice(0, 2));
    expect(partial.merged.data.result.message).toBe('你好，世界');
    expect(partial.merged.data.result.seq).toBe(2);
    expect(partial.totalFrames).toBe(2);
    // 聚合全部 → 完整结果
    expect(aggregateParsedFrames(frames).merged.data.result.message).toBe('你好，世界！');
  });

  it('aggregateSseMessages 等价于 parse 后全量聚合', () => {
    expect(aggregateSseMessages(messages)).toEqual(aggregateParsedFrames(parseSseFrames(messages)));
  });
});
