import { FC, ReactNode, useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../../utils/i18n';

interface FilterBarToggleButtonProps {
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * 放置在搜索框右侧的折叠/展开按钮
 */
export const FilterBarToggleButton: FC<FilterBarToggleButtonProps> = ({ collapsed, onToggle }) => (
  <button
    onClick={onToggle}
    title={collapsed ? t('expandFilterBar') : t('collapseFilterBar')}
    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
  >
    <ChevronDown
      className={clsx('w-3 h-3 transition-transform duration-200', !collapsed && 'rotate-180')}
    />
  </button>
);

interface CollapsibleFilterChipsProps {
  collapsed: boolean;
  /** storage 初始化完成后才允许开启动画，防止回填时触发过渡 */
  ready: boolean;
  children: ReactNode;
}

/**
 * 带高度折叠动画的快筛区域容器
 * 仅在 storage 初始化完成且经过一帧稳定后开启 transition，
 * 避免挂载 / 切换模式 / storage 异步回填时误触动画
 */
export const CollapsibleFilterChips: FC<CollapsibleFilterChipsProps> = ({
  collapsed,
  ready,
  children,
}) => {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, [ready]);

  return (
    <div
      className={clsx(
        'grid',
        animated && 'transition-[grid-template-rows] duration-200 ease-in-out',
      )}
      style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
};
