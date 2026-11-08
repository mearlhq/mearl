import { MessageSquareText, X } from 'lucide-react';
import { t } from '../../panel/utils/i18n';
import { selectedElementLabel } from '../elementComments';
import type { PageElementComment } from '../types';

interface ElementCommentPillsProps {
  comments: PageElementComment[];
  onEdit: (commentId: string) => void;
  onRemove: (commentId: string) => void;
}

function commentTooltip(comment: PageElementComment, label: string): string {
  const styleSummary = Object.entries(comment.styleChanges)
    .map(([property, value]) => `${property}: ${value}`)
    .join(' · ');
  return [label, selectedElementLabel(comment.selection), comment.comment, styleSummary]
    .filter(Boolean)
    .join('\n');
}

export function ElementCommentPills({ comments, onEdit, onRemove }: ElementCommentPillsProps) {
  if (comments.length === 0) return null;

  return (
    <div className="mb-1.5 flex flex-wrap gap-1" aria-label={t('agentChatElementCommentTitle')}>
      {comments.map((comment, index) => {
        const label = t('agentChatElementCommentNumber', String(index + 1));
        return (
          <div
            key={comment.id}
            className="inline-flex h-6 max-w-full items-center rounded-full border border-blue-500/25 bg-transparent text-3xs text-blue-600 transition-colors hover:bg-blue-500/5 dark:border-blue-400/25 dark:text-blue-300 dark:hover:bg-blue-400/5"
          >
            <button
              type="button"
              onClick={() => onEdit(comment.id)}
              className="inline-flex h-full min-w-0 items-center gap-1 pl-1.5 pr-0.5 transition-colors hover:text-blue-700 cursor-pointer focus-visible:outline-none focus-visible:text-blue-700 dark:hover:text-blue-200 dark:focus-visible:text-blue-200"
              title={commentTooltip(comment, label)}
              aria-label={`${t('agentChatEditElementComment')}: ${label}`}
            >
              <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate font-medium">{label}</span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(comment.id)}
              className="mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-blue-500/60 transition-colors hover:bg-blue-500/10 hover:text-blue-700 cursor-pointer focus-visible:outline-none focus-visible:bg-blue-500/10 focus-visible:text-blue-700 dark:text-blue-300/60 dark:hover:bg-blue-400/10 dark:hover:text-blue-200 dark:focus-visible:bg-blue-400/10 dark:focus-visible:text-blue-200"
              title={t('agentChatRemoveElementComment')}
              aria-label={`${t('agentChatRemoveElementComment')}: ${label}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
