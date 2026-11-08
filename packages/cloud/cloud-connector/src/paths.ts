import { keyedConfigFile, keyedDir, keyedLogFile } from '@mearl/daemon-core';

/**
 * Subdir under ~/.mearl holding one record/log per connector instance,
 * keyed by serverUrl. This directory is the SHARED contract between the
 * connector, daemon manager, and native-host. All participants derive paths
 * through these helpers so they never disagree on where a connector's record
 * lives.
 */
export const CONNECTORS_SUBDIR = 'connectors';

/** Directory containing all per-connector records and logs. */
export const CONNECTORS_DIR = keyedDir(CONNECTORS_SUBDIR);

/** Record file for a given serverUrl: ~/.mearl/connectors/<hash>.json */
export function configFileFor(serverUrl: string): string {
  return keyedConfigFile(CONNECTORS_SUBDIR, serverUrl);
}

/** Log file for a given serverUrl: ~/.mearl/connectors/<hash>.log */
export function logFileFor(serverUrl: string): string {
  return keyedLogFile(CONNECTORS_SUBDIR, serverUrl);
}
