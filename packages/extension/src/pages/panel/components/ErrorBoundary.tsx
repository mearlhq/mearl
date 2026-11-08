import { Component, ReactNode, ErrorInfo } from 'react';
import { t } from '../utils/i18n';
import { sanitizeAnalyticsText, trackEvent } from '../../../shared/analytics';
import { toError } from '../utils/errors';

type ErrorSource = 'react' | 'window' | 'promise';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      error: toError(error),
      errorInfo: null,
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = toError(error);
    console.error('Error caught by boundary:', error, errorInfo);
    this.reportError(normalizedError, 'react', errorInfo.componentStack);
    this.setState({
      error: normalizedError,
      errorInfo,
    });
  }

  // 将捕获到的异常上报到分析后台，便于线上排查
  reportError(error: Error, source: ErrorSource, componentStack?: string | null) {
    try {
      trackEvent('exception', {
        fatal: true,
        source,
        // GA4 文本参数有长度上限，做截断避免被丢弃
        name: sanitizeAnalyticsText(error?.name || 'Error', 100),
        description: sanitizeAnalyticsText(error?.message || String(error), 100),
        stack: sanitizeAnalyticsText(componentStack || error?.stack || '', 100),
      }).catch(() => {});
    } catch {
      // 上报失败不应影响错误边界自身的渲染
    }
  }

  componentDidMount() {
    // 监听全局未捕获的错误
    window.addEventListener('error', this.handleGlobalError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.handleGlobalError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  handleGlobalError = (event: ErrorEvent) => {
    console.error('Global error caught:', event.error);
    const error = toError(event.error || event.message);
    this.reportError(error, 'window');
    this.setState({
      hasError: true,
      error,
      errorInfo: null,
    });
  };

  handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    console.error('Unhandled promise rejection:', event.reason);
    const error = toError(event.reason);
    this.reportError(error, 'promise');
    this.setState({
      hasError: true,
      error,
      errorInfo: null,
    });
  };

  handleClearCache = () => {
    try {
      // 清理 localStorage
      localStorage.clear();

      // 清理 sessionStorage
      sessionStorage.clear();

      // 清理 chrome storage（如果有的话）
      if (chrome?.storage?.local) {
        chrome.storage.local.clear();
      }

      // 重新加载页面
      window.location.reload();
    } catch (err) {
      console.error('Failed to clear cache:', err);
      // 即使清理失败也尝试重新加载
      window.location.reload();
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen p-4 bg-bg-primary">
          <div className="rounded p-6 w-[40vw] min-w-xl border border-border bg-bg-secondary">
            <div className="text-3xl mb-3 text-center">⚠️</div>

            <h2 className="text-base font-medium mb-2 text-center text-text-primary">
              {t('errorBoundary_title') || '应用出现错误'}
            </h2>

            <p className="text-xs mb-4 text-center text-text-secondary">
              {t('errorBoundary_description') ||
                '抱歉，应用遇到了一个错误。你可以尝试以下操作来恢复：'}
            </p>

            <div className="flex gap-2 mb-4 flex-wrap justify-center">
              <button
                onClick={this.handleReload}
                className="px-3 py-1.5 text-xs font-medium rounded hover:opacity-80 transition-opacity bg-accent-blue text-white"
              >
                {t('errorBoundary_reload') || '重新加载'}
              </button>

              <button
                onClick={this.handleClearCache}
                className="px-3 py-1.5 text-xs font-medium rounded hover:opacity-80 transition-opacity bg-[#dc2626] text-white"
              >
                {t('errorBoundary_clearCache') || '清理缓存并重试'}
              </button>
            </div>

            <details className="text-xxs p-2 rounded mt-3 border border-border text-text-secondary bg-bg-primary">
              <summary className="cursor-pointer font-medium">
                {t('errorBoundary_errorDetails') || '错误详情'}
              </summary>
              <div className="mt-2 p-2 rounded border border-border overflow-x-auto bg-bg-secondary">
                <div className="mb-2">
                  <strong>Error:</strong>
                  <pre className="my-1 whitespace-pre-wrap wrap-break-word">
                    {this.state.error?.toString()}
                  </pre>
                </div>
                {this.state.errorInfo && (
                  <div>
                    <strong>Component Stack:</strong>
                    <pre className="my-1 whitespace-pre-wrap wrap-break-word text-2xs">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
