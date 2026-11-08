import { useState, useRef, useEffect, useCallback, FC, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Code,
  LayoutList,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Layers,
  ExternalLink,
} from 'lucide-react';
import { t, getCurrentLanguage } from '../../panel/utils/i18n';
import { useBrowserUiSettings } from '../../panel/utils/browserUiSettings';
import { browserUiText } from '@mearl/preset/bundles';
import type { BrowserRulePreset } from '../../../shared/browserRulePresets';
import {
  StoredRuleForm,
  DEV_RULES_STORAGE_KEY,
  storedFormToRule,
  filterDevRules,
  type ActionType,
  type RequestHeaderOperation,
} from '../../../shared/devRulesUtils';
import { CodeEditor } from '../../panel/components/CodeEditor';
import {
  checkDevRulePermissions,
  type RulePermissionCheck,
} from '../../../shared/devRulePermissions';

// ─── Types ──────────────────────────────────────────────────────────────────

// RuleForm extends StoredRuleForm with UI-only fields
interface RuleForm extends StoredRuleForm {
  _key: string;
  collapsed: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'script',
  'stylesheet',
  'image',
  'xmlhttprequest',
  'websocket',
  'other',
];

const ACTION_TYPES: { value: ActionType; label: () => string; desc: () => string }[] = [
  {
    value: 'redirect',
    label: () => t('ruleActionRedirect'),
    desc: () => t('ruleActionRedirectDesc'),
  },
  { value: 'block', label: () => t('ruleActionBlock'), desc: () => t('ruleActionBlockDesc') },
  { value: 'allow', label: () => t('ruleActionAllow'), desc: () => t('ruleActionAllowDesc') },
  {
    value: 'upgradeScheme',
    label: () => t('ruleActionUpgradeScheme'),
    desc: () => t('ruleActionUpgradeSchemeDesc'),
  },
  {
    value: 'modifyHeaders',
    label: () => t('ruleActionModifyHeaders'),
    desc: () => t('ruleActionModifyHeadersDesc'),
  },
];

// ─── Preset rules ───────────────────────────────────────────────────────────────────────

// ─── Conversion helpers ───────────────────────────────────────────────────────

function defaultForm(id: number): RuleForm {
  return {
    _key: `${id}_${Date.now()}`,
    id,
    priority: 1,
    actionType: 'redirect',
    redirectType: 'regexSubstitution',
    regexSubstitution: '',
    redirectUrl: '',
    filterType: 'regexFilter',
    regexFilter: '',
    urlFilter: '',
    initiatorDomains: '',
    resourceTypes: ['main_frame'],
    requestHeaders: [],
    responseHeaders: [],
    description: '',
    collapsed: false,
    enabled: true,
  };
}

/** Strip UI-only fields before storage / Chrome API */
function formToStored(f: RuleForm): StoredRuleForm {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _key, collapsed, ...stored } = f;
  return stored;
}

function ruleToForm(rule: chrome.declarativeNetRequest.Rule): RuleForm {
  const action = rule.action as Record<string, any>;
  const condition = rule.condition as Record<string, any>;
  const hasRegexSub = action?.redirect?.regexSubstitution !== undefined;
  return {
    _key: `${rule.id}_${Date.now()}`,
    id: rule.id,
    priority: rule.priority ?? 1,
    actionType: (action?.type as ActionType) ?? 'redirect',
    redirectType: hasRegexSub ? 'regexSubstitution' : 'url',
    regexSubstitution: action?.redirect?.regexSubstitution ?? '',
    redirectUrl: action?.redirect?.url ?? '',
    filterType: condition?.regexFilter !== undefined ? 'regexFilter' : 'urlFilter',
    regexFilter: condition?.regexFilter ?? '',
    urlFilter: condition?.urlFilter ?? '',
    initiatorDomains: ((condition?.initiatorDomains as string[]) ?? []).join(', '),
    resourceTypes: (condition?.resourceTypes as string[]) ?? [],
    requestHeaders: ((action?.requestHeaders ?? []) as RequestHeaderOperation[]).map(h => ({
      header: h.header ?? '',
      operation: h.operation ?? 'set',
      value: h.value ?? '',
    })),
    responseHeaders: ((action?.responseHeaders ?? []) as RequestHeaderOperation[]).map(h => ({
      header: h.header ?? '',
      operation: h.operation ?? 'set',
      value: h.value ?? '',
    })),
    description: '',
    collapsed: true,
  };
}

