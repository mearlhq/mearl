import {
  useState,
  useRef,
  FC,
  useMemo,
  MouseEvent,
  KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  ReactNode,
  createContext,
  useCallback,
  useContext,
} from 'react';
import { useSafeFocus } from '../../../../shared/hooks/useSafeFocus';
import {
  Plus,
  Minus,
  Check,
  X,
  Copy,
  Route,
  Braces,
  Pin,
  SquarePen,
  UnfoldVertical,
  FoldVertical,
  ArrowUpToLine,
} from 'lucide-react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { PrefixBadge } from './PrefixBadge';
import { JsonTreePrimitive } from './JsonTreePrimitive';
import { AddItemForm } from './AddItemForm';
import {
  formatJson,
  getStringFormatTooltipText,
  StringFormat,
  tryParseJsonString,
  serializeWithFormat,
} from '../../utils/helpers';
import { t } from '../../utils/i18n';
import { copyToClipboard as copyText } from '../../utils/clipboard';
import { clsx } from 'clsx';
import {
  isPrimitive,
  isExpandable,
  getPreview,
  isCompactable,
  convertJsonToTypeScript,
} from '../../utils/jsonHelpers';
import { countJsonTreeMatches, useJsonTreeSearch } from './useJsonTreeSearch';
import { useJsonTreeEdit } from './useJsonTreeEdit';
import { isImeComposing } from './keyboard';
import { useBlurCommitGuard } from './useBlurCommitGuard';

const JsonTextEditModal = lazy(() =>
  import('./JsonTextEditModal').then(m => ({ default: m.JsonTextEditModal })),
);

const MAX_DEPTH = 12; // 限制最大处理深度为 12 层

type JsonTreeInteractionKind = 'add' | 'edit-value' | 'edit-key' | 'edit-modal';

interface ActiveJsonTreeInteraction {
  kind: JsonTreeInteractionKind;
  id: string;
  path: string[];
}

export interface JsonTreeInteraction {
  type: 'add' | 'edit';
  path: string[];
}

interface JsonTreeInteractionController {
  active: ActiveJsonTreeInteraction | null;
  activate: (interaction: ActiveJsonTreeInteraction) => void;
  deactivate: (interaction: Pick<ActiveJsonTreeInteraction, 'kind' | 'id'>) => void;
  deactivateOwner: (id: string) => void;
}

const JsonTreeInteractionContext = createContext<JsonTreeInteractionController | null>(null);

interface JsonTreeProps {
  data: any;
  name?: string;
  depth?: number;
  path?: string[];
  parentData?: any;
  parentFormat?: StringFormat;
  parentPrefix?: string;
  onPinField?: (path: string[], value: any) => void;
  onValueChange?: (path: string[], newValue: any) => void;
  onParsed?: (result: { parsed: any; format?: StringFormat; prefix?: string }) => void;
  editable?: boolean;
  searchQuery?: string;
  currentMatchIndex?: number;
  matchNavigationVersion?: number;
  onMatchesFound?: (count: number) => void;
  onInteractionChange?: (interaction: JsonTreeInteraction | null) => void;
  matchStartIndex?: number;
  defaultExpandAll?: boolean;
  expandedPaths?: Record<string, boolean>;
  onToggleExpand?: (paths: Record<string, boolean>) => void;
  pathPrefix?: string;
  defaultExpandDepth?: number;
  defaultRawFormats?: string[];
}

