import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function linuxProcessStat(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const group = Number(fields[2]);
  const threads = Number(fields[17]);
  if (
    end < 0 ||
    !/^[A-Za-z]$/.test(fields[0]) ||
    !Number.isSafeInteger(group) ||
    group < 0 ||
    !Number.isSafeInteger(threads) ||
    threads < 0 ||
    !/^\d+$/.test(fields[19] ?? '')
  )
    throw new Error('Invalid Linux process stat');
  return { state: fields[0], group, threads, identity: fields[19] };
}

function linuxProcessExited({ state, threads }: ReturnType<typeof linuxProcessStat>): boolean {
  // A terminated thread-group leader may still have executable sibling threads.
  return threads <= 1 && (state === 'Z' || state === 'X' || state === 'x');
}

/** OS creation identity distinguishes an owner from an unrelated process reusing its pid. */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === 'linux') {
      return linuxProcessStat(pid).identity;
    }
    const result =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().Ticks`,
            ],
            { encoding: 'utf8', timeout: 2000, windowsHide: true },
          )
        : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8',
            timeout: 2000,
          });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessOwnerAlive(owner: { pid: number; processIdentity?: unknown }): boolean {
  if (!isAlive(owner.pid)) return false;
  if (typeof owner.processIdentity !== 'string') return true;
  const current = processIdentity(owner.pid);
  return current === undefined || current === owner.processIdentity;
}

/**
 * Whether a process with the given pid is currently alive.
 *
 * Signal 0 checks existence without delivering a signal. Linux zombies retain
 * their pid until reaped, so procfs distinguishes them from executable owners.
 * Unavailable inspection and EPERM remain conservatively alive.
 */
export function isAlive(pid: number | undefined | null): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        return !linuxProcessExited(linuxProcessStat(pid));
      } catch {
        return true;
      }
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** POSIX group liveness includes live descendants after their original owner exits. */
export function isProcessGroupAlive(group: number): boolean {
  if (!Number.isSafeInteger(group) || group < 1) return false;
  if (process.platform === 'win32') return true;
  const probe = () => {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
    }
  };
  const present = probe();
  if (present !== true) return present !== false;
  if (process.platform !== 'linux') return true;

  const exitedMembers = (): Set<string> | undefined => {
    const members = new Set<string>();
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = linuxProcessStat(Number(name));
          if (stat.group !== group) continue;
          if (!linuxProcessExited(stat)) return undefined;
          members.add(`${name}:${stat.identity}`);
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            return undefined;
        }
      }
      return members;
    } catch {
      return undefined;
    }
  };

  // Stable exited membership excludes a child forked while the first scan was in progress.
  const first = exitedMembers();
  if (!first) return true;
  const second = exitedMembers();
  if (!second) return true;
  if (first.size && first.size === second.size && [...first].every(pid => second.has(pid)))
    return false;
  return probe() !== false;
}
