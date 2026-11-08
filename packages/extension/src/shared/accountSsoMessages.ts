export const ACCOUNT_OFFSCREEN_TARGET = 'mearl-account-offscreen';
export const ACCOUNT_CONSUME_SSO_ACTION = 'accountConsumeSsoTicket';

export interface AccountConsumeSsoRequest {
  target: typeof ACCOUNT_OFFSCREEN_TARGET;
  action: typeof ACCOUNT_CONSUME_SSO_ACTION;
  ssoUrl: string;
}

export interface AccountConsumeSsoResponse {
  success: boolean;
}
