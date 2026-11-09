export function browserDomainPermissionError(url: URL): string {
  return `Browser domain permission required: ${url.hostname}`;
}

export function browserHostPermissionError(url: URL): string {
  return `Browser host permission required: ${url.origin}`;
}

export function accountPermissionUrl(loginUrl: string | undefined, error: string): URL | undefined {
  if (!loginUrl || !error) return;
  const url = new URL(loginUrl);
  if (error === browserDomainPermissionError(url) || error === browserHostPermissionError(url))
    return url;
}
