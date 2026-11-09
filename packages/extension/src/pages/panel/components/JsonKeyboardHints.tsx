import { FC } from 'react';
import { Command, Keyboard } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../utils/i18n';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { KeyboardHint } from './KeyboardHint';

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

  const clickableClassName =
    'cursor-pointer hover:bg-bg-hover hover:border-border-hover transition-colors';
  const commandClassName = compact ? 'w-2 h-2' : 'w-2.5 h-2.5';

  const treeHints = (
    <>
      {(showPasteHint || showUndoHint) && (
        <KeyboardHint className={clsx('gap-2', (onPaste || onUndo) && clickableClassName)}>
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
        </KeyboardHint>
      )}
      {showEnterNavigateHint && (
        <KeyboardHint
          className={onEnterNavigate ? clickableClassName : undefined}
          onClick={onEnterNavigate}
          role={onEnterNavigate ? 'button' : undefined}
        >
          {t('hintEnterNavigate')}
        </KeyboardHint>
      )}
    </>
  );

  const codeHints = (
    <KeyboardHint>
      <Command className={commandClassName} />+{t('hintCodeSearch')}
    </KeyboardHint>
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
