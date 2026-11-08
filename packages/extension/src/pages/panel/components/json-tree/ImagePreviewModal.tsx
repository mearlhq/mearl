import { useState, FC } from 'react';
import { Modal, ModalHeader, ModalContent } from '../modal';
import { t } from '../../utils/i18n';
import { CopyButton } from '../CopyButton';

interface ImagePreviewModalProps {
  imageUrl: string | null;
  onClose: () => void;
}

export const ImagePreviewModal: FC<ImagePreviewModalProps> = ({ imageUrl, onClose }) => {
  const [hasError, setHasError] = useState(false);

  if (!imageUrl) return null;

  return (
    <Modal isOpen={!!imageUrl} onClose={onClose} size="default">
      <ModalHeader title={t('imagePreview')} onClose={onClose} />
      <ModalContent>
        <div className="flex flex-col items-center gap-3">
          {hasError ? (
            <div className="flex items-center justify-center w-full h-64 text-red-500 bg-bg-secondary rounded border border-border">
              {t('failedToLoadImage')}
            </div>
          ) : (
            <img
              src={imageUrl}
              alt="Preview"
              className="max-w-full max-h-[70vh] object-contain rounded"
              onError={() => setHasError(true)}
            />
          )}
          <div className="flex items-center justify-between gap-2 w-full text-xs text-text-secondary break-all whitespace-break-spaces p-2 bg-bg-primary rounded border border-border">
            <span className="flex-1">{imageUrl}</span>
            <CopyButton text={imageUrl} iconOnly size="sm" />
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
};
