import { FC, useEffect, useState } from 'react';
import { SlidersHorizontal, X, Plus, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { t, getCurrentLanguage } from '../../panel/utils/i18n';
import { browserUiText } from '@mearl/preset/bundles';
import { useBrowserUiSettings } from '../../panel/utils/browserUiSettings';
import { getConfig, updateConfig, onConfigChange } from '../../panel/utils/config';
import { useLocalStorage } from '../../panel/hooks/useLocalStorage';
import {
  isPresetActive,
  parseParamsInput,
  mergeMissingBuiltinPresets,
  type UrlQueryPreset,
} from '../../panel/utils/urlQueryPresets';

interface UrlQueryPresetButtonProps {
  /** 当前 URL 的原始 query 字符串（不含 ?） */
  query: string;
  /** 切换某个预设的开关 */
  onToggle: (preset: UrlQueryPreset) => void;
}

/** 参数摘要，用于 hover 提示 */
const presetSummary = (preset: UrlQueryPreset): string =>
  preset.params.map(p => `${p.key}=${p.value}`).join('&');

const switchClass = (enabled: boolean) =>
  clsx(
    'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors cursor-pointer',
    enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
  );

const switchThumbClass = (enabled: boolean) =>
  clsx(
    'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
    enabled ? 'translate-x-3.5' : 'translate-x-0.5',
  );

const inputClass =
  'min-w-0 bg-bg-secondary text-text-primary text-2xs px-2 py-1 rounded border border-border outline-none focus:border-blue-500 transition-colors';

/**
 * URL query 快捷参数按钮：位于底部工具栏，hover 向上展开预设列表。
 * 每行以开关展示预设是否生效并支持一键添加/移除对应 query 参数，
 * 底部提供表单新增自定义预设，列表项可删除（含内置项）。
 */
export const UrlQueryPresetButton: FC<UrlQueryPresetButtonProps> = ({ query, onToggle }) => {
  // 展开/收起状态持久化，仅由触发按钮点击切换
  const ui = useBrowserUiSettings();
  const presetLabel = (preset: UrlQueryPreset): string => preset.label ?? (ui.queryPresets?.[preset.id] ? browserUiText(ui.queryPresets[preset.id].label, getCurrentLanguage()) : preset.id);
  const [open, setOpen] = useLocalStorage('query-presets-open', false);
  const [presets, setPresets] = useState<UrlQueryPreset[]>([]);
  const [adding, setAdding] = useState(false);
  // 正在编辑的预设 id；null 表示新增模式
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [paramsInput, setParamsInput] = useState('');

  useEffect(() => {
    getConfig().then(config => {
      // 补入用户尚未见过的新内置预设，并持久化 seen 记录以免其删除后复活
      const merged = mergeMissingBuiltinPresets(
        config.queryPresets ?? [],
        config.seenBuiltinPresetIds ?? [],
        Object.entries(ui.queryPresets ?? {}).map(([id, preset]) => ({ id, params: preset.params })),
      );
      setPresets(merged.presets);
      if (merged.changed) {
        updateConfig({ queryPresets: merged.presets, seenBuiltinPresetIds: merged.seenIds });
      }
    });
    const unsubscribe = onConfigChange(changes => {
      if (changes.queryPresets !== undefined) setPresets(changes.queryPresets);
    });
    return unsubscribe;
  }, [ui.queryPresets]);

  const persist = (next: UrlQueryPreset[]) => {
    setPresets(next);
    updateConfig({ queryPresets: next });
  };

  const parsedInputParams = parseParamsInput(paramsInput);
  const canSave = nameInput.trim().length > 0 && parsedInputParams.length > 0;

  const collapseAdd = () => {
    setAdding(false);
    setEditingId(null);
    setNameInput('');
    setParamsInput('');
  };

  const togglePanel = () => {
    if (open) {
      setOpen(false);
      collapseAdd();
    } else {
      setOpen(true);
    }
  };

  // 点击 + 进入新增：清空表单并退出编辑态，支持连续添加多个
  const startAdd = () => {
    setEditingId(null);
    setNameInput('');
    setParamsInput('');
    setAdding(true);
  };

  // 点击已有预设进入编辑：回填其名称与参数，保存时原地更新该项
  const startEdit = (preset: UrlQueryPreset) => {
    setEditingId(preset.id);
    setNameInput(presetLabel(preset));
    setParamsInput(presetSummary(preset));
    setAdding(true);
  };

  const handleSave = () => {
    if (!canSave) return;
    const label = nameInput.trim();
    if (editingId) {
      persist(
        presets.map(p => (p.id === editingId ? { ...p, label, params: parsedInputParams } : p)),
      );
      collapseAdd();
    } else {
      persist([...presets, { id: crypto.randomUUID(), label, params: parsedInputParams }]);
      // 保持展开并清空，便于连续添加多个
      setNameInput('');
      setParamsInput('');
    }
  };

  const handleDelete = (id: string) => persist(presets.filter(p => p.id !== id));

  const anyActive = presets.some(preset => isPresetActive(query, preset));

  return (
    // 仅点击触发按钮切换展开/收起，状态持久化
    <div className="relative shrink-0">
      <button
        onClick={togglePanel}
        className={clsx(
          // 背景随展开/hover 变化；icon 颜色仅由是否有预设生效决定
          'p-0.5 rounded transition-colors cursor-pointer hover:bg-bg-hover',
          open && 'bg-bg-hover',
          anyActive ? 'text-blue-600 dark:text-blue-400' : 'text-text-secondary/60',
        )}
        title={t('queryPresets')}
      >
        <SlidersHorizontal className="w-3 h-3" />
      </button>

      {/* 向上展开，pb 提供与按钮的间距 */}
      <div
        className={clsx(
          'absolute bottom-full right-0 pb-1 z-50 w-72',
          open ? 'visible' : 'invisible pointer-events-none',
        )}
      >
        <div className="w-full bg-bg-primary border border-border rounded shadow-lg">
          {/* 预设列表 */}
          <div className="p-2.5">
            <div className="flex items-center gap-1 px-0.5 mb-2">
              <span className="text-2xs text-text-secondary">{t('queryPresets')}</span>
              <button
                onClick={startAdd}
                className="p-0.5 rounded text-text-secondary/50 hover:text-text-secondary hover:bg-bg-secondary transition-colors cursor-pointer"
                title={t('addPreset')}
              >
                <Plus className="w-2.5 h-2.5" />
              </button>
            </div>
            {/* 列表限高滚动，预设较多时不至于撑满面板 */}
            <div className="max-h-40 overflow-y-auto space-y-2">
              {presets.length === 0 ? (
                <div className="px-0.5 py-1 text-2xs text-text-secondary/60">
                  {t('noQueryPresets')}
                </div>
              ) : (
                presets.map(preset => {
                  const active = isPresetActive(query, preset);
                  return (
                    <div key={preset.id} className="flex items-center gap-2">
                      <button
                        onClick={() => startEdit(preset)}
                        className="flex-1 min-w-0 flex items-baseline gap-1.5 text-left px-1 py-0.5 rounded overflow-hidden hover:bg-bg-secondary transition-colors cursor-pointer"
                      >
                        <span
                          className={clsx(
                            'shrink-0 text-2xs',
                            editingId === preset.id
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-text-primary',
                          )}
                          title={t('edit')}
                        >
                          {presetLabel(preset)}
                        </span>
                        <span
                          className="min-w-0 flex-1 flex items-baseline text-2xs text-text-secondary/60"
                          title={presetSummary(preset)}
                        >
                          <span className="shrink-0">(</span>
                          <span className="min-w-0 truncate">{presetSummary(preset)}</span>
                          <span className="shrink-0">)</span>
                        </span>
                      </button>
                      <button
                        onClick={() => onToggle(preset)}
                        className={switchClass(active)}
                        role="switch"
                        aria-checked={active}
                      >
                        <span className={switchThumbClass(active)} />
                      </button>
                      <button
                        onClick={() => handleDelete(preset.id)}
                        className="p-0.5 rounded text-text-secondary/50 hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                        title={t('deletePreset')}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 新增自定义预设：仅在点击标题栏 + 展开时以单行表单显示 */}
          {adding && (
            <div className="border-t border-border p-2">
              <div className="flex items-center gap-1">
                <input
                  className={clsx(inputClass, 'w-16 shrink-0')}
                  placeholder={t('presetNamePlaceholder')}
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                  autoFocus
                />
                <input
                  className={clsx(inputClass, 'flex-1')}
                  placeholder={t('presetParamsPlaceholder')}
                  value={paramsInput}
                  onChange={e => setParamsInput(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="p-0.5 rounded text-green-600 hover:bg-green-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer dark:text-green-400"
                  title={editingId ? t('save') : t('addPreset')}
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  onClick={collapseAdd}
                  className="p-0.5 rounded text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                  title={t('cancel')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
