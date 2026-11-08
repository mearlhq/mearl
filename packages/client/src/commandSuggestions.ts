import { distance } from 'fastest-levenshtein';

const MIN_SIMILARITY = 0.5;
const MAX_SCORE_GAP = 0.1;

export interface SuggestableCommand {
  readonly aliases?: readonly string[];
  /** Suggestion-only expressions whose canonical invocation needs a specific payload. */
  readonly aliasExamples?: Readonly<Record<string, string>>;
  readonly description: string;
  readonly examples?: readonly string[];
  readonly name: string;
}

export interface CommandSuggestion {
  command: SuggestableCommand;
  score: number;
  example?: string;
}

function normalizeCommand(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function leadingCommandParts(args: readonly string[]): string[] {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    parts.push(arg);
  }
  return parts;
}

function commandQueries(args: readonly string[]): string[] {
  const parts = leadingCommandParts(args);
  const queries = new Set<string>();
  for (let length = parts.length; length > 0; length -= 1) {
    const query = normalizeCommand(parts.slice(0, length).join('_'));
    if (query) queries.add(query);
  }
  return [...queries];
}

function similarity(left: string, right: string): number {
  const length = Math.max(left.length, right.length);
  return length === 0 ? 0 : (length - distance(left, right)) / length;
}

export function commandInput(args: readonly string[]): string {
  return leadingCommandParts(args).join(' ');
}

export function findCommandSuggestions(
  args: readonly string[],
  commands: readonly SuggestableCommand[],
  limit = 3,
): CommandSuggestion[] {
  const queries = commandQueries(args);
  if (queries.length === 0 || limit <= 0) return [];

  const ranked = commands
    .map(command => {
      const keys: Array<{
        name: string;
        example?: string;
      }> = [command.name, ...(command.aliases ?? [])].map(name => ({ name }));
      for (const [name, example] of Object.entries(command.aliasExamples ?? {})) {
        keys.push({ name, example });
      }
      let score = -1;
      let example: string | undefined;
      for (const key of keys) {
        const candidate = Math.max(
          ...queries.map(query => similarity(query, normalizeCommand(key.name))),
        );
        if (candidate > score) {
          score = candidate;
          example = key.example;
        }
      }
      return { command, score, ...(example ? { example } : {}) };
    })
    .filter(suggestion => suggestion.score >= MIN_SIMILARITY)
    .sort(
      (left, right) =>
        right.score - left.score || left.command.name.localeCompare(right.command.name),
    );
  const bestScore = ranked[0]?.score;
  if (bestScore === undefined) return [];
  return ranked.filter(suggestion => bestScore - suggestion.score <= MAX_SCORE_GAP).slice(0, limit);
}

export function formatCommandSuggestions(
  commandName: string,
  suggestions: readonly CommandSuggestion[],
): string[] {
  return suggestions.map(({ command, example }) => {
    const invocation = example ?? command.examples?.[0] ?? command.name;
    return `  ${commandName} ${invocation}\n    ${command.description}`;
  });
}
