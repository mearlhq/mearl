// prismjs 1.x 是 UMD/CJS，其语言组件文件（prism-markup、prism-clike 等）首行即
// `Prism.languages.xxx = ...`，依赖一个已存在的全局 `Prism`。在 Vite 7（Rollup +
// @rollup/plugin-commonjs）下这个自由全局引用会被正确改写，但 Vite 8（Rolldown）的
// CJS→ESM interop 不再保证它解析得到，运行时会报 `Prism is not defined`。
//
// 解决办法：在任何语言组件被 import 之前，先把 Prism 显式挂到 globalThis。ESM 保证
// 依赖按 import 顺序求值，因此凡是在导入语言组件前先导入本模块的文件，都能确保全局
// 已就绪。
import Prism from 'prismjs/components/prism-core';

(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export default Prism;
