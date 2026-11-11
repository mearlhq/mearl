const PREACT_RUNTIME_ASSET = 'plugin/toolbox-preact-runtime.js';
const BRIDGE_SCRIPT_TAG = '<script data-mearl-bridge>';

let preactRuntimeSource: Promise<string> | null = null;

async function loadPreactRuntimeSource(): Promise<string> {
  if (!preactRuntimeSource) {
    preactRuntimeSource = fetch(chrome.runtime.getURL(PREACT_RUNTIME_ASSET))
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Toolbox Preact runtime returned ${response.status}`);
        }
        return response.text();
      })
      .catch(error => {
        preactRuntimeSource = null;
        throw error;
      });
  }
  return preactRuntimeSource;
}

function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

export function preloadToolboxUiRuntime(): void {
  // Preparation reports errors and retries a failed speculative load.
  void loadPreactRuntimeSource().catch(() => {});
}

export async function prepareToolboxPageHtml(html: string, runtime: unknown): Promise<string> {
  if (runtime === undefined) return html;
  if (runtime !== 'preact') {
    throw new Error(`Unsupported toolbox page runtime: ${String(runtime)}`);
  }

  const bridgeIndex = html.indexOf(BRIDGE_SCRIPT_TAG);
  if (bridgeIndex === -1) {
    throw new Error('Toolbox page must be registered again before using the Preact runtime');
  }
  const source = await loadPreactRuntimeSource();
  const runtimeScript = `<script data-mearl-runtime="preact">${inlineScript(source)}</script>`;
  return `${html.slice(0, bridgeIndex)}${runtimeScript}${html.slice(bridgeIndex)}`;
}
