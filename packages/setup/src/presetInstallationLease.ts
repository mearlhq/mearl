import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isCommandProcessAlive, isProcessOwnerAlive, processIdentity, readRecord, withRecordLock, type CommandLifecycle, type CommandProcessOwner, type DaemonRecord } from '@mearl/daemon-core';

interface InstallOwner extends DaemonRecord { token: string; processIdentity?: string; active: boolean; children: CommandProcessOwner[] }

/** The owner covers the shared global Skills directory, including hosts with different presets. */
export function claimPresetInstallation(file = join(homedir(), '.agents', '.mearl-preset-install.json')): { release(): void; lifecycle: CommandLifecycle } {
  const owner: InstallOwner = { pid: process.pid, token: randomUUID(), processIdentity: processIdentity(process.pid), active: true, children: [] };
  const read = () => {
    try { return statSync(file).size <= 65536 ? readRecord<InstallOwner>(file) : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const write = (value: InstallOwner) => {
    const temporary = `${file}.${owner.token}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  };
  const owned = (value: InstallOwner | null) => value?.token === owner.token && value.pid === owner.pid && value.processIdentity === owner.processIdentity;
  withRecordLock(file, () => {
    const previous = read();
    if (previous && ((previous.active !== false && isProcessOwnerAlive(previous)) || previous.children?.some(isCommandProcessAlive))) throw new Error('PRESET_INSTALL_BUSY');
    write(owner);
  });
  return {
    lifecycle: {
      started(child) {
        withRecordLock(file, () => {
          const current = read();
          if (!owned(current) || !current!.active || current!.children.length >= 256) throw new Error('PRESET_INSTALL_OWNER_CHANGED');
          write({ ...current!, children: [...current!.children, child] });
        });
      },
      finished(child) {
        withRecordLock(file, () => {
          const current = read();
          if (!owned(current)) return;
          write({ ...current!, children: current!.children.filter(entry => entry.pid !== child.pid || entry.processIdentity !== child.processIdentity) });
        });
      },
    },
    release: () => withRecordLock(file, () => {
      const current = read();
      if (!owned(current)) return;
      const children = current!.children.filter(isCommandProcessAlive);
      if (children.length) write({ ...current!, active: false, children });
      else rmSync(file, { force: true });
    }),
  };
}
