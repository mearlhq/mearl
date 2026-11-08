import { FC } from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, ModalHeader } from './modal';
import { t } from '../utils/i18n';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 登录页 URL，弹窗打开时加载到 iframe */
  url: string;
  /** 弹窗标题 */
  title: string;
  /** 弹窗尺寸，默认 fullscreen */
  size?: 'default' | 'fullscreen';
}

/**
 * 通用内嵌登录弹窗。
 *
 * 通过 background 安装的 DNR 规则移除目标域名的 X-Frame-Options / CSP 响应头，
 * 使登录页可以在 iframe 中加载。
 * 登录成功检测由调用方（如 useCaptureIdentity、useRequestMetadataLogin）的轮询负责。
 */
export const LoginModal: FC<LoginModalProps> = ({
  isOpen,
  onClose,
  url,
  title,
  size = 'fullscreen',
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size={size}>
      <ModalHeader
        title={title}
        onClose={onClose}
        actions={
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('openInNewPage')}
            className="transition-colors cursor-pointer text-text-secondary hover:text-text-primary"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        }
      />
      <div className="flex-1 overflow-hidden">
        <iframe
          src={isOpen ? url : 'about:blank'}
          className="w-full h-full border-0"
          title={title}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </Modal>
  );
};
