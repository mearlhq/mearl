const SELECTED_ELEMENT_EVAL_ERROR_KEY = '__mearlError';
const COLLECTOR_NAME = '__mearl_collectElement';

const COLLECTOR_NOT_AVAILABLE_MESSAGE =
  'Mearl content script is not available on this page. Grant host permission for this domain and retry.';

const UNSUPPORTED_PAGE_MESSAGE =
  'Mearl cannot inspect this page type. Switch to a regular http(s) page and retry.';

function stringifyValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}' && json !== '[]') return json;
    } catch {
      return null;
    }
  }

  return null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function buildGetSelectedElementScript(includeOuterHTML = true): string {
  const collectorName = JSON.stringify(COLLECTOR_NAME);
  const includeOuterHTMLValue = JSON.stringify(includeOuterHTML);
  const collectorMissingMessage = JSON.stringify(COLLECTOR_NOT_AVAILABLE_MESSAGE);
  const unsupportedPageMessage = JSON.stringify(UNSUPPORTED_PAGE_MESSAGE);

  return `(() => {
    const el = $0;
    if (!el) return null;

    const collector = window[${collectorName}];
    if (typeof collector !== 'function') {
      let host = '';
      let origin = '';
      let protocol = '';
      try {
        host = location.hostname || '';
        origin = location.origin || '';
        protocol = location.protocol || '';
      } catch {
        // ignored
      }

      return {
        ${SELECTED_ELEMENT_EVAL_ERROR_KEY}: {
          code: 'COLLECTOR_NOT_AVAILABLE',
          host,
          origin,
          protocol,
          message: protocol === 'http:' || protocol === 'https:'
            ? ${collectorMissingMessage}
            : ${unsupportedPageMessage},
        },
      };
    }

    return collector(el, ${includeOuterHTMLValue});
  })()`;
}

export function extractSelectedElementEvalError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;

  const maybeError = (result as Record<string, unknown>)[SELECTED_ELEMENT_EVAL_ERROR_KEY];
  if (!maybeError || typeof maybeError !== 'object') return null;

  const error = maybeError as Record<string, unknown>;
  const message = readString(error, 'message') || 'Failed to get selected element.';
  const host = readString(error, 'host');
  const origin = readString(error, 'origin');

  if (host) return `${message} Current host: ${host}.`;
  if (origin && origin !== 'null') return `${message} Current origin: ${origin}.`;
  return message;
}

export function formatInspectedWindowEvalException(exception: unknown): string {
  if (!exception) return 'Unknown inspectedWindow.eval error';

  if (exception instanceof Error && exception.message.trim()) {
    return exception.message;
  }

  if (typeof exception === 'object') {
    const record = exception as Record<string, unknown>;
    for (const key of ['description', 'message', 'value', 'details', 'code']) {
      const formatted = stringifyValue(record[key]);
      if (formatted) return formatted;
    }
  }

  return stringifyValue(exception) || String(exception);
}
