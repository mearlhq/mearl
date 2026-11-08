import { useEffect, useRef, useState } from 'react';
import { chatVisualizationCdn } from '../../../shared/chatVisualizationCdn';
import { t } from '../../panel/utils/i18n';
import { requestNativeHost } from '../nativeHostRequest';

interface VisualizationReference {
  path: string;
  title?: string;
}

const INITIAL_VISUALIZATION_HEIGHT = 'clamp(180px, 42cqw, 280px)';
const MIN_VISUALIZATION_HEIGHT = 32;
const MAX_VISUALIZATION_HEIGHT = 640;
const VISUALIZATION_LOAD_TIMEOUT_MS = 15_000;

export function parseChatVisualization(line: string): VisualizationReference | null {
  const match = /^\s*\uE200visualize\uE202([^\n]+)\uE201\s*$/u.exec(line);
  if (!match) return null;
  try {
    const reference = JSON.parse(match[1]!);
    if (typeof reference?.path !== 'string' || !reference.path) return null;
    return {
      path: reference.path,
      title: typeof reference.title === 'string' ? reference.title.trim().slice(0, 160) : undefined,
    };
  } catch {
    return null;
  }
}

function visualizationDocument(html: string): string {
  const { scripts, styles, fonts } = chatVisualizationCdn;
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${scripts}; style-src 'unsafe-inline' ${styles}; img-src data: blob:; media-src data: blob:; font-src data: ${fonts}; base-uri 'none'; form-action 'none'">
<style>
:root {
  color-scheme: light dark;
  --font-size-base: 13px;
  --background: #f8f9fa;
  --foreground: #2c2c2c;
  --card: #fff;
  --card-foreground: var(--foreground);
  --popover: var(--card);
  --popover-foreground: var(--foreground);
  --muted: #e9ecef;
  --muted-foreground: #60636b;
  --primary: var(--foreground);
  --primary-foreground: var(--background);
  --secondary: var(--muted);
  --secondary-foreground: var(--foreground);
  --accent: var(--muted);
  --accent-foreground: var(--foreground);
  --border: #d6d9df;
  --input: var(--border);
  --ring: var(--blue);
  --blue: #2563eb;
  --orange: #c2410c;
  --green: #15803d;
  --red: #b91c1c;
  --purple: #7e22ce;
  --yellow: #a16207;
  --destructive: var(--red);
  --viz-series-1: var(--blue);
  --viz-series-2: var(--orange);
  --viz-series-3: var(--green);
  --viz-series-4: var(--purple);
  --viz-series-5: var(--red);
  --viz-series-6: var(--yellow);
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #1a1a1a;
    --foreground: #e4e4e7;
    --card: #242424;
    --muted: #2b2b2e;
    --muted-foreground: #a1a1aa;
    --border: #3c3c42;
    --blue: #60a5fa;
    --orange: #fb923c;
    --green: #4ade80;
    --red: #f87171;
    --purple: #c084fc;
    --yellow: #facc15;
  }
}
*, *::before, *::after { box-sizing: border-box }
body { display: flow-root; margin: 0; color: var(--foreground); font: var(--font-size-base)/1.5 system-ui, sans-serif }
h1, h2, h3, p { margin: 0 }
h1, h2, h3 { font-weight: 500 }
h1 { font-size: 1.4em } h2 { font-size: 1.2em } h3 { font-size: 1.1em }
.text-small { font-size: 0.875em }
.text-muted { color: var(--muted-foreground) }
.tabular-nums { font-variant-numeric: tabular-nums }
</style></head><body>
<script>
(() => {
  let previousHeight;
  const report = () => {
    const { width, height } = document.body.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const nextHeight = Math.min(${MAX_VISUALIZATION_HEIGHT}, Math.max(${MIN_VISUALIZATION_HEIGHT}, Math.ceil(height)));
    if (nextHeight === previousHeight) return;
    previousHeight = nextHeight;
    parent.postMessage({ type: 'mearl-chat-visualization-size', height: nextHeight }, '*');
  };
  new ResizeObserver(report).observe(document.body);
  document.addEventListener('DOMContentLoaded', report, { once: true });
  addEventListener('load', report, { once: true });
})();
</script>${html}</body></html>`;
}

export function ChatVisualization({ path, title }: VisualizationReference) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [result, setResult] = useState<{ html: string } | null>();
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    requestNativeHost('agent_chat_read_visualization', { path }).then(
      value => {
        if (active) setResult(value);
      },
      () => {
        if (active) setResult(null);
      },
    );
    return () => {
      active = false;
    };
  }, [path]);

  useEffect(() => {
    if (!result || height !== null) return;
    const timeout = setTimeout(() => setResult(null), VISUALIZATION_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [result, height]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = event.data;
      if (
        message?.type === 'mearl-chat-visualization-size' &&
        Number.isFinite(message.height) &&
        message.height > 0
      ) {
        setHeight(
          Math.min(MAX_VISUALIZATION_HEIGHT, Math.max(MIN_VISUALIZATION_HEIGHT, message.height)),
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div
      data-chat-visualization
      className="relative my-2 min-w-0 first:mt-0 last:mb-0"
      style={result === null ? undefined : { height: height ?? INITIAL_VISUALIZATION_HEIGHT }}
    >
      {result && (
        <iframe
          ref={frame}
          title={title || t('agentChatVisualization')}
          src={chrome.runtime.getURL('plugin/visualization.html')}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          aria-hidden={height === null}
          tabIndex={height === null ? -1 : undefined}
          className={`block h-full w-full border-0${height === null ? ' pointer-events-none' : ''}`}
          onLoad={() =>
            frame.current?.contentWindow?.postMessage(
              { type: 'mearl-plugin-load', html: visualizationDocument(result.html) },
              '*',
            )
          }
        />
      )}
      {result === null ? (
        <p role="status" className="rounded-md border border-border px-2 py-1 text-text-secondary">
          {t('agentChatVisualizationUnavailable')}
        </p>
      ) : height === null ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center bg-bg-secondary text-text-secondary"
        >
          {t('agentChatVisualizationLoading')}
        </p>
      ) : null}
    </div>
  );
}
