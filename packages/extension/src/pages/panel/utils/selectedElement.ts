/**
 * 获取 DevTools Elements 面板当前选中元素（$0）的信息。
 *
 * 采集与处理逻辑位于 content-script/injected/collectElement.ts，
 * 由 early-inject 在页面 MAIN world 挂载为 window.__mearl_collectElement。
 * 这里通过 inspectedWindow.eval 传入 $0 发起调用，直接返回结构化结果。
 */

import type { ElementInfo } from '../../content-script/injected/collectElement';
import {
  buildGetSelectedElementScript,
  extractSelectedElementEvalError,
  formatInspectedWindowEvalException,
} from '../../shared/selectedElementEval';

/** 对 inspectedWindow.eval 的类型安全 Promise 封装 */
function evalInInspectedWindow(script: string): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(script, (result: any, exception: any) => {
      if (exception) {
        reject(new Error(formatInspectedWindowEvalException(exception)));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * 获取 Elements 面板当前选中元素的详细信息。
 * @param includeOuterHTML 是否包含 outerHTML（最多 3000 字符），默认 true
 */
export async function getInspectedSelectedElement(includeOuterHTML = true): Promise<ElementInfo> {
  const result: ElementInfo | null | unknown = await evalInInspectedWindow(
    buildGetSelectedElementScript(includeOuterHTML),
  );

  const evalError = extractSelectedElementEvalError(result);
  if (evalError) {
    throw new Error(evalError);
  }

  if (result === null) {
    throw new Error('No element selected. Please select an element in the Elements panel first.');
  }

  return result as ElementInfo;
}
