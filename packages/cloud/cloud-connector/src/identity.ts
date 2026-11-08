import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DAEMON_HOME, readRecord, writeRecord, type DaemonRecord } from '@mearl/daemon-core';

const IDENTITY_FILE = join(DAEMON_HOME, 'cloud-connector-identity.json');

interface StoredConnectorIdentity extends DaemonRecord {
  connectorId: string;
}

export interface ConnectorIdentity {
  connectorId: string;
  name: string;
}

export function resolveConnectorIdentity(options: {
  connectorId?: string;
  connectorName?: string;
}): ConnectorIdentity {
  const explicitId = options.connectorId?.trim() || process.env.MEARL_CONNECTOR_ID?.trim();
  const explicitName = options.connectorName?.trim() || process.env.MEARL_CONNECTOR_NAME?.trim();
  const stored = readRecord<StoredConnectorIdentity>(IDENTITY_FILE);
  const connectorId = explicitId || stored?.connectorId || randomUUID();

  if (!explicitId && !stored?.connectorId) {
    try {
      writeRecord(IDENTITY_FILE, { pid: process.pid, connectorId });
    } catch {
      // A read-only home directory should not prevent the connector from starting.
    }
  }

  const name = explicitName || hostname() || `connector-${connectorId.slice(0, 8)}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(connectorId)) {
    throw new Error('connectorId must contain only letters, numbers, ".", "_", ":", or "-"');
  }
  if (name.length > 128 || /\p{Cc}/u.test(name)) {
    throw new Error('connectorName must be 1-128 characters without control characters');
  }

  return { connectorId, name };
}
