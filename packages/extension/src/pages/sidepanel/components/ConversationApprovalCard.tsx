import { ChevronRight, FolderOpen, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import type { AgentChatEvent } from '@mearl/browser-core';
import { JsonTree } from '../../panel/components/json-tree/JsonTree';
import { t } from '../../panel/utils/i18n';

interface ConversationApprovalCardProps {
  request: AgentChatEvent;
  onDecision: (accepted: boolean) => void;
}

interface ApprovalPresentation {
  title: string;
  description: string;
  detailLabel?: string;
  detail?: string;
  directory?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commandArgumentText(value: unknown): string {
  if (typeof value !== 'string') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function commandText(value: unknown): string | undefined {
  if (typeof value === 'string') return nonEmptyString(value);
  return Array.isArray(value) && value.length > 0
    ? value.map(commandArgumentText).join(' ')
    : undefined;
}

function fileChangeText(params: Record<string, unknown>): string | undefined {
  const changes = params.changes ?? params.fileChanges;
  if (typeof changes === 'string') return nonEmptyString(changes);
  if (Array.isArray(changes)) {
    const paths = changes.flatMap(change => {
      if (typeof change === 'string') return [change];
      const value = record(change);
      const path = nonEmptyString(value?.path) || nonEmptyString(value?.filePath);
      return path ? [path] : [];
    });
    if (paths.length > 0) return paths.join('\n');
  }
  if (record(changes)) {
    const paths = Object.keys(changes as Record<string, unknown>);
    if (paths.length > 0) return paths.join('\n');
  }
  return nonEmptyString(params.grantRoot);
}

function permissionLabel(key: string): string {
  switch (key) {
    case 'network':
      return t('agentChatApprovalNetwork');
    case 'fileSystem':
      return t('agentChatApprovalFileSystem');
    default:
      return key;
  }
}

function permissionValue(value: unknown): string {
  if (value === true) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function permissionsText(value: unknown): string | undefined {
  const permissions = record(value);
  if (!permissions) return undefined;
  const lines = Object.entries(permissions)
    .filter(([, permission]) => Boolean(permission))
    .map(([key, permission]) => {
      const detail = permissionValue(permission);
      return detail ? `${permissionLabel(key)}: ${detail}` : permissionLabel(key);
    });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function approvalPresentation(request: AgentChatEvent): ApprovalPresentation {
  const params = record(request.params) || {};
  const reason =
    nonEmptyString(params.reason) ||
    nonEmptyString(params.justification) ||
    t('agentChatApprovalDescription');
  const directory = nonEmptyString(params.cwd);

  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return {
        title: t('agentChatApprovalCommandTitle'),
        description: reason,
        detailLabel: t('agentChatApprovalCommand'),
        detail: commandText(params.command),
        directory,
      };
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return {
        title: t('agentChatApprovalFileChangeTitle'),
        description: reason,
        detailLabel: t('agentChatApprovalFiles'),
        detail: fileChangeText(params),
        directory,
      };
    case 'item/permissions/requestApproval':
      return {
        title: t('agentChatApprovalPermissionsTitle'),
        description: reason,
        detailLabel: t('agentChatApprovalPermissions'),
        detail: permissionsText(params.permissions),
        directory,
      };
    case 'acp/requestPermission': {
      const toolCall = record(params.toolCall);
      return {
        title: t('agentChatApprovalToolTitle'),
        description: reason,
        detailLabel: t('agentChatApprovalTool'),
        detail: nonEmptyString(toolCall?.title),
        directory,
      };
    }
    default:
      return {
        title: t('agentChatApprovalTitle'),
        description: reason,
        directory,
      };
  }
}

export function ConversationApprovalCard({ request, onDecision }: ConversationApprovalCardProps) {
  const presentation = approvalPresentation(request);

  return (
    <section
      data-testid="conversation-approval"
      className="mx-3 overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/[0.04] shadow-[0_1px_3px_rgb(0_0_0/0.04)]"
    >
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-300">
            <ShieldQuestion className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium leading-5 text-text-primary">
              {presentation.title}
            </div>
            <div className="text-3xs leading-4 text-text-secondary">{presentation.description}</div>
          </div>
        </div>

        {presentation.detail ? (
          <div className="mt-2.5 rounded-lg border border-border/70 bg-bg-primary/80 px-2.5 py-2">
            <div className="mb-1 text-3xs font-medium text-text-secondary">
              {presentation.detailLabel}
            </div>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-xxs leading-4 text-text-primary [overflow-wrap:anywhere]">
              {presentation.detail}
            </pre>
          </div>
        ) : null}

        {presentation.directory ? (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-3xs leading-4 text-text-secondary">
            <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="shrink-0">{t('agentChatApprovalDirectory')}</span>
            <span className="truncate font-mono" title={presentation.directory}>
              {presentation.directory}
            </span>
          </div>
        ) : null}

        <details className="group/details mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-3xs leading-4 text-text-secondary transition-colors hover:text-text-primary [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" />
            {t('agentChatApprovalShowDetails')}
          </summary>
          <div className="mt-1.5 overflow-hidden rounded-md border border-border/70 bg-bg-primary/70">
            <div className="truncate border-b border-border/70 px-2 py-1 font-mono text-3xs text-text-secondary">
              {request.method}
            </div>
            <div className="max-h-48 overflow-auto p-2 font-mono text-xxs leading-4">
              <JsonTree
                data={request.params}
                pathPrefix={`agent-chat.conversation-request.${request.id}`}
                defaultExpandDepth={1}
                editable={false}
              />
            </div>
          </div>
        </details>
      </div>

      <div className="flex justify-end gap-2 border-t border-amber-500/15 bg-bg-secondary/60 px-3 py-2">
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-primary px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
          {t('agentChatDecline')}
        </button>
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700 cursor-pointer"
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {t('agentChatApprove')}
        </button>
      </div>
    </section>
  );
}
