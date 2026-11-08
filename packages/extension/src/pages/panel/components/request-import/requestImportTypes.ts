export interface RequestImportModalProps {
  isOpen: boolean;
  requestImportEnabled?: boolean;
  onClose: () => void;
  onImportMock: (override: {
    apiName: string;
    responseData: any;
    conditions?: Record<string, any>;
  }) => Promise<any>;
  /** 点击顶部 请求用例 入口时打开 请求用例 测试用例弹窗 */
  onOpenRequestCases?: () => void;
  /** API names sourced from the current request list (deduped, ordered by recency). Used to populate the API selector inside the modal. */
  requestApiNames?: string[];
}