export const JsonTree: FC<JsonTreeProps> = props => {
  const [activeInteraction, setActiveInteraction] = useState<ActiveJsonTreeInteraction | null>(
    null,
  );
  const activeInteractionRef = useRef<ActiveJsonTreeInteraction | null>(null);
  const onInteractionChangeRef = useRef(props.onInteractionChange);
  onInteractionChangeRef.current = props.onInteractionChange;

  const updateInteraction = useCallback((interaction: ActiveJsonTreeInteraction | null) => {
    activeInteractionRef.current = interaction;
    setActiveInteraction(interaction);
    onInteractionChangeRef.current?.(
      interaction
        ? {
            type: interaction.kind === 'add' ? 'add' : 'edit',
            path: interaction.path,
          }
        : null,
    );
  }, []);

  const activate = useCallback(
    (interaction: ActiveJsonTreeInteraction) => {
      const current = activeInteractionRef.current;
      if (current?.kind === interaction.kind && current.id === interaction.id) return;
      updateInteraction(interaction);
    },
    [updateInteraction],
  );

  const deactivate = useCallback(
    (interaction: Pick<ActiveJsonTreeInteraction, 'kind' | 'id'>) => {
      const current = activeInteractionRef.current;
      if (current?.kind !== interaction.kind || current.id !== interaction.id) return;
      updateInteraction(null);
    },
    [updateInteraction],
  );

  const deactivateOwner = useCallback(
    (id: string) => {
      if (activeInteractionRef.current?.id !== id) return;
      updateInteraction(null);
    },
    [updateInteraction],
  );

  useEffect(
    () => () => {
      if (!activeInteractionRef.current) return;
      activeInteractionRef.current = null;
      onInteractionChangeRef.current?.(null);
    },
    [],
  );

  const controller = useMemo(
    () => ({ active: activeInteraction, activate, deactivate, deactivateOwner }),
    [activeInteraction, activate, deactivate, deactivateOwner],
  );

  return (
    <JsonTreeInteractionContext.Provider value={controller}>
      <JsonTreeNode {...props} />
    </JsonTreeInteractionContext.Provider>
  );
};

