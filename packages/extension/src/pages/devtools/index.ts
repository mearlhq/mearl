import {
  buildGetSelectedElementScript,
  extractSelectedElementEvalError,
  formatInspectedWindowEvalException,
} from '../shared/selectedElementEval';

// 创建 DevTools 面板
chrome.devtools.panels.create(
  'Mearl',
  'icons/panel-icon.svg',
  'src/pages/panel/index.html',
  function () {
    console.log('Mearl panel created');
  },
);

// ==================== DevTools Page Agent Bridge ====================
// 通过长连接向 background 注册 devtools-page 端口，
// 使 page_inspect selector "$0" 无需打开 Mearl 标签即可读取 Elements 当前选区。

const tabId = chrome.devtools.inspectedWindow.tabId;
const devtoolsPagePort = chrome.runtime.connect({ name: `devtools-page-${tabId}` });

devtoolsPagePort.onMessage.addListener(async (message: any) => {
  if (message.action !== 'agentQuery') return;

  const { correlationId, query } = message;

  if (query?.type !== 'getSelectedElement') {
    // This port only handles getSelectedElement; other query types require the Mearl panel tab.
    chrome.runtime
      .sendMessage({
        action: 'agentQueryResponse',
        correlationId,
        data: {
          error: `Query type '${query?.type}' requires the Mearl panel tab to be open in DevTools.`,
        },
      })
      .catch(() => {});
    return;
  }
  const includeOuterHTML = query.includeOuterHTML !== false;

  try {
    const result = await new Promise<any>((resolve, reject) => {
      const script = buildGetSelectedElementScript(includeOuterHTML);

      chrome.devtools.inspectedWindow.eval(script, (res: any, exception: any) => {
        if (exception) {
          reject(new Error(formatInspectedWindowEvalException(exception)));
        } else if (res === null) {
          reject(
            new Error('No element selected. Please select an element in the Elements panel first.'),
          );
        } else {
          const evalError = extractSelectedElementEvalError(res);
          if (evalError) {
            reject(new Error(evalError));
            return;
          }
          resolve(res);
        }
      });
    });

    chrome.runtime
      .sendMessage({ action: 'agentQueryResponse', correlationId, data: result })
      .catch(() => {});
  } catch (err) {
    chrome.runtime
      .sendMessage({
        action: 'agentQueryResponse',
        correlationId,
        data: { error: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => {});
  }
});
