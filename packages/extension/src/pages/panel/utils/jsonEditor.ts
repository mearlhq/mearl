import { formatJson } from './helpers';

interface ParseJsonTextOptions {
  includeErrorPrefix?: boolean;
}

export const formatJsonForEditor = (data: any): string => formatJson(data);

export const parseJsonTextForEditor = (
  text: string,
  invalidJsonMessage: string,
  options: ParseJsonTextOptions = {},
): { parsed?: any; error?: string } => {
  try {
    return { parsed: JSON.parse(text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : invalidJsonMessage;
    return {
      error: options.includeErrorPrefix ? `${invalidJsonMessage}: ${detail}` : detail,
    };
  }
};
