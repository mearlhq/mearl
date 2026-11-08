import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function run(entry, args, input) {
  const result = spawnSync(process.execPath, [join(root, 'packages', entry), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${entry}: ${result.stderr || result.stdout}`);
  return result;
}

for (const [name, entry] of [
  ['client', 'client/dist/bin.js'],
  ['setup', 'setup/dist/bin.js'],
  ['native-host', 'native-host/dist/index.js'],
  ['mcp-server', 'mcp-server/dist/index.js'],
  ['cloud-server', 'cloud/cloud-server/dist/cli.js'],
  ['cloud-connector', 'cloud/cloud-connector/dist/cli.js'],
  ['plugin-qoder', 'plugin-qoder/dist/cli.js'],
]) {
  const help = run(entry, ['--help']);
  assert.match(help.stdout + help.stderr, /(?:用法|Usage)/);
  const reported = run(entry, ['--version']);
  assert.equal((reported.stdout || reported.stderr).trim(), version);
  console.log(`PASS ${name} CLI on Node ${process.versions.node}`);
}

const result = run('client/dist/bin.js', ['run'], `
  console.log(JSON.stringify({ node: process.versions.node, help: await mearl.help('tabList') }));
`);
const output = JSON.parse(result.stdout);
assert.equal(output.node, process.versions.node);
assert.match(output.help, /tab_list/);
console.log(`PASS script worker and injected SDK on Node ${process.versions.node}`);

const guide = run('client/dist/bin.js', ['guide']);
assert.match(guide.stdout, new RegExp(`CLI ${version.replaceAll('.', '\\.')} · core`));
assert.match(guide.stdout, /\[mearl:guide\] end core/);
const topics = run('client/dist/bin.js', ['guide', '--list']);
assert.match(topics.stdout, /environment/);
console.log(`PASS packaged runtime guide on Node ${process.versions.node}`);
