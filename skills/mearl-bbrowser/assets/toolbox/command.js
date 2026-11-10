(() => {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const word = value => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : quote(value);
  window.bbrowserCommand = (adapter, values, tab) => {
    const args = Object.fromEntries(Object.keys(adapter.args).filter(key => values[key] !== undefined && values[key] !== '').map(key => [key, values[key]]));
    const input = { tokens: ['run', adapter.file], args, ...(tab ? { tab: Number(tab) } : {}) };
    const keys = Object.keys(adapter.args), filled = Object.keys(args);
    const positional = filled.every((key, index) => key === keys[index] && !String(args[key]).startsWith('-'));
    const simpleName = !adapter.name.startsWith('-') && !['list', 'search', 'info', 'update', 'run'].includes(adapter.name);
    const text = positional && simpleName
      ? ['mearl bbrowser site', word(adapter.name), ...filled.map(key => word(String(args[key]))), ...(tab ? ['--tab', String(Number(tab))] : [])].join(' ')
      : `mearl bbrowser --payload ${quote(JSON.stringify({ command: 'site', input: { ...input, tokens: ['run', adapter.name] } }))}`;
    return { input, text };
  };
})();
