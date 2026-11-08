/**
 * 判断值是否为原始类型
 */
export const isPrimitive = (val: any): boolean => {
  return val === null || ['string', 'number', 'boolean'].includes(typeof val);
};

/**
 * 判断值是否可展开
 */
export const isExpandable = (val: any): boolean => {
  return val !== null && (Array.isArray(val) || typeof val === 'object');
};

/**
 * 获取值的类型
 */
export const getValueType = (val: any): string => {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
};

/**
 * 估算值的序列化长度
 */
const estimateValueLength = (value: any): number => {
  if (typeof value === 'string') {
    return value.length + 2; // "value"
  }
  return String(value).length; // number/boolean/null
};

/**
 * 判断对象或数组是否适合紧凑展示（一行展示）
 * - 对象：空对象或属性少于5个，都是基础类型，且总长度不超过90个字符
 * - 数组：空数组或元素少于3个，都是基础类型，且总长度不超过90个字符
 */
export const isCompactable = (val: any): boolean => {
  if (typeof val !== 'object' || val === null) return false;

  // 处理数组
  if (Array.isArray(val)) {
    // 空数组可以紧凑展示
    if (val.length === 0) return true;
    if (val.length >= 3) return false;
    if (!val.every(item => isPrimitive(item))) return false;

    const length = 2 + val.reduce((sum, item) => sum + estimateValueLength(item) + 2, 0);
    return length <= 90;
  }

  // 处理对象
  const entries = Object.entries(val);
  // 空对象可以紧凑展示
  if (entries.length === 0) return true;
  if (entries.length >= 5) return false;
  if (!entries.every(([_, value]) => isPrimitive(value))) return false;

  const length =
    2 +
    entries.reduce((sum, [key, value]) => sum + key.length + 4 + estimateValueLength(value) + 2, 0);
  return length <= 90;
};

/**
 * 获取紧凑格式的 JSON 字符串
 */
export const getCompactJson = (val: any): string => {
  const json = JSON.stringify(val, null, 0);
  if (Array.isArray(val)) {
    // 空数组直接返回 []
    if (val.length === 0) return '[]';
    return json.replace(/^\[/, '[ ').replace(/\]$/, ' ]').replace(/,/g, ', ');
  }
  // 空对象直接返回 {}
  if (Object.keys(val).length === 0) return '{}';
  return json.replace(/^{/, '{ ').replace(/}$/, ' }').replace(/:/g, ': ').replace(/,/g, ', ');
};

/**
 * 获取预览文本
 * 如果对象或数组符合紧凑展示条件，返回紧凑的 JSON；否则返回简单预览
 */
export const getPreview = (val: any): string => {
  if (Array.isArray(val)) {
    // 如果数组适合紧凑展示，返回紧凑 JSON
    if (isCompactable(val)) {
      return getCompactJson(val);
    }
    return `Array(${val.length})`;
  }
  if (typeof val === 'object' && val !== null) {
    // 如果对象适合紧凑展示，返回紧凑 JSON
    if (isCompactable(val)) {
      return getCompactJson(val);
    }
    const keys = Object.keys(val);
    return `Object(${keys.length})`;
  }
  return '';
};

/**
 * 将字段名转换为大驼峰（PascalCase）
 * @param str - 字段名
 * @returns 大驼峰格式的字段名
 */
const toPascalCase = (str: string): string => {
  return str
    .replace(/[_-](.)/g, (_, char) => char.toUpperCase())
    .replace(/^(.)/, char => char.toUpperCase());
};