/** Load from stored form config (may have alpha placeholders in substitution) */
function storedToForm(s: StoredRuleForm, collapsed = true): RuleForm {
  return { ...s, _key: `${s.id}_${Date.now()}`, collapsed };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const inputCls =
  'w-full resize-none rounded-md border border-border bg-bg-secondary/40 px-2 py-1 text-2xs text-text-primary placeholder:text-text-secondary/60 focus:border-blue-400 focus:outline-none font-mono';

const labelCls = 'mb-1 block text-3xs text-text-secondary';

const segBtn = (active: boolean) =>
  clsx('cursor-pointer rounded-md px-2 py-1 text-2xs transition-colors', {
    'bg-blue-600/10 font-medium text-blue-600 dark:text-blue-400': active,
    'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary': !active,
  });

// ─── RuleCard ─────────────────────────────────────────────────────────────────

interface RuleCardProps {
  form: RuleForm;
  index: number;
  onChange: (f: RuleForm, immediate?: boolean) => void;
  onRemove: () => void;
}

const RuleCard: FC<RuleCardProps> = ({ form, index, onChange, onRemove }) => {
  const update = (patch: Partial<RuleForm>, immediate = false) =>
    onChange({ ...form, ...patch }, immediate);

  const toggleResource = (rt: string) => {
    const next = form.resourceTypes.includes(rt)
      ? form.resourceTypes.filter(r => r !== rt)
      : [...form.resourceTypes, rt];
    update({ resourceTypes: next });
  };

  const curAction = ACTION_TYPES.find(a => a.value === form.actionType);

  const isEnabled = form.enabled !== false;

  return (
    <div
      className={clsx(
        'overflow-hidden rounded border border-border bg-bg-primary transition-opacity',
        !isEnabled && 'opacity-50',
      )}
    >
      <div className="flex items-stretch bg-bg-secondary/60">
        <button
          type="button"
          onClick={() => update({ collapsed: !form.collapsed })}
          className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left"
          aria-expanded={!form.collapsed}
        >
          <ChevronRight
            className={clsx(
              'h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform',
              !form.collapsed && 'rotate-90',
            )}
          />
          <span className="shrink-0 whitespace-nowrap text-xs font-medium text-text-primary">
            {t('ruleN', String(index + 1))}
          </span>
          <span className="shrink-0 whitespace-nowrap rounded-sm bg-blue-600/10 px-1.5 py-0.5 text-3xs font-medium text-blue-600 dark:text-blue-400">
            {curAction ? curAction.label() : form.actionType}
          </span>
          {form.description && (
            <span className="min-w-0 truncate text-2xs text-text-secondary">
              {form.description}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1 pr-2">
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-3xs text-text-secondary">
            {t('rulePriority')}
            <input
              type="number"
              min={1}
              value={form.priority}
              onChange={e => update({ priority: parseInt(e.target.value) || 1 })}
              className="w-14 rounded border border-border bg-bg-primary px-1 py-0.5 text-center text-2xs text-text-primary tabular-nums"
            />
          </label>
          {/* Enable toggle */}
          <button
            onClick={() => update({ enabled: !isEnabled }, true)}
            className={clsx(
              'relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors',
              isEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
            )}
            role="switch"
            aria-checked={isEnabled}
            title={isEnabled ? t('enabled') : t('disabled')}
          >
            <span
              className={clsx(
                'pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                isEnabled ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
          <button
            onClick={onRemove}
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-red-600/10 hover:text-red-500"
            title={t('delete')}
            aria-label={t('delete')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!form.collapsed && (
        <div className="space-y-2.5 border-t border-border p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {ACTION_TYPES.map(({ value, label, desc }) => (
                <button
                  key={value}
                  title={desc()}
                  onClick={() => update({ actionType: value })}
                  className={segBtn(form.actionType === value)}
                >
                  {label()}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={form.description ?? ''}
              onChange={e => update({ description: e.target.value })}
              placeholder={t('ruleDescriptionPlaceholder')}
              className="ml-auto w-40 max-w-full rounded-md border border-border bg-bg-secondary/40 px-2 py-1 text-2xs text-text-primary placeholder:text-text-secondary/60 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Request headers editor (modifyHeaders only) */}
          {form.actionType === 'modifyHeaders' && (
            <div className="space-y-3">
              {/* Request headers */}
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <span className={labelCls.replace('mb-1 block', '')}>
                    {t('ruleRequestHeaders')}
                  </span>
                  <button
                    onClick={() =>
                      update({
                        requestHeaders: [
                          ...(form.requestHeaders ?? []),
                          { header: '', operation: 'set', value: '' },
                        ],
                      })
                    }
                    className="text-text-secondary hover:text-blue-500 transition-colors cursor-pointer"
                    title={t('ruleHeaderAdd')}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <div className="space-y-1.5">
                  {(form.requestHeaders ?? []).map((h, hi) => (
                    <div key={hi} className="flex items-center gap-1.5">
                      <div className="relative shrink-0">
                        <select
                          value={h.operation}
                          onChange={e => {
                            const headers = (form.requestHeaders ?? []).map((x, j) =>
                              j === hi
                                ? {
                                    ...x,
                                    operation: e.target
                                      .value as RequestHeaderOperation['operation'],
                                  }
                                : x,
                            );
                            update({ requestHeaders: headers });
                          }}
                          className="appearance-none text-xs bg-bg-primary border border-border rounded pl-1.5 pr-6 py-1 text-text-primary"
                        >
                          <option value="set">{t('ruleHeaderOpSet')}</option>
                          <option value="append">{t('ruleHeaderOpAppend')}</option>
                          <option value="remove">{t('ruleHeaderOpRemove')}</option>
                        </select>
                        <ChevronDown
                          aria-hidden="true"
                          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-secondary"
                        />
                      </div>
                      <input
                        type="text"
                        className="flex-1 text-xs bg-bg-primary border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-blue-400 placeholder:text-text-secondary font-mono"
                        placeholder="header-name"
                        value={h.header}
                        onChange={e => {
                          const headers = (form.requestHeaders ?? []).map((x, j) =>
                            j === hi ? { ...x, header: e.target.value } : x,
                          );
                          update({ requestHeaders: headers });
                        }}
                      />
                      {h.operation !== 'remove' && (
                        <input
                          type="text"
                          className="flex-1 text-xs bg-bg-primary border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-blue-400 placeholder:text-text-secondary font-mono"
                          placeholder="value"
                          value={h.value}
                          onChange={e => {
                            const headers = (form.requestHeaders ?? []).map((x, j) =>
                              j === hi ? { ...x, value: e.target.value } : x,
                            );
                            update({ requestHeaders: headers });
                          }}
                        />
                      )}
                      <button
                        onClick={() =>
                          update({
                            requestHeaders: (form.requestHeaders ?? []).filter((_, j) => j !== hi),
                          })
                        }
                        className="text-text-secondary hover:text-red-500 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {/* Response headers */}
              <div>
                <div className="flex items-center gap-1 mb-1">
                  <span className={labelCls.replace('mb-1 block', '')}>
                    {t('ruleResponseHeaders')}
                  </span>
                  <button
                    onClick={() =>
                      update({
                        responseHeaders: [
                          ...(form.responseHeaders ?? []),
                          { header: '', operation: 'set', value: '' },
                        ],
                      })
                    }
                    className="text-text-secondary hover:text-blue-500 transition-colors cursor-pointer"
                    title={t('ruleHeaderAdd')}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <div className="space-y-1.5">
                  {(form.responseHeaders ?? []).map((h, hi) => (
                    <div key={hi} className="flex items-center gap-1.5">
                      <div className="relative shrink-0">
                        <select
                          value={h.operation}
                          onChange={e => {
                            const headers = (form.responseHeaders ?? []).map((x, j) =>
                              j === hi
                                ? {
                                    ...x,
                                    operation: e.target
                                      .value as RequestHeaderOperation['operation'],
                                  }
                                : x,
                            );
                            update({ responseHeaders: headers });
                          }}
                          className="appearance-none text-xs bg-bg-primary border border-border rounded pl-1.5 pr-6 py-1 text-text-primary"
                        >
                          <option value="set">{t('ruleHeaderOpSet')}</option>
                          <option value="append">{t('ruleHeaderOpAppend')}</option>
                          <option value="remove">{t('ruleHeaderOpRemove')}</option>
                        </select>
                        <ChevronDown
                          aria-hidden="true"
                          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-secondary"
                        />
                      </div>
                      <input
                        type="text"
                        className="flex-1 text-xs bg-bg-primary border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-blue-400 placeholder:text-text-secondary font-mono"
                        placeholder="header-name"
                        value={h.header}
                        onChange={e => {
                          const headers = (form.responseHeaders ?? []).map((x, j) =>
                            j === hi ? { ...x, header: e.target.value } : x,
                          );
                          update({ responseHeaders: headers });
                        }}
                      />
                      {h.operation !== 'remove' && (
                        <input
                          type="text"
                          className="flex-1 text-xs bg-bg-primary border border-border rounded px-2 py-1 text-text-primary focus:outline-none focus:border-blue-400 placeholder:text-text-secondary font-mono"
                          placeholder="value"
                          value={h.value}
                          onChange={e => {
                            const headers = (form.responseHeaders ?? []).map((x, j) =>
                              j === hi ? { ...x, value: e.target.value } : x,
                            );
                            update({ responseHeaders: headers });
                          }}
                        />
                      )}
                      <button
                        onClick={() =>
                          update({
                            responseHeaders: (form.responseHeaders ?? []).filter(
                              (_, j) => j !== hi,
                            ),
                          })
                        }
                        className="text-text-secondary hover:text-red-500 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Match URL + Target URL (2-col when redirect, responsive) */}
          <div
            className={clsx(
              'grid gap-3',
              form.actionType === 'redirect' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1',
            )}
          >
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs text-text-secondary">{t('ruleMatchUrl')}</span>
                <div className="flex-1" />
                <button
                  onClick={() => update({ filterType: 'regexFilter' })}
                  className={segBtn(form.filterType === 'regexFilter')}
                >
                  {t('ruleRegexFilter')}
                </button>
                <button
                  onClick={() => update({ filterType: 'urlFilter' })}
                  className={segBtn(form.filterType === 'urlFilter')}
                >
                  {t('ruleUrlFilter')}
                </button>
              </div>
              <textarea
                rows={2}
                className={inputCls}
                placeholder={
                  form.filterType === 'regexFilter'
                    ? String.raw`^https://example\.com/pages/([^/?]+)(\?.*)?$`
                    : 'https://example.com/*'
                }
                value={form.filterType === 'regexFilter' ? form.regexFilter : form.urlFilter}
                onChange={e =>
                  update(
                    form.filterType === 'regexFilter'
                      ? { regexFilter: e.target.value }
                      : { urlFilter: e.target.value },
                  )
                }
              />
            </div>

            {form.actionType === 'redirect' && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs text-text-secondary">{t('ruleTargetUrl')}</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => update({ redirectType: 'regexSubstitution' })}
                    className={segBtn(form.redirectType === 'regexSubstitution')}
                    title={t('regexCaptureGroupHint')}
                  >
                    {t('ruleRegexSubstitution')}
                  </button>
                  <button
                    onClick={() => update({ redirectType: 'url' })}
                    className={segBtn(form.redirectType === 'url')}
                  >
                    {t('ruleFixedUrl')}
                  </button>
                </div>
                {form.redirectType === 'regexSubstitution' ? (
                  <textarea
                    rows={2}
                    className={inputCls}
                    placeholder={`https://example.com/pages/\\1/index.html\\2`}
                    value={form.regexSubstitution}
                    onChange={e => update({ regexSubstitution: e.target.value })}
                  />
                ) : (
                  <textarea
                    rows={2}
                    className={inputCls}
                    placeholder="https://example.com/redirect"
                    value={form.redirectUrl}
                    onChange={e => update({ redirectUrl: e.target.value })}
                  />
                )}
              </div>
            )}
          </div>

          {/* Initiator domains + resource types (responsive 2-col) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>
                {t('ruleInitiatorDomains')}
                <span className="opacity-50 ml-1">({t('ruleInitiatorDomainsHint')})</span>
              </label>
              <textarea
                rows={2}
                className={inputCls}
                placeholder={t('ruleInitiatorDomainsPlaceholder')}
                value={form.initiatorDomains}
                onChange={e => update({ initiatorDomains: e.target.value })}
              />
            </div>
            <div className="flex flex-col">
              <label className={labelCls}>
                {t('ruleResourceTypes')}
                <span className="opacity-50 ml-1">({t('ruleResourceTypesHint')})</span>
              </label>
              <div className="flex-1 flex flex-wrap gap-x-3 gap-y-1 items-center content-center -mt-1">
                {RESOURCE_TYPES.map(rt => (
                  <label key={rt} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.resourceTypes.includes(rt)}
                      onChange={() => toggleResource(rt)}
                      className="w-3 h-3 accent-blue-600"
                    />
                    <span className="text-xs text-text-primary font-mono">{rt}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── RulesEditor ─────────────────────────────────────────────────────────────

interface RulesEditorProps {
  onBack?: () => void;
  headerActions?: ReactNode;
}

const RulesEditor: FC<RulesEditorProps> = ({ onBack, headerActions }) => {
  const { rulePresets = {} } = useBrowserUiSettings();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [forms, setForms] = useState<RuleForm[]>([]);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rulesCount, setRulesCount] = useState(0);
  const [presetOpen, setPresetOpen] = useState(false);
  const [permissions, setPermissions] = useState<RulePermissionCheck>({
    missingOrigins: [],
    hasUnscopedRules: false,
  });
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const permissionDialogRef = useRef<HTMLDialogElement>(null);
  const promptedOriginsRef = useRef(new Set<string>());
  const permissionFormsRef = useRef<StoredRuleForm[]>([]);
  const permissionCheckRef = useRef(0);
  const [localDnrIndicatorMode, setLocalDnrIndicatorMode] = useState<'number' | 'dot' | 'off'>(
    'dot',
  );
  const presetRef = useRef<HTMLDivElement>(null);
  const enabledRef = useRef(false);
  const formsRef = useRef<RuleForm[]>([]);
  const editedRef = useRef(false);
  const mountedRef = useRef(true);
  const saveRevisionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<StoredRuleForm[] | null>(null);

  useEffect(() => {
    chrome.storage.sync.get({ dnrIndicatorMode: 'dot' }, result => {
      const storedMode = result['dnrIndicatorMode'];
      if (storedMode === 'number' || storedMode === 'dot' || storedMode === 'off') {
        setLocalDnrIndicatorMode(storedMode);
      }
    });
  }, []);

  useEffect(() => {
    chrome.storage.local.get([DEV_RULES_STORAGE_KEY, 'devRulesEnabled'], result => {
      const isEnabled = result['devRulesEnabled'] !== false;
      enabledRef.current = isEnabled;
      setEnabled(isEnabled);
      const stored: StoredRuleForm[] | undefined = result[DEV_RULES_STORAGE_KEY];
      if (stored && stored.length > 0) {
        formsRef.current = stored.map(s => storedToForm(s));
        setForms(formsRef.current);
        setJsonText(JSON.stringify(stored.map(storedFormToRule), null, 2));
        permissionFormsRef.current = stored;
        if (isEnabled) void refreshPermissions();
      }
      // 从 DNR 获取实际应用的规则数，确保显示的是真正生效的规则数量
      chrome.declarativeNetRequest.getDynamicRules(rules => {
        // 仅显示用户可配置的 dev rules，隐藏内置规则（UA/redirect/MCP 临时规则）
        const userRules = filterDevRules(rules);
        if (!editedRef.current) setRulesCount(userRules.length);
        if (!editedRef.current && (!stored || stored.length === 0) && userRules.length > 0) {
          formsRef.current = userRules.map(r => ruleToForm(r));
          setForms(formsRef.current);
          setJsonText(JSON.stringify(userRules, null, 2));
          permissionFormsRef.current = formsRef.current.map(formToStored);
          if (isEnabled) void refreshPermissions();
        }
      });
    });
  }, []);

  useEffect(() => {
    if (!presetOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) {
        setPresetOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [presetOpen]);

  const loadPreset = (preset: BrowserRulePreset, loadMode: 'replace' | 'append') => {
    if (loadMode === 'replace') {
      changeForms(preset.rules.map(r => storedToForm(r, false)), true);
    } else {
      const maxId = formsRef.current.reduce((max, f) => Math.max(max, f.id), 0);
      const offsetRules = preset.rules.map((r, i) => ({ ...r, id: maxId + i + 1 }));
      changeForms([...formsRef.current, ...offsetRules.map(r => storedToForm(r, false))], true);
    }
  };

  const handleToggleEnabled = (next: boolean) => {
    enabledRef.current = next;
    setEnabled(next);
    scheduleSave(formsRef.current.map(formToStored), true);
  };

  const handleDnrIndicatorModeChange = (nextMode: 'number' | 'dot' | 'off') => {
    setLocalDnrIndicatorMode(nextMode);
    chrome.storage.sync.set({ dnrIndicatorMode: nextMode });
  };

  const switchToJson = () => {
    flushPendingSave();
    // Use StoredRuleForm format to preserve full initiatorDomains (including path patterns)
    setJsonText(JSON.stringify(formsRef.current.map(formToStored), null, 2));
    setJsonError(null);
    setMode('json');
  };

  const switchToForm = () => {
    try {
      changeForms(parseJsonForms(jsonText).map(s => storedToForm(s)));
      flushPendingSave();
      setJsonError(null);
      setMode('form');
    } catch (e) {
      setJsonError(t('rulesJsonParseError', (e as Error).message));
    }
  };

  const addRule = () => {
    const maxId = formsRef.current.reduce((max, f) => Math.max(max, f.id), 0);
    changeForms([...formsRef.current, defaultForm(maxId + 1)]);
  };

  // Send the snapshot synchronously to the worker: an accepted save can finish even
  // after this Popup closes. The worker serializes persistence and DNR updates.
  function flushPendingSave() {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const storedForms = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!storedForms) return;
    const revision = saveRevisionRef.current;
    void chrome.runtime.sendMessage({ action: 'saveDevRules', forms: storedForms, enabled: enabledRef.current })
      .then(result => {
        if (!mountedRef.current || revision !== saveRevisionRef.current) return;
        if (typeof result?.rulesCount === 'number') setRulesCount(result.rulesCount);
        if (!result?.success) throw new Error(result?.error || t('saveFailed'));
      })
      .catch(error => {
        if (mountedRef.current && revision === saveRevisionRef.current)
          setSaveError(t('rulesSaveFailed', error instanceof Error ? error.message : String(error)));
      });
  }

  function scheduleSave(storedForms: StoredRuleForm[], immediate = false) {
    editedRef.current = true;
    saveRevisionRef.current++;
    pendingSaveRef.current = storedForms;
    setSaveError(null);
    permissionFormsRef.current = storedForms;
    if (enabledRef.current) void refreshPermissions();
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    if (immediate) flushPendingSave();
    else saveTimerRef.current = setTimeout(flushPendingSave, 400);
  }

  function changeForms(next: RuleForm[], immediate = false) {
    const previous = formsRef.current.map(formToStored);
    formsRef.current = next;
    setForms(next);
    const stored = next.map(formToStored);
    if (JSON.stringify(previous) !== JSON.stringify(stored)) scheduleSave(stored, immediate);
  }

  function parseJsonForms(text: string): StoredRuleForm[] {
    const parsed = JSON.parse(text || '[]');
    if (!Array.isArray(parsed)) throw new Error('must be an array');
    const isStoredForm = parsed.length === 0 || parsed[0].actionType !== undefined;
    const stored = isStoredForm ? parsed : parsed.map((r: chrome.declarativeNetRequest.Rule) => formToStored(ruleToForm(r)));
    stored.forEach(storedFormToRule);
    return stored;
  }

  function changeJson(text: string) {
    setJsonText(text);
    setJsonError(null);
    try {
      const stored = parseJsonForms(text);
      formsRef.current = stored.map(s => storedToForm(s));
      scheduleSave(stored);
    } catch {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      saveRevisionRef.current++;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const flush = () => flushPendingSave();
    window.addEventListener('pagehide', flush);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', flush);
      flushPendingSave();
    };
  }, []);

  const refreshPermissions = useCallback(async () => {
    const checkId = ++permissionCheckRef.current;
    try {
      const result = await checkDevRulePermissions(permissionFormsRef.current);
      if (checkId !== permissionCheckRef.current) return;
      setPermissions(result);
      if (result.missingOrigins.some(origin => !promptedOriginsRef.current.has(origin))) {
        result.missingOrigins.forEach(origin => promptedOriginsRef.current.add(origin));
        setPermissionError(false);
        if (!permissionDialogRef.current?.open) permissionDialogRef.current?.showModal();
      } else if (!result.missingOrigins.length) {
        permissionDialogRef.current?.close();
      }
    } catch {
      if (checkId === permissionCheckRef.current) setPermissionError(true);
    }
  }, []);

  useEffect(() => {
    const refresh = () => {
      if (enabledRef.current) void refreshPermissions();
    };
    const added = chrome.permissions.onAdded as chrome.events.Event<
      (permissions: chrome.permissions.Permissions) => void
    >;
    const removed = chrome.permissions.onRemoved as chrome.events.Event<
      (permissions: chrome.permissions.Permissions) => void
    >;
    added.addListener(refresh);
    removed.addListener(refresh);
    return () => {
      permissionCheckRef.current++;
      added.removeListener(refresh);
      removed.removeListener(refresh);
    };
  }, [refreshPermissions]);

  const requestPermissions = async () => {
    // Start the browser prompt synchronously from this confirmation click.
    const request = chrome.permissions.request({ origins: permissions.missingOrigins });
    setPermissionBusy(true);
    setPermissionError(false);
    try {
      const granted = await request;
      setPermissionError(!granted);
      if (granted) await refreshPermissions();
    } catch {
      setPermissionError(true);
    } finally {
      setPermissionBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary" data-testid="rules-editor">
      <div
        className="flex items-center justify-between border-b border-border bg-toolbar px-2 py-1.5"
        data-testid="rules-editor-header"
      >
        <div className="flex min-w-0 items-center gap-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              title={t('toolboxBack')}
              aria-label={t('toolboxBack')}
              className="shrink-0 cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-xs font-medium text-text-primary">{t('rulesConfig')}</h2>
          <p className="truncate text-3xs text-text-secondary">
            {t('rulesConfigDesc')}
            {enabled && rulesCount > 0 && ` · ${t('rulesCurrentCount', String(rulesCount))}`}
          </p>
        </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {headerActions}
          <a
            href="https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest?hl=zh-cn"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title={t('rulesConfigDocs')}
            aria-label={t('rulesConfigDocs')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {enabled === null ? (
            <span className="h-4 w-7 shrink-0" aria-hidden="true" />
          ) : (
            <button
              onClick={() => handleToggleEnabled(!enabled)}
              className={clsx(
                'relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
              )}
              role="switch"
              aria-checked={enabled}
              aria-label={t('rulesConfig')}
            >
              <span
                className={clsx(
                  'pointer-events-none inline-block h-3 w-3 rounded-full bg-white transition-transform',
                  enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                )}
              />
            </button>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-between gap-2 border-b border-border bg-bg-secondary/40 px-2 py-1.5"
        data-testid="rules-editor-toolbar"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-3xs text-text-secondary">{t('dnrIndicatorMode')}</span>
          <div className="flex items-center gap-0.5 rounded-lg bg-bg-hover p-px">
            {(['number', 'dot', 'off'] as const).map(m => (
              <button
                key={m}
                onClick={() => handleDnrIndicatorModeChange(m)}
                className={clsx(
                  'cursor-pointer whitespace-nowrap rounded-md px-1.5 py-0.5 text-3xs transition-colors',
                  localDnrIndicatorMode === m
                    ? 'bg-bg-primary font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-bg-primary/60 hover:text-text-primary',
                )}
              >
                {m === 'number'
                  ? t('dnrIndicatorModeNumber')
                  : m === 'dot'
                    ? t('dnrIndicatorModeDot')
                    : t('dnrIndicatorModeOff')}
              </button>
            ))}
          </div>
        </div>
        {enabled && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-bg-hover p-px">
            <button
              onClick={() => mode === 'json' && switchToForm()}
              className={clsx(
                'flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-3xs transition-colors',
                mode === 'form'
                  ? 'bg-bg-primary font-medium text-text-primary'
                  : 'text-text-secondary hover:bg-bg-primary/60 hover:text-text-primary',
              )}
            >
              <LayoutList className="w-3 h-3" />
              {t('ruleModeForm')}
            </button>
            <button
              onClick={() => mode === 'form' && switchToJson()}
              className={clsx(
                'flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-3xs transition-colors',
                mode === 'json'
                  ? 'bg-bg-primary font-medium text-text-primary'
                  : 'text-text-secondary hover:bg-bg-primary/60 hover:text-text-primary',
              )}
            >
              <Code className="w-3 h-3" />
              {t('ruleModeJson')}
            </button>
          </div>
        )}
      </div>

      {saveError && <div role="alert" className="px-2 py-1 text-xs text-red-500">{saveError}</div>}
      {enabled === null ? (
        <div className="min-h-0 flex-1" data-testid="rules-editor-loading" />
      ) : enabled ? (
        <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="rules-editor-content">
          {(permissions.missingOrigins.length > 0 ||
            permissions.hasUnscopedRules ||
            permissionError) && (
            <div
              className="mb-2 rounded border border-warning-border bg-warning-bg p-2 text-xs text-warning-text"
              role="status"
            >
              {permissions.missingOrigins.length > 0 && (
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-all">
                    {t('rulePermissionMissing', permissions.missingOrigins.join(', '))}
                  </span>
                  <button
                    onClick={() => permissionDialogRef.current?.showModal()}
                    className="shrink-0 cursor-pointer underline"
                  >
                    {t('rulePermissionGrant')}
                  </button>
                </div>
              )}
              {permissions.hasUnscopedRules && <p>{t('rulePermissionUnscoped')}</p>}
              {permissionError && <p>{t('rulePermissionFailed')}</p>}
            </div>
          )}
          {/* Form mode */}
          {mode === 'form' && (
            <div className="space-y-2">
              {forms.map((f, i) => (
                <RuleCard
                  key={f._key}
                  form={f}
                  index={i}
                  onChange={(nf, immediate) => changeForms(formsRef.current.map(old => old._key === f._key ? nf : old), immediate)}
                  onRemove={() => changeForms(formsRef.current.filter(old => old._key !== f._key), true)}
                />
              ))}
              {/* Add rule dropdown */}
              <div className="relative" ref={presetRef}>
                <button
                  onClick={() => setPresetOpen(v => !v)}
                  className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-border py-1.5 text-xs text-text-secondary transition-colors hover:border-blue-400 hover:text-blue-500"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('ruleAddRule')}
                  <ChevronDown
                    className={clsx('w-3 h-3 transition-transform', presetOpen && 'rotate-180')}
                  />
                </button>

                {presetOpen && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-primary border border-border rounded shadow-lg overflow-hidden">
                    {/* Blank rule */}
                    <button
                      onClick={() => {
                        addRule();
                        setPresetOpen(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-secondary transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
                      <span className="text-xs text-text-primary">{t('ruleAddBlank')}</span>
                    </button>

                    {/* Presets */}
                    {Object.values(rulePresets).map(preset => (
                      <button
                        key={preset.name}
                        onClick={() => {
                          loadPreset(preset, 'append');
                          setPresetOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-border hover:bg-bg-secondary transition-colors"
                      >
                        <Layers className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-text-primary">{preset.name}</div>
                          <div className="text-xs text-text-secondary truncate mt-0.5">
                            {browserUiText(preset.description, getCurrentLanguage())}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* JSON mode */}
          {mode === 'json' && (
            <div>
              <CodeEditor
                code={jsonText}
                language="json"
                onChange={changeJson}
                minHeightClass="min-h-64"
                showToolbar={true}
              />
            </div>
          )}

          {/* Error */}
          {jsonError && (
            <div className="flex items-start gap-1.5 mt-2 text-xs text-red-500">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{jsonError}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
          <div className="text-xs font-medium text-text-primary">{t('rulesDisabledTitle')}</div>
          <div className="mt-1 text-3xs text-text-secondary">{t('rulesDisabledHint')}</div>
        </div>
      )}
      <dialog
        ref={permissionDialogRef}
        aria-labelledby="rule-permission-title"
        onCancel={event => {
          if (permissionBusy) event.preventDefault();
        }}
        className="m-auto w-88 max-w-[calc(100%-2rem)] rounded-lg border border-border bg-bg-primary p-4 text-text-primary shadow-xl backdrop:bg-black/20"
      >
        <h3 id="rule-permission-title" className="text-sm font-medium">
          {t('rulePermissionTitle')}
        </h3>
        <p className="mt-2 text-xs text-text-secondary">{t('rulePermissionDescription')}</p>
        <ul className="my-3 max-h-40 overflow-auto rounded border border-border bg-bg-secondary p-2 text-xs">
          {permissions.missingOrigins.map(origin => (
            <li key={origin} className="break-all">
              {origin}
            </li>
          ))}
        </ul>
        {permissionError && (
          <p role="alert" className="mb-3 text-xs text-red-500">
            {t('rulePermissionFailed')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            autoFocus
            disabled={permissionBusy}
            onClick={() => permissionDialogRef.current?.close()}
            className="cursor-pointer rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            disabled={permissionBusy || !permissions.missingOrigins.length}
            onClick={requestPermissions}
            className="cursor-pointer rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {t('rulePermissionGrant')}
          </button>
        </div>
      </dialog>
    </div>
  );
};

export default RulesEditor;
