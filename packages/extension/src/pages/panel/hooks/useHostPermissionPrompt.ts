import { useCallback, useEffect, useState } from 'react';

const HOST_PERMISSION_DISMISSED_KEY = 'mearl-dismissed-host-permission';

function evalInPage<T>(expression: string): Promise<T | null> {
  return new Promise(resolve => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo) {
        resolve(null);
        return;
      }
      resolve((result as T) ?? null);
    });
  });
}

async function getInspectedHostState(): Promise<{ host: string; dismissed: boolean } | null> {
  const keyLiteral = JSON.stringify(HOST_PERMISSION_DISMISSED_KEY);
  const script = `(() => {
    try {
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
      const host = location.hostname || '';
      if (!host) return null;
      const dismissed = sessionStorage.getItem(${keyLiteral}) === '1';
      return { host, dismissed };
    } catch {
      return null;
    }
  })()`;
  return await evalInPage<{ host: string; dismissed: boolean }>(script);
}

async function markHostPromptDismissedOnPage(): Promise<void> {
  const keyLiteral = JSON.stringify(HOST_PERMISSION_DISMISSED_KEY);
  const script = `(() => {
    try {
      sessionStorage.setItem(${keyLiteral}, '1');
      return true;
    } catch {
      return false;
    }
  })()`;
  await evalInPage<boolean>(script);
}

/**
 * 倒数第二段如果是这些"类别前缀"，说明最后两段是公共后缀（如 .com.hk、.co.uk），
 * 需要多取一段才能拿到真正的根域名。
 */
const CATEGORY_PREFIXES = new Set(['com', 'co', 'net', 'org', 'edu', 'gov', 'ac', 'mil']);

/**
 * 将具体的 hostname 转为通配符根域名，例如：
 *   pre-edith.reader.cn     →  *.reader.cn
 *   www.example.com         →  *.example.com
 *   pre-us.example.com.hk   →  *.example.com.hk
 *   www.example.co.uk       →  *.example.co.uk
 *   example.com             →  example.com  (无子域名，不加通配符)
 */
export function getWildcardHost(host: string): string {
  const parts = host.split('.');
  // 如果倒数第二段是类别前缀（com/co/edu/gov…），则最后两段是公共后缀
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : '';
  const rootSegments = CATEGORY_PREFIXES.has(secondLast) ? 3 : 2;

  if (parts.length > rootSegments) {
    return `*.${parts.slice(-rootSegments).join('.')}`;
  }
  return host;
}

function containsOrigin(origin: string): Promise<boolean> {
  return new Promise(resolve => {
    chrome.permissions.contains({ origins: [origin] }, granted => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

function requestOrigin(origin: string): Promise<boolean> {
  return new Promise(resolve => {
    chrome.permissions.request({ origins: [origin] }, granted => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

export function useHostPermissionPrompt(tabId: number | null) {
  const [currentHost, setCurrentHost] = useState<string>('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [granting, setGranting] = useState(false);

  const refreshPermissionStatus = useCallback(async () => {
    if (!tabId || !chrome.devtools?.inspectedWindow) {
      setCurrentHost('');
      setNeedsPermission(false);
      return;
    }

    const hostState = await getInspectedHostState();
    if (!hostState) {
      setCurrentHost('');
      setNeedsPermission(false);
      return;
    }

    const { host, dismissed } = hostState;
    const wildcardHost = getWildcardHost(host);
    const granted = await containsOrigin(`*://${wildcardHost}/*`);
    setCurrentHost(wildcardHost);
    setNeedsPermission(!granted && !dismissed);
  }, [tabId]);

  useEffect(() => {
    void refreshPermissionStatus();
  }, [refreshPermissionStatus]);

  useEffect(() => {
    if (!chrome.devtools?.network) return;
    const handleNavigated = () => {
      void refreshPermissionStatus();
    };

    chrome.devtools.network.onNavigated.addListener(handleNavigated);
    return () => {
      chrome.devtools.network.onNavigated.removeListener(handleNavigated);
    };
  }, [refreshPermissionStatus]);

  const grantCurrentHostPermission = useCallback(async () => {
    if (!currentHost || granting) return false;

    setGranting(true);
    try {
      const granted = await requestOrigin(`*://${currentHost}/*`);
      await refreshPermissionStatus();
      return granted;
    } finally {
      setGranting(false);
    }
  }, [currentHost, granting, refreshPermissionStatus]);

  const dismissCurrentHostPrompt = useCallback(() => {
    if (!currentHost) return;
    setNeedsPermission(false);
    void markHostPromptDismissedOnPage();
  }, [currentHost]);

  return {
    currentHost,
    needsPermission,
    grantCurrentHostPermission,
    dismissCurrentHostPrompt,
  };
}