const isPlainObject = (v: any): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const sanitizeKey = (key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`;

// 不规则复数 + 不可数名词白名单（避免 `news → New`、`analyses → Analys` 这种明显错误）
// key 用小写匹配，value 是单数形式
const IRREGULAR_SINGULARS: Record<string, string> = {
  // 不规则复数
  mice: 'mouse',
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  geese: 'goose',
  oxen: 'ox',
  // 拉丁/希腊词
  analyses: 'analysis',
  diagnoses: 'diagnosis',
  hypotheses: 'hypothesis',
  parentheses: 'parenthesis',
  theses: 'thesis',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  indices: 'index',
  matrices: 'matrix',
  vertices: 'vertex',
  // 不可数 / 单复同形
  data: 'data',
  news: 'news',
  series: 'series',
  species: 'species',
  fish: 'fish',
  sheep: 'sheep',
  deer: 'deer',
  info: 'info',
  metadata: 'metadata',
};

const singularize = (name: string): string => {
  const lower = name.toLowerCase();
  const irregular = IRREGULAR_SINGULARS[lower];
  if (irregular) {
    // 保留原始首字母大小写
    return name[0] === name[0].toUpperCase()
      ? irregular[0].toUpperCase() + irregular.slice(1)
      : irregular;
  }
  if (name.endsWith('ies') && name.length > 3) return name.slice(0, -3) + 'y';
  if (
    name.endsWith('ses') ||
    name.endsWith('xes') ||
    name.endsWith('ches') ||
    name.endsWith('shes')
  ) {
    return name.slice(0, -2);
  }
  if (name.endsWith('s') && !name.endsWith('ss') && name.length > 1) return name.slice(0, -1);
  return name;
};

/**
 * 将 JSON 数据转换为一组 TS interface 字符串
 * - 字段全部标记为可选（`?:`）
 * - 输出顺序：依赖在前、根接口在后
 * - 数组元素如果是对象，会合并所有元素的字段（取每个字段出现过的类型并集）
 */
const buildInterfaces = (data: any, rootName: string): string[] => {
  if (!isPlainObject(data) && !Array.isArray(data)) {
    throw new Error('Only (Object) and (Array) are supported');
  }

  const interfaces: string[] = [];
  const usedNames = new Set<string>();
  // 结构 hash → interface 名，命中即复用（避免 sibling 同构对象重复生成）
  const structureCache = new Map<string, string>();

  const reserveName = (base: string): string => {
    const fallback = base || 'RootObject';
    let name = fallback;
    let i = 2;
    while (usedNames.has(name)) name = `${fallback}${i++}`;
    usedNames.add(name);
    return name;
  };

  const hashProps = (props: { key: string; type: string }[]): string =>
    props
      .slice()
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(p => `${p.key}::${p.type}`)
      .join('|');

  const emitInterface = (props: { key: string; type: string }[], contextName: string): string => {
    const hash = hashProps(props);
    const cached = structureCache.get(hash);
    if (cached) return cached;

    const name = reserveName(toPascalCase(contextName) || 'RootObject');
    const body = props.map(p => `  ${sanitizeKey(p.key)}?: ${p.type};`).join('\n');
    interfaces.push(body ? `interface ${name} {\n${body}\n}` : `interface ${name} {}`);
    structureCache.set(hash, name);
    return name;
  };

  const arrayType = (arr: any[], contextName: string): string => {
    if (arr.length === 0) return 'any[]';
    const elementName = singularize(contextName);
    const types = new Set<string>();

    const objects = arr.filter(isPlainObject);
    if (objects.length) {
      const fields = new Map<string, Set<string>>();
      for (const obj of objects) {
        for (const [k, v] of Object.entries(obj)) {
          if (!fields.has(k)) fields.set(k, new Set());
          fields.get(k)!.add(typeOf(v, k));
        }
      }
      const props = [...fields.entries()].map(([k, ts]) => ({
        key: k,
        type: ts.size === 1 ? [...ts][0] : [...ts].join(' | '),
      }));
      types.add(emitInterface(props, elementName || 'Item'));
    }

    for (const item of arr) {
      if (!isPlainObject(item)) types.add(typeOf(item, elementName));
    }

    const ts = [...types];
    return ts.length === 1 ? `${ts[0]}[]` : `(${ts.join(' | ')})[]`;
  };

  const objectType = (obj: Record<string, any>, contextName: string): string => {
    const props = Object.entries(obj).map(([k, v]) => ({
      key: k,
      type: typeOf(v, k),
    }));
    return emitInterface(props, contextName);
  };

  const typeOf = (value: any, contextName: string): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return arrayType(value, contextName);
    if (typeof value === 'object') return objectType(value, contextName);
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'any';
  };

  typeOf(data, rootName);
  return interfaces;
};

/**
 * 将 JSON 数据转换为 TypeScript 类型定义
 * @param data - JSON 数据
 * @param name - 当前字段名
 * @param path - 父路径数组
 * @returns 格式化后的 TypeScript 类型定义字符串
 */
export const convertJsonToTypeScript = async (
  data: any,
  name?: string | number,
  path: (string | number)[] = [],
): Promise<string> => {
  // 生成合理的类型名称
  let rootName = 'RootObject';

  if (name !== undefined) {
    const nameStr = name.toString();

    // 检查是否是数组索引（纯数字）
    const isArrayIndex = /^\d+$/.test(nameStr);

    if (isArrayIndex) {
      // 从 path 中找到最后一个非数字的字段名
      let found = false;
      for (let i = path.length - 1; i >= 0; i--) {
        const pathItem = path[i].toString();
        if (!/^\d+$/.test(pathItem)) {
          // 找到了非数字的字段名
          let baseName = toPascalCase(pathItem);

          // 简单的单数化处理
          if (baseName.endsWith('ies')) {
            // entries -> Entry, categories -> Category
            baseName = baseName.slice(0, -3) + 'y';
          } else if (
            baseName.endsWith('ses') ||
            baseName.endsWith('xes') ||
            baseName.endsWith('ches') ||
            baseName.endsWith('shes')
          ) {
            // classes -> Class, boxes -> Box, branches -> Branch
            baseName = baseName.slice(0, -2);
          } else if (baseName.endsWith('s') && !baseName.endsWith('ss')) {
            // items -> Item, users -> User (但 class -> class)
            baseName = baseName.slice(0, -1);
          }

          // 如果已经包含 Item 后缀，直接使用
          if (baseName.endsWith('Item')) {
            rootName = baseName;
          } else {
            rootName = `${baseName}Item`;
          }

          found = true;
          break;
        }
      }

      // 如果整个链路都是数字（纯数组嵌套），使用默认名称
      if (!found) {
        rootName = 'ArrayItem';
      }
    } else {
      // 普通字段名，直接转换
      rootName = toPascalCase(nameStr);
    }
  }

  // 基础类型（非对象/数组）直接输出 type 别名，兼容叶子节点
  if (!isPlainObject(data) && !Array.isArray(data)) {
    const primitiveType =
      data === null
        ? 'null'
        : typeof data === 'string'
          ? 'string'
          : typeof data === 'number'
            ? 'number'
            : typeof data === 'boolean'
              ? 'boolean'
              : 'any';
    return `type ${rootName} = ${primitiveType};`;
  }

  // buildInterfaces 已经按 "依赖在前、根接口在后" 的顺序输出
  return buildInterfaces(data, rootName).join('\n\n');
};
