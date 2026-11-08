import { useEffect, useState } from 'react';
import { Popup } from '../popup/Popup';
import { getConfig, onConfigChange } from '../panel/utils/config';
import { SidepanelChat } from './SidepanelChat';

interface SidepanelAppProps {
  windowId: number | null;
}

export function SidepanelApp({ windowId }: SidepanelAppProps) {
  const [agentEnabled, setAgentEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    let agentConfigChanged = false;
    void getConfig().then(config => {
      if (active && !agentConfigChanged) setAgentEnabled(config.agentEnabled);
    });
    const unsubscribe = onConfigChange(changes => {
      if (changes.agentEnabled !== undefined) {
        agentConfigChanged = true;
        setAgentEnabled(changes.agentEnabled);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (agentEnabled === null) {
    return <div className="w-screen h-screen bg-bg-primary" />;
  }

  return agentEnabled ? <SidepanelChat windowId={windowId} /> : <Popup isSidePanel />;
}
