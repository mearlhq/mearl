import { FC } from 'react';
import { safeDecodeURIComponent } from '../utils/helpers';

interface CookieDisplayProps {
  cookies: Array<{ name: string; value: string }>;
}

export const CookieDisplay: FC<CookieDisplayProps> = ({ cookies }) => {
  return (
    <div className="border border-border rounded p-2 space-y-0.5 max-h-80 overflow-y-auto bg-bg-secondary">
      {cookies.map((cookie, idx) => (
        <div key={idx} className="flex py-1 border-b border-border last:border-b-0">
          <div className="w-40 font-mono break-all text-2xs text-accent-blue">{cookie.name}</div>
          <div className="flex-1 font-mono break-all text-2xs text-text-primary">
            {safeDecodeURIComponent(cookie.value)}
          </div>
        </div>
      ))}
    </div>
  );
};
