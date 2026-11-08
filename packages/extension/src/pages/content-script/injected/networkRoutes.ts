// A private module instance keeps this classic script self-contained across multi-entry builds.
import { decodeNetworkRoutePlan } from '@mearl/preset/networkRoutes?classic';
import type { NetworkRoutePlan } from '@mearl/preset/networkRoutes';
export function readInjectedNetworkRoutes(description: string): NetworkRoutePlan | undefined {
  try { return decodeNetworkRoutePlan(description); } catch { return undefined; }
}
function makeRewriter(plan: NetworkRoutePlan): (url: string) => string {
  const rules = plan.routes.map(({ fromHost, toHost }) => ({
    sourceHost: fromHost, targetHost: toHost,
    re: new RegExp('//' + fromHost.replace(/\./g, '\\.') + '(?=[/:?#]|$)', 'i'),
  }));
  return (url: string) => {
    if (typeof url !== 'string') return url;
    for (const { sourceHost, targetHost, re } of rules) {
      if (!url.includes(sourceHost)) continue;
      const rewritten = url.replace(re, '//' + targetHost);
      if (rewritten !== url) return rewritten;
    }
    return url;
  };
}
export function installNetworkRoutes(plan: NetworkRoutePlan): void {
  const rewrite = makeRewriter(plan);

  // ── fetch ──
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          const u = String(input);
          const r = rewrite(u);
          if (r !== u) return origFetch.call(this, r, init);
        } else if (input instanceof Request) {
          const r = rewrite(input.url);
          if (r !== input.url) return origFetch.call(this, new Request(r, input), init);
        }
      } catch {
        // 改写出错则原样放行
      }
      return origFetch.call(this, input as RequestInfo, init);
    };
  }

  // ── XMLHttpRequest ──
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      if (typeof url === 'string' || url instanceof URL) {
        const u = String(url);
        const r = rewrite(u);
        if (r !== u) {
          return (origOpen as (...args: unknown[]) => void).call(this, method, r, ...rest);
        }
      }
    } catch {
      // 改写出错则原样放行
    }
    return (origOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  };

  // ── JSONP <script> ──
  // JSONP 通过动态 script 发起请求，不经过 fetch/XHR。
  // 同时覆盖属性赋值和 setAttribute，以兼容常见的两种 JSONP 脚本创建方式。
  const scriptSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (scriptSrcDescriptor?.set) {
    const origScriptSrcSetter = scriptSrcDescriptor.set;
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      ...scriptSrcDescriptor,
      set(this: HTMLScriptElement, value: string) {
        try {
          if (typeof value === 'string') {
            const rewritten = rewrite(value);
            if (rewritten !== value) {
              origScriptSrcSetter.call(this, rewritten);
              return;
            }
          }
        } catch {
          // 改写出错则原样放行
        }
        origScriptSrcSetter.call(this, value);
      },
    });
  }

  const origScriptSetAttribute = HTMLScriptElement.prototype.setAttribute;
  Object.defineProperty(HTMLScriptElement.prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: HTMLScriptElement, name: string, value: string) {
      try {
        if (name.toLowerCase() === 'src' && typeof value === 'string') {
          const rewritten = rewrite(value);
          if (rewritten !== value) {
            origScriptSetAttribute.call(this, name, rewritten);
            return;
          }
        }
      } catch {
        // 改写出错则原样放行
      }
      origScriptSetAttribute.call(this, name, value);
    },
  });
}
