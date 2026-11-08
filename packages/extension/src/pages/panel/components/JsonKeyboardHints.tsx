import { FC } from 'react';
import { Command, Keyboard } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../utils/i18n';
import { useLocalStorage } from '../hooks/useLocalStorage';

type JsonKeyboardHintsMode = 'tree' | 'code';

interface JsonKeyboardHintsProps {
  storageKey?: string;
  mode?: JsonKeyboardHintsMode;
  compact?: boolean;
  showEnterNavigateHint?: boolean;
  showPasteHint?: boolean;
  showUndoHint?: boolean;
  onPaste?: () => void;
  onUndo?: () => void;
  onEnterNavigate?: () => void;
}

export const JsonKeyboardHints: FC<JsonKeyboardHintsProps> = ({
  storageKey = 'json-shortcuts-visible',
  mode = 'tree',
  compact = false,
  showEnterNavigateHint = false,
  showPasteHint = true,
  showUndoHint = false,
  onPaste,
  onUndo,
  onEnterNavigate,
}) => {
  const [showShortcuts, setShowShortcuts] = useLocalStorage(storageKey, true);

  const hintClassName =
    'flex items-center px-1 py-0.5 bg-bg-secondary border border-border rounded';
  const clickableClassName =
    'cursor-pointer hover:bg-bg-hover hover:border-border-hover transition-colors';
  const commandClassName = compact ? 'w-2 h-2' : 'w-2.5 h-2.5';

  const treeHints = (
    <>
      {(showPasteHint || showUndoHint) && (
        <div
          className={clsx(
            'flex items-center gap-2 px-1 py-0.5 bg-bg-secondary border border-border rounded',
            (onPaste || onUndo) && clickableClassName,
          )}
        >
          {showPasteHint && (
            <span
              className="flex items-center"
              onClick={onPaste}
              role={onPaste ? 'button' : undefined}
            >
              <Command className={commandClassName} />+{t('hintPaste')}
            </span>
          )}
          {showUndoHint && (
            <span
              className="flex items-center"
              onClick={onUndo}
              role={onUndo ? 'button' : undefined}
            >
              <Command className={commandClassName} />+{t('hintUndo')}
            </span>
          )}
        </div>
      )}
      {showEnterNavigateHint && (
        <div
          className={clsx(hintClassName, onEnterNavigate && clickableClassName)}
          onClick={onEnterNavigate}
          role={onEnterNavigate ? 'button' : undefined}
        >
          {t('hintEnterNavigate')}
        </div>
      )}
    </>
  );

  const codeHints = (
    <div className="flex items-center px-1 py-0.5 bg-bg-secondary border border-border rounded">
      <Command className={commandClassName} />+{t('hintCodeSearch')}
    </div>
  );

  return (
    <div className="flex items-center justify-between w-full">
      <div
        className={clsx(
          'text-text-secondary/80 flex items-center gap-1',
          compact ? 'text-3xs leading-3' : 'text-2xs leading-2.5',
        )}
      >
        {showShortcuts && (mode === 'tree' ? treeHints : codeHints)}
      </div>
      <button
        onClick={() => setShowShortcuts(!showShortcuts)}
        className="p-0.5 rounded transition-colors cursor-pointer hover:bg-bg-secondary text-text-secondary/60 hover:text-text-secondary"
        title={showShortcuts ? t('hideShortcuts') : t('showShortcuts')}
      >
        <Keyboard className="w-3 h-3" />
      </button>
    </div>
  );
};
