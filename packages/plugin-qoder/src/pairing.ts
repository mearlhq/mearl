import { randomBytes } from 'node:crypto';

export interface QoderPairingInfo {
  pairingCode: string;
  createdAt: number;
  connectorUrl: string;
  toolInput: {
    action: 'pair';
    payload: { code: string };
  };
}

export interface QoderPairingOptions {
  now?: () => number;
  createCode?: () => string;
}

export type CloudServerCommand = 'start' | 'stop' | 'restart' | 'status' | 'logs';

interface QoderCloudServerDependencies {
  createPairing?: () => QoderPairingInfo;
  isServerRunning: () => boolean;
  printLogs: () => void;
  printStatus: () => void;
  stopServer: () => Promise<void>;
  writeLine?: (message: string) => void;
}

/** Create a short-lived correlation handle without embedding Qoder credentials in the URL. */
export function createQoderPairingInfo(options: QoderPairingOptions = {}): QoderPairingInfo {
  const pairingCode = (options.createCode ?? (() => randomBytes(24).toString('base64url')))();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pairingCode)) {
    throw new Error('Qoder pairing code must be 16-128 URL-safe characters');
  }
  const createdAt = (options.now ?? Date.now)();
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 1_000_000_000_000 ||
    createdAt > 9_999_999_999_999
  ) {
    throw new Error('Qoder pairing timestamp must be a 13-digit epoch millisecond value');
  }
  return {
    pairingCode,
    createdAt,
    connectorUrl: `qoder://pair/${pairingCode}?created=${createdAt}`,
    toolInput: { action: 'pair', payload: { code: pairingCode } },
  };
}

export function formatQoderPairingOutput(info: QoderPairingInfo): string {
  const connectorCommand = `npx @mearl/cloud-connector start "${info.connectorUrl}"`;
  return `[CloudServer] Qoder pairing mode is ready.

  Connect from your local machine:
    ${connectorCommand}

  Then immediately invoke the Qoder client-side custom tool named "mearl" with this input:
    ${JSON.stringify(info.toolInput)}

The connector resolves QODER_PERSONAL_ACCESS_TOKEN from the local environment, ~/.mearl/.env, or supported local credential storage. Never add the PAT to the pairing URL.`;
}

export async function runQoderCloudServerCommand(
  command: CloudServerCommand,
  dependencies: QoderCloudServerDependencies,
): Promise<void> {
  const writeLine = dependencies.writeLine ?? console.log;
  switch (command) {
    case 'start':
    case 'restart':
      if (dependencies.isServerRunning()) await dependencies.stopServer();
      writeLine(
        formatQoderPairingOutput(
          (dependencies.createPairing ?? (() => createQoderPairingInfo()))(),
        ),
      );
      break;
    case 'status':
      dependencies.printStatus();
      writeLine('[CloudServer] Mode: qoder pairing (no listening service)');
      break;
    case 'stop':
      await dependencies.stopServer();
      break;
    case 'logs':
      dependencies.printLogs();
      break;
  }
}
