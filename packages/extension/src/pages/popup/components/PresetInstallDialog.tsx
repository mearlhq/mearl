import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { SHOW_PRESET_INSTALLATION_POPUP } from '../../../shared/installation';

const Installation = lazy(async () => ({
  default: (await import('../../installation/Installation')).Installation,
}));

export function PresetInstallDialog() {
  const [session, setSession] = useState<string>();
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (!chrome.extension?.getViews({ type: 'popup' }).includes(window)) return;
    const listener = (
      message: { action?: string; session?: string },
      sender: chrome.runtime.MessageSender,
      reply: (response: { opened: boolean }) => void,
    ) => {
      if (
        message?.action !== SHOW_PRESET_INSTALLATION_POPUP ||
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        typeof message.session !== 'string' ||
        (current.current && current.current !== message.session)
      )
        return;
      current.current = message.session;
      setSession(message.session);
      reply({ opened: true });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <Installation
        key={session}
        embeddedSession={session}
        onClose={() => {
          current.current = null;
          setSession(undefined);
        }}
      />
    </Suspense>
  );
}
