import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function directories(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(directory, entry.name));
}

export function createLinkPlan({ root = projectRoot, prefix }) {
  const links = [];
  const packages = [
    ...directories(path.join(root, 'packages')),
    ...directories(path.join(root, 'packages/cloud')),
  ];
  for (const source of packages) {
    const manifestPath = path.join(source, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!pkg.bin) continue;
    links.push({ source, destination: path.join(prefix, 'lib/node_modules', pkg.name) });
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
    for (const [name, entry] of Object.entries(bins)) {
      // npm exposes scoped bin names by their basename.
      links.push({ source: path.resolve(source, entry), destination: path.join(prefix, 'bin', path.basename(name)) });
    }
  }

  const unique = new Map();
  for (const link of links) {
    const previous = unique.get(link.destination);
    if (previous && previous.source !== link.source) {
      throw new Error(`Conflicting link destination: ${link.destination}`);
    }
    unique.set(link.destination, link);
  }
  return [...unique.values()];
}

function alreadyLinked({ source, destination }) {
  // An ancestor directory may itself link into the project.
  try {
    return fs.realpathSync(destination) === fs.realpathSync(source);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function applyLinkPlan(links, { log = console.log } = {}) {
  // Validate every build entry before replacing any installed files.
  for (const { source } of links) {
    if (!fs.existsSync(source)) throw new Error(`Missing build output: ${source}. Run pnpm build first.`);
  }
  const pending = links.filter(link => !alreadyLinked(link));
  if (pending.length === 0) {
    log('All entries already point to this checkout.');
    return;
  }
  for (const { source, destination } of pending) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (stat(destination)?.isSymbolicLink()) fs.unlinkSync(destination);
    else fs.rmSync(destination, { recursive: true, force: true });
    fs.symlinkSync(source, destination);
    log(`${destination} → ${source}`);
  }
  log('Local package links are ready.');
}

function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: pnpm dev:link [--dry-run] [--skip-build]

Build this checkout, then link its CLI packages and commands into the npm global prefix.
Existing installations are replaced without backups; correct links are left unchanged.
Supports macOS/Linux. Rebuild after changing CLI sources.
Does not install Skills, register Native Messaging hosts or restart running processes.

  --dry-run     Show links without building or writing files
  --skip-build  Use existing build outputs (fail if any entry is missing)`);
    return;
  }
  for (const arg of args) {
    if (!['--dry-run', '--skip-build'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('dev:link supports macOS/Linux.');
  }
  const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
  const links = createLinkPlan({ prefix });
  if (args.includes('--dry-run')) {
    for (const link of links) console.log(`${link.destination} → ${link.source}`);
    return;
  }
  if (!args.includes('--skip-build')) {
    execFileSync('pnpm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  }
  applyLinkPlan(links);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`dev:link failed: ${error.message}`);
    process.exitCode = 1;
  }
}
