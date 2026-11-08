import { describe, it, expect } from 'vitest';
import {
  isPrimitive,
  isExpandable,
  getValueType,
  getPreview,
  isCompactable,
  getCompactJson,
  convertJsonToTypeScript,
} from '../utils/jsonHelpers';

describe('jsonHelpers.ts - JSON 工具函数测试', () => {
  describe('isPrimitive', () => {
    it('应该识别原始类型', () => {
      expect(isPrimitive('string')).toBe(true);
      expect(isPrimitive(123)).toBe(true);
      expect(isPrimitive(true)).toBe(true);
      expect(isPrimitive(false)).toBe(true);
      expect(isPrimitive(null)).toBe(true);
    });

    it('应该拒绝非原始类型', () => {
      expect(isPrimitive({})).toBe(false);
      expect(isPrimitive([])).toBe(false);
      expect(isPrimitive(undefined)).toBe(false);
    });
  });

  describe('isExpandable', () => {
    it('应该识别可展开的值', () => {
      expect(isExpandable({})).toBe(true);
      expect(isExpandable([])).toBe(true);
      expect(isExpandable({ a: 1 })).toBe(true);
      expect(isExpandable([1, 2, 3])).toBe(true);
    });

    it('应该拒绝不可展开的值', () => {
      expect(isExpandable(null)).toBe(false);
      expect(isExpandable('string')).toBe(false);
      expect(isExpandable(123)).toBe(false);
      expect(isExpandable(true)).toBe(false);
    });
  });

  describe('getValueType', () => {
    it('应该正确返回值类型', () => {
      expect(getValueType(null)).toBe('null');
      expect(getValueType([])).toBe('array');
      expect(getValueType({})).toBe('object');
      expect(getValueType('string')).toBe('string');
      expect(getValueType(123)).toBe('number');
      expect(getValueType(true)).toBe('boolean');
      expect(getValueType(undefined)).toBe('undefined');
    });
  });

  describe('getPreview', () => {
    it('应该为数组返回长度预览', () => {
      expect(getPreview([1, 2, 3])).toBe('Array(3)');
      expect(getPreview([])).toBe('[]');
    });

    it('应该为小对象返回紧凑 JSON', () => {
      expect(getPreview({ id: 1, name: 'test' })).toBe('{ "id": 1, "name": "test" }');
      expect(getPreview({ active: true })).toBe('{ "active": true }');
    });

    it('应该为大对象返回键数量预览', () => {
      expect(getPreview({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('Object(5)');
      expect(getPreview({})).toBe('{}');
    });

    it('应该为包含非基础类型的对象返回键数量预览', () => {
      expect(getPreview({ a: 1, b: { nested: true } })).toBe('Object(2)');
    });

    it('原始类型应该返回空字符串', () => {
      expect(getPreview('string')).toBe('');
      expect(getPreview(123)).toBe('');
      expect(getPreview(null)).toBe('');
    });
  });

  describe('isCompactable', () => {
    it('应该识别适合紧凑展示的对象', () => {
      expect(isCompactable({ id: 1, name: 'test' })).toBe(true);
      expect(isCompactable({ a: 1, b: 2, c: 3 })).toBe(true);
      expect(isCompactable({ active: true })).toBe(true);
    });

    it('应该拒绝属性过多的对象', () => {
      expect(isCompactable({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe(false);
    });

    it('应该拒绝包含非基础类型的对象', () => {
      expect(isCompactable({ a: 1, b: { nested: true } })).toBe(false);
      expect(isCompactable({ a: 1, b: [1, 2, 3] })).toBe(false);
    });

    it('应该拒绝总长度过长的对象', () => {
      const longString = 'a'.repeat(80);
      expect(isCompactable({ text: longString })).toBe(false);
    });

    it('应该拒绝数组', () => {
      expect(isCompactable([1, 2, 3])).toBe(false);
    });

    it('应该允许空对象紧凑展示', () => {
      expect(isCompactable({})).toBe(true);
    });

    it('应该拒绝原始类型', () => {
      expect(isCompactable(null)).toBe(false);
      expect(isCompactable('string')).toBe(false);
      expect(isCompactable(123)).toBe(false);
    });
  });

  describe('getCompactJson', () => {
    it('应该返回格式化的紧凑 JSON', () => {
      expect(getCompactJson({ id: 1, name: 'test' })).toBe('{ "id": 1, "name": "test" }');
      expect(getCompactJson({ a: 1 })).toBe('{ "a": 1 }');
    });

    it('应该在逗号后添加空格', () => {
      const result = getCompactJson({ a: 1, b: 2, c: 3 });
      expect(result).toBe('{ "a": 1, "b": 2, "c": 3 }');
    });
  });

  describe('convertJsonToTypeScript', () => {
    it('简单对象生成根接口', async () => {
      const out = await convertJsonToTypeScript({ id: 1, name: 'tt', active: true });
      expect(out).toBe(
        [
          'interface RootObject {',
          '  id?: number;',
          '  name?: string;',
          '  active?: boolean;',
          '}',
        ].join('\n'),
      );
    });

    it('嵌套对象生成多个接口，依赖在前根在后', async () => {
      const out = await convertJsonToTypeScript({ id: 1, user: { name: 'a', age: 2 } });
      expect(out).toContain('interface User {');
      expect(out).toContain('interface RootObject {');
      // User 接口位于 RootObject 之前
      expect(out.indexOf('interface User')).toBeLessThan(out.indexOf('interface RootObject'));
      expect(out).toContain('user?: User;');
    });

    it('对象数组应合并字段为单一接口并单数化字段名', async () => {
      const out = await convertJsonToTypeScript({
        users: [
          { id: 1, name: 'a' },
          { id: 2, email: 'b@x' },
        ],
      });
      expect(out).toContain('interface User {');
      expect(out).toContain('id?: number;');
      expect(out).toContain('name?: string;');
      expect(out).toContain('email?: string;');
      expect(out).toContain('users?: User[];');
    });

    it('包含 null 的字段使用 null 类型', async () => {
      const out = await convertJsonToTypeScript({ a: null, b: [null, 1] });
      expect(out).toContain('a?: null;');
      expect(out).toMatch(/b\?: \(null \| number\)\[\]|b\?: \(number \| null\)\[\]/);
    });

    it('特殊字符的 key 自动加引号', async () => {
      const out = await convertJsonToTypeScript({ 'has-dash': 1, 'space key': 'x' });
      expect(out).toContain("'has-dash'?: number;");
      expect(out).toContain("'space key'?: string;");
    });

    it('空数组使用 any[]', async () => {
      const out = await convertJsonToTypeScript({ items: [] });
      expect(out).toContain('items?: any[];');
    });

    it('数组嵌套对象使用 ies → y 单数化', async () => {
      const out = await convertJsonToTypeScript({ categories: [{ id: 1 }] });
      expect(out).toContain('interface Category {');
      expect(out).toContain('categories?: Category[];');
    });

    it('传入自定义根名应被使用', async () => {
      const out = await convertJsonToTypeScript({ id: 1 }, 'MyType');
      expect(out).toContain('interface MyType {');
    });

    it('基础类型应输出 type 别名而非抛错', async () => {
      expect(await convertJsonToTypeScript('hi', 'name')).toBe('type Name = string;');
      expect(await convertJsonToTypeScript(42, 'age')).toBe('type Age = number;');
      expect(await convertJsonToTypeScript(true, 'active')).toBe('type Active = boolean;');
      expect(await convertJsonToTypeScript(null, 'data')).toBe('type Data = null;');
    });

    it('不规则复数应使用白名单还原（mice/people/children）', async () => {
      const out = await convertJsonToTypeScript({
        mice: [{ id: 1 }],
        people: [{ name: 'a' }],
        children: [{ age: 3 }],
      });
      expect(out).toContain('interface Mouse {');
      expect(out).toContain('interface Person {');
      expect(out).toContain('interface Child {');
      expect(out).toContain('mice?: Mouse[];');
      expect(out).toContain('people?: Person[];');
      expect(out).toContain('children?: Child[];');
    });

    it('拉丁/希腊词应使用白名单还原（analyses/criteria/phenomena）', async () => {
      const out = await convertJsonToTypeScript({
        analyses: [{ id: 1 }],
        criteria: [{ k: 'v' }],
        phenomena: [{ name: 'x' }],
      });
      expect(out).toContain('interface Analysis {');
      expect(out).toContain('interface Criterion {');
      expect(out).toContain('interface Phenomenon {');
    });

    it('sibling 同构对象应复用同一个 interface', async () => {
      const out = await convertJsonToTypeScript({
        user: { id: 1, name: 'a' },
        admin: { id: 2, name: 'b' },
      });
      // 只生成一个 User，admin 复用之
      expect(out.match(/interface /g)?.length).toBe(2); // User + RootObject
      expect(out).toContain('user?: User;');
      expect(out).toContain('admin?: User;');
    });

    it('单数字段和复数数组同构时应复用同一个 interface', async () => {
      const out = await convertJsonToTypeScript({
        user: { id: 1 },
        users: [{ id: 2 }],
      });
      expect(out.match(/interface /g)?.length).toBe(2);
      expect(out).toContain('user?: User;');
      expect(out).toContain('users?: User[];');
    });

    it('字段类型不同的对象不应被去重', async () => {
      const out = await convertJsonToTypeScript({
        a: { id: 1, name: 'x' },
        b: { id: 2, name: 3 }, // name 是 number
      });
      // a 和 b 结构不同，应生成两个 interface
      expect(out.match(/interface /g)?.length).toBe(3); // A + B + RootObject
    });

    it('不可数名词不应被错误单数化（news/data/series/info）', async () => {
      const out = await convertJsonToTypeScript({
        news: [{ title: 't' }],
        series: [{ id: 1 }],
        info: [{ k: 'v' }],
      });
      // 不应出现 "New" / "Sery" / "Inf"
      expect(out).toContain('interface News {');
      expect(out).toContain('interface Series {');
      expect(out).toContain('interface Info {');
      expect(out).not.toMatch(/interface New\b/);
      expect(out).not.toMatch(/interface Sery\b/);
      expect(out).not.toMatch(/interface Inf\b/);
    });
  });
});
