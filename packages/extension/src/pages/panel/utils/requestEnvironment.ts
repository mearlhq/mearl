import { t } from './i18n';

export type RequestEnvironment = string;

export interface RequestEnvironmentInfo {
  environment: RequestEnvironment;
  host: string;
}

export const REQUEST_ENV_LABELS: Record<RequestEnvironment, string> = {
  get prod() {
    return t('requestEnvironmentProd');
  },
  get pre() {
    return t('requestEnvironmentPreRelease');
  },
  get unknown() {
    return t('requestEnvironmentUnknown');
  },
};

/** Environment is supplied by the installed protocol; the host never guesses from domains. */
export function detectRequestEnvironment(inputUrl: string, environment: RequestEnvironment = 'unknown'): RequestEnvironmentInfo {
  try { return { environment, host: new URL(inputUrl).hostname.toLowerCase() }; }
  catch { return { environment: 'unknown', host: '' }; }
}
