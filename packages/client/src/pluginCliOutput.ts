/** CLI host commands share the SDK error code without exporting arbitrary error metadata. */
export function writePluginCliError(error: unknown): void {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PLUGIN_HOST_ERROR';
  process.stderr.write(
    `${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`,
  );
}