const JsonTreeNode: FC<JsonTreeProps> = ({
  data,
  name,
  depth = 0,
  path = [],
  parentData,
  parentFormat,
  parentPrefix,
  onPinField,
  onValueChange,
  editable = false,
  searchQuery = '',
  currentMatchIndex = 0,
  matchNavigationVersion = 0,
  onMatchesFound,
  matchStartIndex = 0,
  defaultExpandAll = false,
  expandedPaths,
  onToggleExpand,
  pathPrefix = '',
  defaultExpandDepth = 2,
  onParsed,
  defaultRawFormats,
}) => {
  const interactionController = useContext(JsonTreeInteractionContext);
  if (!interactionController) {
    throw new Error('JsonTreeNode must be rendered inside JsonTreeInteractionContext');
  }

  // 获取当前节点的完整路径（包含 name）
  const currentPath = name ? [...path, name] : path;
  const interactionId = JSON.stringify(currentPath);
  const currentPathStr = currentPath.join('.');
  const pathKey = pathPrefix
    ? currentPathStr
      ? `${pathPrefix}.${currentPathStr}`
      : pathPrefix
    : currentPathStr;

  // 自动尝试解析 JSON 字符串或其他特殊格式，传入 depth 使非顶层 URL 不被识别
  const {
    parsed: parsedData,
    format,
    prefix,
  } = useMemo(() => tryParseJsonString(data, depth), [data, depth]);

  // 顶层解析完成后通知外部
  useEffect(() => {
    if (depth === 0 && onParsed) {
      onParsed({ parsed: parsedData, format, prefix });
    }
  }, [parsedData, format, prefix]);

  // 判断是否为空对象或空数组
  const isEmpty = useMemo(() => {
    if (Array.isArray(parsedData)) {
      return parsedData.length === 0;
    }
    if (parsedData && typeof parsedData === 'object' && parsedData !== null) {
      return Object.keys(parsedData).length === 0;
    }
    return false;
  }, [parsedData]);

  // 自动展开逻辑：depth < defaultExpandDepth 且不是空对象/空数组
  // 根节点（depth=0）不受 isCompactable 影响，确保至少展开一层
  const defaultExpanded =
    (defaultExpandAll || depth < defaultExpandDepth) &&
    !isEmpty &&
    (depth === 0 || !isCompactable(parsedData));
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // 如果有外部控制，使用外部状态；否则使用本地状态
  const expanded =
    expandedPaths && onToggleExpand ? (expandedPaths[pathKey] ?? defaultExpanded) : isExpanded;

  const toggleExpand = () => {
    if (onToggleExpand) {
      // 使用批量更新方式，传递单个路径
      onToggleExpand({ [pathKey]: !expanded });
    } else {
      setIsExpanded(!isExpanded);
    }
  };

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const elementRef = useRef<HTMLDivElement>(null);
  const isAddingItem =
    interactionController.active?.kind === 'add' &&
    interactionController.active.id === interactionId;

  const setAddItemFormOpen = (open: boolean) => {
    if (open) {
      interactionController.activate({ kind: 'add', id: interactionId, path: [...currentPath] });
      return;
    }
    interactionController.deactivate({ kind: 'add', id: interactionId });
  };

  useEffect(() => {
    return () => interactionController.deactivateOwner(interactionId);
  }, [interactionController.deactivateOwner, interactionId]);

  // 弹窗编辑状态
  const textEditOpen =
    interactionController.active?.kind === 'edit-modal' &&
    interactionController.active.id === interactionId;
  const handleCloseTextEdit = () => {
    interactionController.deactivate({ kind: 'edit-modal', id: interactionId });
  };

  // 原始字符串 / 解析格式切换
  const [showRaw, setShowRaw] = useState(
    () => !!(format && defaultRawFormats?.includes(format.id)),
  );
  const canToggleRaw = !!format && typeof data === 'string';

  const handleBadgeClick = (e: MouseEvent) => {
    e.stopPropagation();
    setShowRaw(prev => !prev);
  };

  // 使用搜索 Hook
  // raw 模式下搜索原始字符串；否则搜索解析后的数据
  const searchData = showRaw && canToggleRaw ? data : parsedData;
  const { isMatch, highlightText, occurrenceCount, nameOccurrenceCount } = useJsonTreeSearch({
    data: searchData,
    name,
    depth,
    searchQuery,
    currentMatchIndex,
    matchNavigationVersion,
    onMatchesFound,
    matchStartIndex,
    pathKey,
    expanded,
    onToggleExpand,
    setIsExpanded,
    elementRef,
  });

  // 使用编辑 Hook
  const valueInteractionActive =
    interactionController.active?.kind === 'edit-value' &&
    interactionController.active.id === interactionId;
  const {
    isEditing,
    editValue,
    setEditValue,
    handleValueClick,
    handleSaveEdit,
    handleBlurEdit,
    handleDirectValueChange,
    handleCancelEdit,
    handleKeyDown,
  } = useJsonTreeEdit({
    data: parsedData,
    rawData: canToggleRaw ? data : undefined,
    showRaw: showRaw && canToggleRaw,
    path,
    name,
    onValueChange,
    active: valueInteractionActive,
    onEditStart: () =>
      interactionController.activate({
        kind: 'edit-value',
        id: interactionId,
        path: [...currentPath],
      }),
    onEditEnd: () => interactionController.deactivate({ kind: 'edit-value', id: interactionId }),
  });

  // key 编辑状态（只有对象的 key 才可以重命名，数组索引不可重命名）
  const canEditKey =
    editable &&
    !!onValueChange &&
    name !== undefined &&
    !!parentData &&
    typeof parentData === 'object' &&
    !Array.isArray(parentData);
  const [locallyEditingKey, setLocallyEditingKey] = useState(false);
  const [editKeyValue, setEditKeyValue] = useState('');
  const keyBlurCommitGuard = useBlurCommitGuard();
  const keyInputRef = useRef<HTMLInputElement>(null);
  const keyInteractionActive =
    interactionController.active?.kind === 'edit-key' &&
    interactionController.active.id === interactionId;
  const isEditingKey = locallyEditingKey && keyInteractionActive;
  useSafeFocus(keyInputRef, { enabled: isEditingKey });

  const handleCancelKeyEdit = () => {
    keyBlurCommitGuard.finishEdit();
    setLocallyEditingKey(false);
    interactionController.deactivate({ kind: 'edit-key', id: interactionId });
  };

  const handleKeyClick = (e: MouseEvent) => {
    e.stopPropagation();
    handleCancelEdit();
    interactionController.activate({
      kind: 'edit-key',
      id: interactionId,
      path: [...currentPath],
    });
    keyBlurCommitGuard.beginEdit();
    setEditKeyValue(name!);
    setLocallyEditingKey(true);
  };

  const commitKeyEdit = (value: string) => {
    const newKey = value.trim();
    if (
      newKey &&
      newKey !== name &&
      parentData &&
      typeof parentData === 'object' &&
      !Array.isArray(parentData) &&
      !Object.prototype.hasOwnProperty.call(parentData, newKey) &&
      onValueChange
    ) {
      const newParent: Record<string, any> = {};
      for (const k of Object.keys(parentData)) {
        newParent[k === name ? newKey : k] = parentData[k];
      }
      onValueChange(
        path,
        parentFormat ? serializeWithFormat(newParent, parentFormat, parentPrefix) : newParent,
      );
    }
  };

  const handleSaveKeyEdit = () => {
    keyBlurCommitGuard.finishEdit();
    commitKeyEdit(editKeyValue);
    setLocallyEditingKey(false);
    interactionController.deactivate({ kind: 'edit-key', id: interactionId });
  };

  const handleKeyBlur = (value: string) => {
    if (keyBlurCommitGuard.consumeBlur()) return;
    commitKeyEdit(value);
    setLocallyEditingKey(false);
    interactionController.deactivate({ kind: 'edit-key', id: interactionId });
  };

  const handleKeyNameKeyDown = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveKeyEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancelKeyEdit();
    }
  };

  // 渲染 key 节点（叶子节点和非叶子节点共用）
  const renderKeyNode = (): ReactNode => {
    if (!name) return null;
    if (isEditingKey) {
      return (
        <div
          className="flex items-center gap-1 -mt-0.5 translate-y-px"
          onClick={e => e.stopPropagation()}
        >
          <input
            ref={keyInputRef}
            type="text"
            value={editKeyValue}
            onChange={e => setEditKeyValue(e.target.value)}
            onKeyDown={handleKeyNameKeyDown}
            onBlur={e => handleKeyBlur(e.currentTarget.value)}
            size={Math.max(editKeyValue.length, 1)}
            className="px-1.25 py-0 border border-accent-blue rounded bg-bg-secondary text-json-key font-medium outline-none"
          />
          <button
            onMouseDown={e => {
              e.preventDefault();
              handleSaveKeyEdit();
            }}
            className="p-0.5 rounded bg-green-500 text-white cursor-pointer shrink-0"
            title={t('save')}
          >
            <Check size={12} />
          </button>
          <button
            onMouseDown={e => {
              e.preventDefault();
              handleCancelKeyEdit();
            }}
            className="p-0.5 rounded bg-red-500 text-white cursor-pointer shrink-0"
            title={t('cancel')}
          >
            <X size={12} />
          </button>
          <span className="text-json-key font-medium">:</span>
        </div>
      );
    }
    return (
      <span
        className={clsx(
          'text-json-key font-medium stroke-0 mr-1 shrink-0',
          canEditKey && 'cursor-pointer hover:underline',
        )}
        onClick={canEditKey ? handleKeyClick : undefined}
        title={canEditKey ? t('renameKey') : undefined}
      >
        {searchQuery && name.toString().toLowerCase().includes(searchQuery.toLowerCase())
          ? highlightText(name.toString())
          : name}
        :
      </span>
    );
  };

  // 处理右键菜单
  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
    });
  };

  // 复制功能
  const copyToClipboard = async (text: string) => {
    const success = await copyText(text);
    if (!success) {
      console.error('复制失败');
    }
  };

  // 获取要复制的值（跟随展示模式）
  const getValueToCopy = () => {
    if (showRaw && canToggleRaw) {
      return data as string;
    }
    return formatJson(parsedData);
  };

  // 递归展开所有子节点
  const recursiveExpand = () => {
    if (!onToggleExpand) return;

    const pathsToExpand: Record<string, boolean> = {};
    const queue: Array<{ data: any; prefix: string; currentDepth: number }> = [
      { data: parsedData, prefix: pathKey, currentDepth: 0 },
    ];

    while (queue.length > 0) {
      const { data: currentData, prefix, currentDepth } = queue.shift()!;
      if (currentDepth >= MAX_DEPTH) continue;

      const { parsed } = tryParseJsonString(currentData);

      if (isExpandable(parsed)) {
        const isEmptyNode = Array.isArray(parsed)
          ? parsed.length === 0
          : parsed &&
            typeof parsed === 'object' &&
            parsed !== null &&
            Object.keys(parsed).length === 0;

        if (isEmptyNode || isCompactable(parsed)) continue;

        pathsToExpand[prefix] = true;

        const childEntries = Array.isArray(parsed)
          ? parsed.map((item, idx) => [idx.toString(), item])
          : Object.entries(parsed || {});

        childEntries.forEach(([key, value]) => {
          const childPath = prefix ? `${prefix}.${key}` : key;
          queue.push({ data: value, prefix: childPath, currentDepth: currentDepth + 1 });
        });
      }
    }

    onToggleExpand(pathsToExpand);
  };

  // 递归收起所有子节点
  const recursiveCollapse = () => {
    if (!onToggleExpand) return;

    const childEntries = Array.isArray(parsedData)
      ? parsedData.map((item, idx) => [idx.toString(), item])
      : Object.entries(parsedData || {});

    const hasExpandedChild = childEntries.some(([key, value]) => {
      const childPath = pathKey ? `${pathKey}.${key}` : key;
      // 显式设置了状态时，以显式状态为准
      if (expandedPaths?.[childPath] !== undefined) {
        return expandedPaths[childPath];
      }
      // 否则检查是否处于默认展开状态（depth < defaultExpandDepth 且非空/非紧凑）
      const { parsed: childParsed } = tryParseJsonString(value);
      if (!isExpandable(childParsed)) return false;
      const isEmpty = Array.isArray(childParsed)
        ? childParsed.length === 0
        : !childParsed || Object.keys(childParsed).length === 0;
      return (
        (defaultExpandAll || depth + 1 < defaultExpandDepth) &&
        !isEmpty &&
        !isCompactable(childParsed)
      );
    });

    if (hasExpandedChild) {
      // 有展开的子级，递归收起所有子节点
      const pathsToCollapse: Record<string, boolean> = {};
      const queue: Array<{ data: any; prefix: string; isRoot: boolean; currentDepth: number }> = [
        { data: parsedData, prefix: pathKey, isRoot: true, currentDepth: 0 },
      ];

      while (queue.length > 0) {
        const { data: currentData, prefix, isRoot, currentDepth } = queue.shift()!;
        if (currentDepth >= MAX_DEPTH) continue;

        const { parsed } = tryParseJsonString(currentData);

        if (isExpandable(parsed)) {
          if (!isRoot) {
            pathsToCollapse[prefix] = false;
          }

          const childEntries = Array.isArray(parsed)
            ? parsed.map((item, idx) => [idx.toString(), item])
            : Object.entries(parsed || {});

          childEntries.forEach(([key, value]) => {
            const childPath = prefix ? `${prefix}.${key}` : key;
            queue.push({
              data: value,
              prefix: childPath,
              isRoot: false,
              currentDepth: currentDepth + 1,
            });
          });
        }
      }

      onToggleExpand(pathsToCollapse);
    } else {
      // 所有子级都已收起，收起当前节点
      onToggleExpand({ [pathKey]: false });
    }
  };

  // 处理展开/收起按钮点击
  const handleToggleClick = (e: MouseEvent) => {
    if (e.metaKey && onToggleExpand) {
      // Command 键：递归展开
      recursiveExpand();
    } else if (e.altKey && onToggleExpand) {
      // Option 键：智能收起
      recursiveCollapse();
    } else {
      // 普通点击：切换当前节点
      toggleExpand();
    }
  };

  // 收起上方所有不在当前链路上的节点
  const handleCollapseAbove = () => {
    if (!onToggleExpand || !expandedPaths) return;

    const pathsToUpdate: Record<string, boolean> = {};

    // 获取当前路径的所有父级路径段
    const currentPathSegments = pathKey ? pathKey.split('.') : [];
    const parentPaths = new Set<string>();

    // 构建父级路径集合（从根到当前节点的完整链路）
    for (let i = 0; i < currentPathSegments.length; i++) {
      const parentPath = currentPathSegments.slice(0, i + 1).join('.');
      parentPaths.add(parentPath);
    }

    // 遍历所有展开的路径
    Object.keys(expandedPaths).forEach(path => {
      if (!expandedPaths[path]) return;

      // 如果这个路径不在当前节点的父级链路上，也不是当前节点本身
      if (!parentPaths.has(path) && path !== pathKey) {
        // 检查这个路径是否是当前链路上某个节点的兄弟
        // 即：它的父路径在当前链路中
        const pathSegments = path.split('.');
        const pathParent = pathSegments.slice(0, -1).join('.');

        // 如果它的父节点在当前链路中，说明它是链路上节点的兄弟，应该被收起
        if (parentPaths.has(pathParent) || pathParent === '') {
          pathsToUpdate[path] = false;
        }
      }
    });

    onToggleExpand(pathsToUpdate);
    setContextMenu(null);

    // 延迟滚动，等待 DOM 更新完成
    setTimeout(() => {
      if (elementRef.current) {
        elementRef.current.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    }, 100);
  };

  // 递归展开/收起子节点的菜单项（仅在显示箭头的可展开节点上有意义）
  const getRecursiveExpandItems = (): ContextMenuItem[] => {
    return [
      {
        label: t('recursiveExpand'),
        icon: <UnfoldVertical className="w-3.5 h-3.5" />,
        onClick: () => {
          recursiveExpand();
          setContextMenu(null);
        },
      },
      {
        label: t('recursiveCollapse'),
        icon: <FoldVertical className="w-3.5 h-3.5" />,
        onClick: () => {
          recursiveCollapse();
          setContextMenu(null);
        },
      },
    ];
  };

  // 生成当前路径字符串（兼容对象和数组格式）
  const getCurrentPathString = (): string => {
    if (currentPath.length === 0) return '';

    return currentPath.reduce((acc, key, index) => {
      if (index === 0) return key;
      // 数组索引使用 [] 格式，对象属性使用 . 格式
      if (/^\d+$/.test(key)) {
        return `${acc}[${key}]`;
      }
      return `${acc}.${key}`;
    }, '');
  };

  // 生成上下文菜单项
  const getContextMenuItems = (): ContextMenuItem[] => {
    // 复制三件套平铺展示
    const items: ContextMenuItem[] = [
      {
        label: t('copyValue'),
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => copyToClipboard(getValueToCopy()),
      },
      {
        label: t('copyPath'),
        icon: <Route className="w-3.5 h-3.5" />,
        onClick: () => copyToClipboard(getCurrentPathString()),
      },
      {
        label: t('copyType'),
        icon: <Braces className="w-3.5 h-3.5" />,
        onClick: async () => copyToClipboard(await convertJsonToTypeScript(parsedData, name, path)),
      },
    ];

    // 添加"关注"选项
    if (onPinField) {
      items.push({
        label: t('pinField'),
        icon: <Pin className="w-3.5 h-3.5" />,
        onClick: () => {
          onPinField(currentPath, parsedData);
          setContextMenu(null);
        },
      });
    }

    // 可编辑模式下：弹窗编辑
    if (editable && onValueChange) {
      const hasExpandable = isExpandable(parsedData);
      if (hasExpandable) {
        items.push({ divider: true });
        items.push({
          label: t('editInModal'),
          icon: <SquarePen className="w-3.5 h-3.5" />,
          onClick: () => {
            interactionController.activate({
              kind: 'edit-modal',
              id: interactionId,
              path: [...currentPath],
            });
            setContextMenu(null);
          },
        });
      }
    }

    // 展开/收起相关菜单项统一合并到末尾
    const expandItems: ContextMenuItem[] = [];

    // 递归展开/收起：仅在显示箭头的可展开节点上
    if (isExpandable(parsedData) && !(showRaw && canToggleRaw)) {
      expandItems.push(...getRecursiveExpandItems());
    }

    // 收起上方：任意节点都提供（依赖受控展开状态）
    if (onToggleExpand && expandedPaths) {
      if (expandItems.length) expandItems.push({ divider: true });
      expandItems.push({
        label: t('collapseAbove'),
        icon: <ArrowUpToLine className="w-3.5 h-3.5" />,
        onClick: handleCollapseAbove,
      });
    }

    if (expandItems.length) {
      items.push({ divider: true });
      items.push(...expandItems);
    }

    return items;
  };

  const canAdd = editable && !!onValueChange && isExpandable(parsedData);
  const canRemove = editable && !!onValueChange && name !== undefined;

  // 渲染格式标签（统一使用 format.badge）
  const renderFormatBadge = (toggled: boolean) => {
    if (!format) return null;
    if (depth === 0 && format.id === 'json') return null;

    return (
      <PrefixBadge
        text={
          format.badge.text === 'Query'
            ? t('queryString')
            : format.badge.text === 'Encoded'
              ? t('encoded')
              : format.badge.text
        }
        tooltip={
          canToggleRaw
            ? t('clickToToggleFormat')
            : getStringFormatTooltipText(format.badge.tooltipKey)
        }
        variant={format.badge.variant}
        onClick={canToggleRaw ? handleBadgeClick : undefined}
        toggled={toggled}
      />
    );
  };

  const primitiveRowClass = `group/row flex items-start py-0.5 px-1 -mx-1 rounded ${isMatch ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`;

  // 叶子节点箭头占位符（与可展开节点的箭头按钮等宽，保证字段名纵向对齐）
  const arrowPlaceholder = depth > 0 ? <span className="w-4 shrink-0" /> : null;

  // 原始字符串模式渲染
  if (showRaw && canToggleRaw) {
    return (
      <div
        ref={elementRef}
        className={primitiveRowClass}
        onContextMenu={handleContextMenu}
        data-json-path={pathKey}
      >
        {arrowPlaceholder}
        {renderKeyNode()}
        <JsonTreePrimitive
          data={data}
          format={format}
          prefix={prefix}
          searchQuery={searchQuery}
          isMatch={isMatch}
          highlightText={highlightText}
          nameOccurrenceCount={nameOccurrenceCount}
          editable={editable}
          isEditing={isEditing}
          editValue={editValue}
          setEditValue={setEditValue}
          handleValueClick={handleValueClick}
          handleSaveEdit={handleSaveEdit}
          handleBlurEdit={handleBlurEdit}
          handleDirectValueChange={handleDirectValueChange}
          handleCancelEdit={handleCancelEdit}
          handleKeyDown={handleKeyDown}
          contextMenu={contextMenu}
          contextMenuItems={getContextMenuItems()}
          setContextMenu={setContextMenu}
          onToggleRaw={handleBadgeClick}
          toggled={true}
          onRemove={canRemove ? () => onValueChange!(currentPath, undefined) : undefined}
        />
      </div>
    );
  }

  if (isPrimitive(parsedData)) {
    return (
      <div
        ref={elementRef}
        className={primitiveRowClass}
        onContextMenu={handleContextMenu}
        data-json-path={pathKey}
      >
        {arrowPlaceholder}
        {renderKeyNode()}
        <JsonTreePrimitive
          data={parsedData}
          format={format}
          prefix={prefix}
          searchQuery={searchQuery}
          isMatch={isMatch}
          highlightText={highlightText}
          nameOccurrenceCount={nameOccurrenceCount}
          editable={editable}
          isEditing={isEditing}
          editValue={editValue}
          setEditValue={setEditValue}
          handleValueClick={handleValueClick}
          handleSaveEdit={handleSaveEdit}
          handleBlurEdit={handleBlurEdit}
          handleDirectValueChange={handleDirectValueChange}
          handleCancelEdit={handleCancelEdit}
          handleKeyDown={handleKeyDown}
          contextMenu={contextMenu}
          contextMenuItems={getContextMenuItems()}
          setContextMenu={setContextMenu}
          onToggleRaw={canToggleRaw ? handleBadgeClick : undefined}
          onRemove={canRemove ? () => onValueChange!(currentPath, undefined) : undefined}
        />
      </div>
    );
  }

  const entries = Array.isArray(parsedData)
    ? parsedData.map((item, idx) => [idx.toString(), item])
    : Object.entries(parsedData || {});
  let nextChildMatchIndex = matchStartIndex + occurrenceCount;

  // 检查是否是紧凑模式（preview 包含完整 JSON）
  const preview = getPreview(parsedData);
  const isCompactPreview = !expanded && isCompactable(parsedData);

  return (
    <>
      <div className="py-0.5">
        <div
          ref={elementRef}
          className={clsx(
            `group/row flex items-start px-1 -mx-1 rounded ${isMatch ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`,
          )}
          onContextMenu={handleContextMenu}
          data-json-path={pathKey}
        >
          {isExpandable(parsedData) && (
            <button
              onClick={handleToggleClick}
              className="w-4 h-4 flex items-center justify-center shrink-0 transition-colors text-text-secondary hover:text-text-primary focus:outline-none"
            >
              <svg
                width="8"
                height="10"
                viewBox="0 0 8 10"
                fill="currentColor"
                className={clsx('transition-transform', expanded && 'rotate-90')}
              >
                <path d="M2 1L6 5L2 9z" />
              </svg>
            </button>
          )}
          {renderKeyNode()}
          {renderFormatBadge(false)}
          <span className="text-text-secondary">
            {!isCompactPreview && (Array.isArray(parsedData) ? '[' : '{')}
            {!expanded && (
              <span className={isCompactPreview ? '' : 'ml-1 opacity-70'}>{preview}</span>
            )}
          </span>
          {(canAdd || (!expanded && canRemove)) && (
            <div className="opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0 mt-px">
              {canAdd && (
                <button
                  className="flex items-center justify-center w-3.5 h-3.5 rounded text-text-secondary hover:text-green-500"
                  onClick={e => {
                    e.stopPropagation();
                    setAddItemFormOpen(true);
                    if (!expanded) {
                      if (onToggleExpand) onToggleExpand({ [pathKey]: true });
                      else setIsExpanded(true);
                    }
                  }}
                  title={Array.isArray(parsedData) ? t('addElement') : t('addProperty')}
                >
                  <Plus size={11} />
                </button>
              )}
              {!expanded && canRemove && (
                <button
                  className="flex items-center justify-center w-3.5 h-3.5 rounded text-text-secondary hover:text-red-500"
                  onClick={e => {
                    e.stopPropagation();
                    onValueChange!(currentPath, undefined);
                  }}
                  title={t('removeField')}
                >
                  <Minus size={11} />
                </button>
              )}
            </div>
          )}
        </div>

        {expanded && (
          <div
            className={clsx(`ml-1.5 pl-1.5 border-l border-border ${depth > 5 ? 'min-w-130' : ''}`)}
          >
            {/* 新增元素的表单 - 移到顶部 */}
            {isAddingItem && onValueChange && (
              <AddItemForm
                data={parsedData}
                format={format}
                prefix={prefix}
                currentPath={currentPath}
                onValueChange={onValueChange}
                onCancel={() => setAddItemFormOpen(false)}
              />
            )}

            {entries.map(([key, value]) => {
              const childMatchStartIndex = nextChildMatchIndex;
              nextChildMatchIndex += countJsonTreeMatches(value, searchQuery, key);

              return (
                <div key={key} className="relative">
                  <JsonTreeNode
                    name={key}
                    data={value}
                    depth={depth + 1}
                    path={currentPath}
                    parentData={parsedData}
                    parentFormat={format}
                    parentPrefix={prefix}
                    onPinField={onPinField}
                    onValueChange={onValueChange}
                    editable={editable}
                    searchQuery={searchQuery}
                    currentMatchIndex={currentMatchIndex}
                    matchNavigationVersion={matchNavigationVersion}
                    matchStartIndex={childMatchStartIndex}
                    defaultExpandAll={defaultExpandAll}
                    expandedPaths={expandedPaths}
                    onToggleExpand={onToggleExpand}
                    pathPrefix={pathPrefix}
                    defaultExpandDepth={defaultExpandDepth}
                  />
                </div>
              );
            })}
          </div>
        )}

        {expanded && (
          <div className="group/row ml-1 flex items-start gap-1 py-0.5 px-1 -mx-1 rounded hover:bg-bg-hover">
            <span className="text-text-secondary">{Array.isArray(parsedData) ? ']' : '}'}</span>
            {canRemove && (
              <button
                className="opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center w-3.5 h-3.5 rounded text-text-secondary hover:text-red-500 shrink-0 mt-px"
                onClick={e => {
                  e.stopPropagation();
                  onValueChange!(currentPath, undefined);
                }}
                title={t('removeField')}
              >
                <Minus size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}

      <Suspense fallback={null}>
        <JsonTextEditModal
          isOpen={textEditOpen}
          onClose={handleCloseTextEdit}
          name={name}
          data={parsedData}
          onSave={value => {
            const finalValue = format ? serializeWithFormat(value, format, prefix) : value;
            onValueChange!(currentPath, finalValue);
          }}
        />
      </Suspense>
    </>
  );
};
