const CLOUD_CONNECTOR_URL_PATTERN = /\b(?!(?:https?|file|data|javascript|chrome):)[a-z][a-z0-9+-]*:\/\/[^\s"']+/i;

/** Accept either a connector URL or the full command copied from a cloud Agent. */
export const extractCloudConnectorUrl = (value: string): string => {
  const match = value.match(CLOUD_CONNECTOR_URL_PATTERN);
  return match ? match[0] : value;
};
