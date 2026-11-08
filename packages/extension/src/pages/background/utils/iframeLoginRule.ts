export function iframeLoginRule(id: number, urlFilter: string): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 10,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        'X-Frame-Options',
        'Content-Security-Policy',
        'Content-Security-Policy-Report-Only',
      ].map(header => ({ header, operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE })),
    },
    condition: {
      urlFilter,
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
        chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
      ],
    },
  };
}
