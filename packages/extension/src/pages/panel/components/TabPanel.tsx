import { ReactNode, useEffect, FC, RefObject } from 'react';
import { clsx } from 'clsx';

interface Tab {
  id: string;
  label: string;
  content: ReactNode;
  badge?: string | number;
}

interface TabPanelProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  contentRef?: RefObject<HTMLDivElement | null>;
  rightActions?: ReactNode;
}

export const TabPanel: FC<TabPanelProps> = ({
  tabs,
  activeTab,
  onTabChange,
  contentRef,
  rightActions,
}) => {
  // 处理双击 Tab 回到顶部
  const handleTabDoubleClick = (tabId: string) => {
    if (activeTab === tabId && contentRef?.current) {
      contentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // 处理键盘事件 - Tab 键切换
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 处理 Tab 键和 Shift+Tab
      if (e.key === 'Tab') {
        // 如果焦点在输入框、文本域等可编辑元素上，不拦截
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest?.('[role="dialog"]')
        ) {
          return;
        }

        e.preventDefault();

        // 找到当前激活的 tab 索引
        const currentIndex = tabs.findIndex(tab => tab.id === activeTab);
        if (currentIndex === -1) return;

        let nextIndex: number;
        if (e.shiftKey) {
          // Shift+Tab：逆向切换到上一个 tab（循环）
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        } else {
          // Tab：正向切换到下一个 tab（循环）
          nextIndex = (currentIndex + 1) % tabs.length;
        }

        onTabChange(tabs[nextIndex].id);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [tabs, activeTab, onTabChange]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab 头部 */}
      <div className="flex items-center border-b border-border bg-bg-primary">
        <div className="flex items-center flex-1 overflow-x-auto overflow-y-hidden">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              onDoubleClick={() => handleTabDoubleClick(tab.id)}
              className={clsx(`
                px-4 py-1.25 text-xs font-medium transition-colors relative focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0
                ${
                  activeTab === tab.id
                    ? 'text-text-primary bg-bg-secondary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-secondary/50'
                }
              `)}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <span className="ml-1.5 px-1.5 py-0.5 text-2xs rounded bg-text-secondary/20 text-text-secondary">
                  {tab.badge}
                </span>
              )}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 translate-y-px bg-blue-500" />
              )}
            </button>
          ))}
        </div>
        {rightActions && <div className="flex items-center pr-2 shrink-0">{rightActions}</div>}
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-y-auto" ref={contentRef}>
        {tabs.find(tab => tab.id === activeTab)?.content}
      </div>
    </div>
  );
};
