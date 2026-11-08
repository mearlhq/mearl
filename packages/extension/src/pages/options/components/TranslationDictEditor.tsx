import { useState, useEffect, useRef, FC, KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import {
  Plus,
  Trash2,
  Download,
  Upload,
  Search,
  Check,
  X,
  Pencil,
  DatabaseZap,
  BookOpen,
} from 'lucide-react';
import { t } from '../../panel/utils/i18n';
import {
  TranslationDict,
  loadTranslationDict,
  saveTranslationDict,
  deleteTranslationEntry,
  importTranslationDict,
  exportTranslationDict,
  TRANSLATION_DICT_STORAGE_KEY,
} from '../../panel/utils/translationDict';
import type { CachedTranslationEntry } from '../../panel/utils/translate';
import { useSafeFocus } from '../../../shared/hooks/useSafeFocus';

// 目标语言列配置
const LANG_COLS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hant', label: '繁体中文' },
];

// 每页显示条数
const PAGE_SIZE = 30;

interface EditState {
  orig: string;
  langCode: string;
  value: string;
}

interface AddFormState {
  orig: string;
  en: string;
  zhHant: string;
}

interface CacheGroup {
  text: string;
  translations: Record<string, string>;
  inDict: boolean;
}

const emptyAdd = (): AddFormState => ({ orig: '', en: '', zhHant: '' });

