import { appendFileSync, renameSync, writeFileSync } from 'node:fs';

const [, configFile, launchesFile, delayRaw] = process.argv.slice(2);
const readyDelay = Number(delayRaw);

appendFileSync(launchesFile, `${process.pid}\n`);

setTimeout(() => {
  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const temporaryFile = `${configFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(record));
  renameSync(temporaryFile, configFile);
}, readyDelay);

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
