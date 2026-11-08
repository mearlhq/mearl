import { describe, it, expect } from 'vitest';
import {
  matchAXNodesByText,
  formatAXTextMatchCandidates,
  type AXTextMatchNode,
} from '@mearl/browser-core';

// 模拟一份典型的阅读器退票页 AX 子集——StaticText 与可点击 button 同名共存的常见情况。
const nodes: AXTextMatchNode[] = [
  { nodeId: '1', role: { value: 'WebArea' }, name: { value: '退票详情' }, backendDOMNodeId: 100 },
  {
    nodeId: '2',
    role: { value: 'StaticText' },
    name: { value: '退款明细' },
    backendDOMNodeId: 200,
  },
  { nodeId: '3', role: { value: 'button' }, name: { value: '退款明细' }, backendDOMNodeId: 300 },
  {
    nodeId: '4',
    role: { value: 'StaticText' },
    name: { value: '退款成功' },
    backendDOMNodeId: 400,
  },
  { nodeId: '5', role: { value: 'link' }, name: { value: '查询退款去向' }, backendDOMNodeId: 500 },
  // ignored / no-backend / empty name — 都应被过滤
  {
    nodeId: '6',
    role: { value: 'StaticText' },
    name: { value: '退款明细' },
    ignored: true,
    backendDOMNodeId: 600,
  },
  { nodeId: '7', role: { value: 'StaticText' }, name: { value: '退款明细' } },
  { nodeId: '8', role: { value: 'StaticText' }, name: { value: '' }, backendDOMNodeId: 800 },
];

describe('matchAXNodesByText', () => {
  it('精确匹配返回所有同名 ax 节点', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款明细' });
    expect(hits.map(h => h.backendNodeId)).toEqual([200, 300]);
  });

  it('role 过滤可消歧到单个候选', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款明细', role: 'button' });
    expect(hits).toHaveLength(1);
    expect(hits[0].backendNodeId).toBe(300);
    expect(hits[0].role).toBe('button');
  });

  it('exact:false 启用子串匹配', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款', exact: false });
    // 200/300 名为"退款明细"，400 为"退款成功"，500 为"查询退款去向" 全部命中
    expect(hits.map(h => h.backendNodeId).sort()).toEqual([200, 300, 400, 500]);
  });

  it('精确匹配下子串不应匹配', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款' });
    expect(hits).toEqual([]);
  });

  it('过滤掉 ignored / 无 backendNodeId / 空 name', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款明细' });
    const ids = hits.map(h => h.backendNodeId);
    expect(ids).not.toContain(600); // ignored
    expect(ids).not.toContain(700); // 无 backendDOMNodeId
    expect(ids).not.toContain(800); // 空 name
  });

  it('空 text 与非字符串返回空 hits', () => {
    expect(matchAXNodesByText(nodes, { text: '' }).hits).toEqual([]);
    expect(matchAXNodesByText(nodes, { text: undefined as unknown as string }).hits).toEqual([]);
  });

  it('role 不匹配时返回空', () => {
    const { hits } = matchAXNodesByText(nodes, { text: '退款明细', role: 'heading' });
    expect(hits).toEqual([]);
  });
});

describe('formatAXTextMatchCandidates', () => {
  it('按编号列出候选并截断超长 name', () => {
    const hits = [
      { backendNodeId: 1, role: 'button', name: '提交' },
      { backendNodeId: 2, role: 'StaticText', name: 'x'.repeat(80) },
    ];
    const text = formatAXTextMatchCandidates(hits);
    expect(text).toContain('1. button "提交"');
    // 第二条应被截断为前 60 字符 + …
    expect(text).toContain(`2. StaticText "${'x'.repeat(60)}…"`);
  });

  it('limit 控制最多输出条数', () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      backendNodeId: i,
      role: 'button',
      name: `btn${i}`,
    }));
    const text = formatAXTextMatchCandidates(hits, 3);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('缺失 role 时显示占位 (no-role)', () => {
    const text = formatAXTextMatchCandidates([{ backendNodeId: 1, role: '', name: 'foo' }]);
    expect(text).toContain('(no-role)');
  });
});