const TranslationDictEditor: FC = () => {
  const [dict, setDict] = useState<TranslationDict>({});
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [editState, setEditState] = useState<EditState | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(emptyAdd());
  const [page, setPage] = useState(0);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [importMessage, setImportMessage] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const addOrigInputRef = useRef<HTMLInputElement>(null);

  useSafeFocus(editInputRef, { enabled: !!editState, selectText: true });
  useSafeFocus(addOrigInputRef, { enabled: showAddForm });

  // 内存缓存卡片
  const [cacheGroups, setCacheGroups] = useState<CacheGroup[]>([]);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [cacheFilter, setCacheFilter] = useState('');
  const [selectedTexts, setSelectedTexts] = useState<Set<string>>(new Set());
  const [cacheImportStatus, setCacheImportStatus] = useState<'idle' | 'success'>('idle');
  const [cacheImportCount, setCacheImportCount] = useState(0);

  // 加载词典
  useEffect(() => {
    loadTranslationDict().then(d => {
      setDict(d);
      setLoading(false);
    });

    // 监听 storage 变化（其他地方修改时同步）
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && TRANSLATION_DICT_STORAGE_KEY in changes) {
        setDict((changes[TRANSLATION_DICT_STORAGE_KEY].newValue ?? {}) as TranslationDict);
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  // 组件挂载时自动加载翻译缓存
  useEffect(() => {
    loadCache();
  }, []);

  // 过滤 + 分页
  const allEntries = Object.entries(dict);
  const filtered = filterText.trim()
    ? allEntries.filter(
        ([orig, langs]) =>
          orig.includes(filterText) || Object.values(langs).some(v => v.includes(filterText)),
      )
    : allEntries;

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageEntries = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // 重置分页
  useEffect(() => {
    setPage(0);
  }, [filterText]);

  // ── 保存单格编辑 ──────────────────────────────────────────────────────────
  const commitEdit = async () => {
    if (!editState) return;
    const { orig, langCode, value } = editState;
    const newDict = { ...dict };
    if (value.trim() === '') {
      // 空值 → 删除该语言项
      if (newDict[orig]) {
        delete newDict[orig][langCode];
        if (Object.keys(newDict[orig]).length === 0) delete newDict[orig];
      }
    } else {
      newDict[orig] = { ...(newDict[orig] ?? {}), [langCode]: value.trim() };
    }
    setDict(newDict);
    setEditState(null);
    await saveTranslationDict(newDict);
  };

  const cancelEdit = () => setEditState(null);

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  // ── 删除整行 ──────────────────────────────────────────────────────────────
  const handleDelete = async (orig: string) => {
    const newDict = { ...dict };
    delete newDict[orig];
    setDict(newDict);
    await deleteTranslationEntry(orig);
  };

  // ── 添加新条目 ────────────────────────────────────────────────────────────
  const handleAddSubmit = async () => {
    const { orig, en, zhHant } = addForm;
    if (!orig.trim()) return;
    const langs: Record<string, string> = {};
    if (en.trim()) langs['en'] = en.trim();
    if (zhHant.trim()) langs['zh-Hant'] = zhHant.trim();
    if (Object.keys(langs).length === 0) return;

    const newDict = { ...dict, [orig.trim()]: { ...(dict[orig.trim()] ?? {}), ...langs } };
    setDict(newDict);
    setAddForm(emptyAdd());
    setShowAddForm(false);
    await saveTranslationDict(newDict);
  };

  const handleAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleAddSubmit();
    if (e.key === 'Escape') {
      setShowAddForm(false);
      setAddForm(emptyAdd());
    }
  };

  // ── 从内存缓存选取 ────────────────────────────────────────────────────────
  const loadCache = async () => {
    setCacheLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getTranslationCache' });
      if (response.success) {
        const entries: CachedTranslationEntry[] = response.cache;
        // 按 text 分组
        const map = new Map<string, Record<string, string>>();
        for (const { text, targetLanguage, translated } of entries) {
          if (!map.has(text)) map.set(text, {});
          map.get(text)![targetLanguage] = translated;
        }
        const currentDict = await loadTranslationDict();
        const groups: CacheGroup[] = Array.from(map.entries()).map(([text, translations]) => ({
          text,
          translations,
          inDict: !!currentDict[text],
        }));
        setCacheGroups(groups);
      }
    } finally {
      setCacheLoading(false);
    }
  };

  const toggleCacheSelect = (text: string) => {
    setSelectedTexts(prev => {
      const next = new Set(prev);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });
  };

  const toggleSelectAll = (visible: CacheGroup[]) => {
    const visibleTexts = visible.map(g => g.text);
    const allSelected = visibleTexts.every(t => selectedTexts.has(t));
    setSelectedTexts(prev => {
      const next = new Set(prev);
      if (allSelected) visibleTexts.forEach(t => next.delete(t));
      else visibleTexts.forEach(t => next.add(t));
      return next;
    });
  };

  const importFromCache = async () => {
    if (selectedTexts.size === 0) return;
    const newDict = { ...dict };
    let count = 0;
    for (const group of cacheGroups) {
      if (!selectedTexts.has(group.text)) continue;
      newDict[group.text] = { ...(newDict[group.text] ?? {}), ...group.translations };
      count++;
    }
    setDict(newDict);
    await saveTranslationDict(newDict);
    setCacheImportCount(count);
    setCacheImportStatus('success');
    setSelectedTexts(new Set());
    // 更新 inDict 标记
    setCacheGroups(gs => gs.map(g => ({ ...g, inDict: !!newDict[g.text] })));
    setTimeout(() => setCacheImportStatus('idle'), 2500);
  };

  // ── 导出 ──────────────────────────────────────────────────────────────────
  const handleExport = () => {
    const json = exportTranslationDict(dict);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mearl-translation-dict-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── 导入 ──────────────────────────────────────────────────────────────────
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const text = ev.target?.result as string;
      const result = await importTranslationDict(text, 'merge');
      if (result.success) {
        setImportStatus('success');
        setImportMessage(t('translationDictImportSuccess', String(result.count)));
        loadTranslationDict().then(setDict);
      } else {
        setImportStatus('error');
        setImportMessage(t('translationDictImportError'));
      }
      setTimeout(() => setImportStatus('idle'), 3000);
    };
    reader.readAsText(file);
    // 清空 input，允许重复选同一文件
    e.target.value = '';
  };

  if (loading) {
    return <div className="text-xs text-text-secondary py-4 text-center">{t('loading')}</div>;
  }

  return (
    <>
      <div className="bg-bg-secondary border border-border rounded p-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-text-secondary" />
            <div>
              <h2 className="text-sm font-medium text-text-primary">{t('translationDict')}</h2>
              <p className="text-xs text-text-secondary mt-0.5">{t('translationDictDesc')}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* 导入状态提示 */}
            {importStatus === 'success' && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <Check className="w-3 h-3" />
                {importMessage}
              </span>
            )}
            {importStatus === 'error' && (
              <span className="text-xs text-red-500">{importMessage}</span>
            )}
            {/* 导出 */}
            <button
              onClick={handleExport}
              disabled={allEntries.length === 0}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-bg-primary text-text-secondary hover:text-text-primary hover:border-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('translationDictExport')}
            >
              <Download className="w-3 h-3" />
              {t('export')}
            </button>
            {/* 导入 */}
            <button
              onClick={() => importInputRef.current?.click()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-bg-primary text-text-secondary hover:text-text-primary hover:border-blue-400 transition-colors"
              title={t('translationDictImport')}
            >
              <Upload className="w-3 h-3" />
              {t('import')}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportFile}
            />
            {/* 添加 */}
            <button
              onClick={() => {
                setShowAddForm(true);
                setEditState(null);
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-3 h-3" />
              {t('translationDictAdd')}
            </button>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="relative mb-2">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
          <input
            type="text"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder={t('translationDictSearch')}
            className="w-full pl-6 pr-2 py-1 text-xs bg-bg-primary border border-border rounded outline-none focus:border-blue-400 text-text-primary placeholder:text-text-secondary"
          />
        </div>

        {/* 添加新条目表单 */}
        {showAddForm && (
          <div className="mb-2 p-2 border border-border rounded bg-bg-primary flex flex-col gap-1.5">
            <p className="text-xs text-text-secondary font-medium">{t('translationDictAddNew')}</p>
            <input
              ref={addOrigInputRef}
              type="text"
              value={addForm.orig}
              onChange={e => setAddForm(f => ({ ...f, orig: e.target.value }))}
              onKeyDown={handleAddKeyDown}
              placeholder={t('translationDictOriginal')}
              className="w-full px-2 py-1 text-xs bg-bg-secondary border border-border rounded outline-none focus:border-blue-400 text-text-primary placeholder:text-text-secondary"
            />
            <div className="flex gap-1.5">
              <input
                type="text"
                value={addForm.en}
                onChange={e => setAddForm(f => ({ ...f, en: e.target.value }))}
                onKeyDown={handleAddKeyDown}
                placeholder="English"
                className="flex-1 px-2 py-1 text-xs bg-bg-secondary border border-border rounded outline-none focus:border-blue-400 text-text-primary placeholder:text-text-secondary"
              />
              <input
                type="text"
                value={addForm.zhHant}
                onChange={e => setAddForm(f => ({ ...f, zhHant: e.target.value }))}
                onKeyDown={handleAddKeyDown}
                placeholder={t('traditionalChinese')}
                className="flex-1 px-2 py-1 text-xs bg-bg-secondary border border-border rounded outline-none focus:border-blue-400 text-text-primary placeholder:text-text-secondary"
              />
            </div>
            <div className="flex gap-1.5 justify-end">
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setAddForm(emptyAdd());
                }}
                className="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleAddSubmit}
                disabled={!addForm.orig.trim() || (!addForm.en.trim() && !addForm.zhHant.trim())}
                className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('add')}
              </button>
            </div>
          </div>
        )}

        {/* 词典表格 */}
        {filtered.length === 0 ? (
          <div className="text-xs text-text-secondary py-6 text-center">
            {allEntries.length === 0 ? t('translationDictEmpty') : t('noMatchingRequests')}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2 text-text-secondary font-medium w-[38%]">
                      {t('translationDictOriginal')}
                    </th>
                    {LANG_COLS.map(col => (
                      <th
                        key={col.code}
                        className="text-left py-1.5 px-2 text-text-secondary font-medium w-[28%]"
                      >
                        {col.label}
                      </th>
                    ))}
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody>
                  {pageEntries.map(([orig, langs]) => (
                    <tr
                      key={orig}
                      className="border-b border-border/50 hover:bg-bg-primary/50 group"
                    >
                      {/* 原文 */}
                      <td className="py-1 px-2 align-top">
                        <span className="text-text-primary break-all">{orig}</span>
                      </td>
                      {/* 译文列 */}
                      {LANG_COLS.map(col => {
                        const isEditing =
                          editState?.orig === orig && editState?.langCode === col.code;
                        const value = langs[col.code] ?? '';
                        return (
                          <td key={col.code} className="py-1 px-2 align-top">
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <input
                                  ref={editInputRef}
                                  type="text"
                                  value={editState.value}
                                  onChange={e =>
                                    setEditState(s => (s ? { ...s, value: e.target.value } : s))
                                  }
                                  onKeyDown={handleEditKeyDown}
                                  className="flex-1 px-1.5 py-0.5 text-xs bg-bg-primary border border-blue-400 rounded outline-none text-text-primary min-w-0"
                                />
                                <button
                                  onClick={commitEdit}
                                  className="text-green-600 hover:text-green-700 shrink-0"
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="text-text-secondary hover:text-text-primary shrink-0"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setEditState({ orig, langCode: col.code, value })}
                                className="w-full text-left group/cell flex items-start gap-1 min-h-4.5"
                                title={t('translationDictClickToEdit')}
                              >
                                <span
                                  className={clsx(
                                    `break-all flex-1 ${value ? 'text-text-primary' : 'text-text-secondary opacity-50'}`,
                                  )}
                                >
                                  {value || '—'}
                                </span>
                                <Pencil className="w-2.5 h-2.5 text-text-secondary opacity-0 group-hover/cell:opacity-60 shrink-0 mt-0.5" />
                              </button>
                            )}
                          </td>
                        );
                      })}
                      {/* 删除 */}
                      <td className="py-1 px-1 align-middle">
                        <button
                          onClick={() => handleDelete(orig)}
                          className="text-text-secondary hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                          title={t('delete')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                <span className="text-xs text-text-secondary">
                  {filtered.length} {t('translationDictEntries')}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-1.5 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
                  >
                    &lt;
                  </button>
                  <span className="text-xs text-text-secondary px-1">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page === totalPages - 1}
                    className="px-1.5 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
                  >
                    &gt;
                  </button>
                </div>
              </div>
            )}
            {totalPages <= 1 && filtered.length > 0 && (
              <p className="text-xs text-text-secondary mt-2 text-right">
                {filtered.length} {t('translationDictEntries')}
              </p>
            )}
          </>
        )}
      </div>

      {/* 翻译缓存卡片 */}
      {(() => {
        const cacheFiltered = cacheFilter.trim()
          ? cacheGroups.filter(
              g =>
                g.text.includes(cacheFilter) ||
                Object.values(g.translations).some(v => v.includes(cacheFilter)),
            )
          : cacheGroups;
        const allVisibleSelected =
          cacheFiltered.length > 0 && cacheFiltered.every(g => selectedTexts.has(g.text));
        return (
          <div className="bg-bg-secondary border border-border rounded p-4 mt-4">
            {/* 卡片标题栏 */}
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <DatabaseZap className="w-3.5 h-3.5 text-text-secondary" />
                <div>
                  <h2 className="text-sm font-medium text-text-primary">
                    {t('translationDictCacheTitle')}
                  </h2>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {t('translationDictCacheDesc')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {cacheImportStatus === 'success' && (
                  <span className="text-xs text-green-600 flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    {t('translationDictCacheImportSuccess', String(cacheImportCount))}
                  </span>
                )}
                {selectedTexts.size > 0 && cacheImportStatus !== 'success' && (
                  <span className="text-xs text-text-secondary">
                    {t('translationDictCacheSelected', String(selectedTexts.size))}
                  </span>
                )}
                <button
                  onClick={loadCache}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-bg-primary text-text-secondary hover:text-text-primary hover:border-blue-400 transition-colors"
                  title={t('translationDictFromCache')}
                >
                  <DatabaseZap className="w-3 h-3" />
                  {t('refresh')}
                </button>
                <button
                  onClick={importFromCache}
                  disabled={selectedTexts.size === 0}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="w-3 h-3" />
                  {t('translationDictCacheImport')}
                </button>
              </div>
            </div>

            {cacheLoading && (
              <div className="text-xs text-text-secondary py-6 text-center">{t('loading')}</div>
            )}

            {!cacheLoading && cacheGroups.length === 0 && (
              <div className="text-xs text-text-secondary py-6 text-center">
                {t('translationDictCacheEmpty')}
              </div>
            )}

            {!cacheLoading && cacheGroups.length > 0 && (
              <>
                {/* 搜索 + 全选 */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="relative flex-1">
                    <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                    <input
                      type="text"
                      value={cacheFilter}
                      onChange={e => setCacheFilter(e.target.value)}
                      placeholder={t('translationDictCacheSearch')}
                      className="w-full pl-6 pr-2 py-1 text-xs bg-bg-primary border border-border rounded outline-none focus:border-blue-400 text-text-primary placeholder:text-text-secondary"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={() => toggleSelectAll(cacheFiltered)}
                      className="w-3.5 h-3.5 accent-blue-600"
                    />
                    {t('selectAll')}
                  </label>
                  <span className="text-xs text-text-secondary shrink-0">
                    {t('translationDictCacheCount', String(cacheGroups.length))}
                  </span>
                </div>

                {/* 缓存列表 */}
                {cacheFiltered.length === 0 ? (
                  <div className="text-xs text-text-secondary py-4 text-center">
                    {t('noMatchingRequests')}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="w-8 py-1.5 px-2" />
                          <th className="text-left py-1.5 px-2 text-text-secondary font-medium w-[38%]">
                            {t('translationDictOriginal')}
                          </th>
                          {LANG_COLS.map(col => (
                            <th
                              key={col.code}
                              className="text-left py-1.5 px-2 text-text-secondary font-medium w-[28%]"
                            >
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {cacheFiltered.map(group => (
                          <tr
                            key={group.text}
                            onClick={() => toggleCacheSelect(group.text)}
                            className="border-b border-border/50 cursor-pointer hover:bg-bg-primary/50 group"
                          >
                            <td className="py-1.5 px-2 align-middle">
                              <input
                                type="checkbox"
                                checked={selectedTexts.has(group.text)}
                                onChange={() => toggleCacheSelect(group.text)}
                                onClick={e => e.stopPropagation()}
                                className="w-3.5 h-3.5 accent-blue-600"
                              />
                            </td>
                            <td className="py-1.5 px-2 align-top">
                              <span className="text-text-primary break-all">{group.text}</span>
                              {group.inDict && (
                                <span className="ml-1 text-2xs text-blue-500 bg-blue-500/10 px-1 rounded">
                                  {t('inDict')}
                                </span>
                              )}
                            </td>
                            {LANG_COLS.map(col => (
                              <td key={col.code} className="py-1.5 px-2 align-top">
                                <span
                                  className={clsx(
                                    `break-all ${group.translations[col.code] ? 'text-text-primary' : 'text-text-secondary opacity-40'}`,
                                  )}
                                >
                                  {group.translations[col.code] || '—'}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}
    </>
  );
};

export default TranslationDictEditor;
