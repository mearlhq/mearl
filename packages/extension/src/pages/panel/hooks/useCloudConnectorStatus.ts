import { useEffect, useRef, useState } from 'react';
import { requestExtensionService } from '../../../shared/extensionServiceRequest';

export interface CloudConnectorState {
  connected: boolean;
  serverUrl: string | null;
  name: string | null;
  pid: number | null;
}

interface CloudConnectorItem {
  serverUrl: string;
  name?: string;
  pid: number;
}

interface CloudConnectorListResult {
  connectors?: CloudConnectorItem[];
}

const formatConnectorError = (error: unknown): string => {
  if (!error) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const useCloudConnectorStatus = (enabled = true) => {
  const [state, setState] = useState<CloudConnectorState>({
    connected: false,
    serverUrl: null,
    name: null,
    pid: null,
  });
  const [loading, setLoading] = useState(false);
  const requestGenerationRef = useRef(0);
  const loadingRequestRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);

  if (enabledRef.current !== enabled) {
    enabledRef.current = enabled;
    requestGenerationRef.current += 1;
  }

  const beginRequest = () => {
    requestGenerationRef.current += 1;
    return requestGenerationRef.current;
  };

  const canApplyRequest = (generation: number) =>
    enabledRef.current && requestGenerationRef.current === generation;

  const applyConnectorList = (result?: CloudConnectorListResult | null) => {
    if (result?.connectors && result.connectors.length > 0) {
      const connector = result.connectors[0];
      setState({
        connected: true,
        serverUrl: connector.serverUrl,
        name: connector.name || null,
        pid: connector.pid,
      });
    } else {
      setState({
        connected: false,
        serverUrl: null,
        name: null,
        pid: null,
      });
    }
  };

  const checkStatus = async () => {
    const generation = beginRequest();
    if (!enabled) {
      applyConnectorList(null);
      return;
    }
    try {
      const result = await requestExtensionService('list_cloud_connectors', {});
      if (canApplyRequest(generation)) applyConnectorList(result);
    } catch {
      if (canApplyRequest(generation)) applyConnectorList(null);
    }
  };

  useEffect(() => {
    if (!enabled) {
      applyConnectorList(null);
      loadingRequestRef.current = null;
      setLoading(false);
      return;
    }
    void checkStatus();
    const handleMessage = (message: any) => {
      if (message?.action === 'cloudConnectorStatusChanged' && enabledRef.current) {
        beginRequest();
        applyConnectorList(message.data);
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [enabled]);

  const startConnector = async (
    serverUrl: string,
  ): Promise<{ success: boolean; error?: string }> => {
    if (!enabled) return { success: false, error: 'Agent service is disabled' };
    const generation = beginRequest();
    loadingRequestRef.current = generation;
    setLoading(true);
    try {
      const result = await requestExtensionService('start_cloud_connector', { serverUrl });

      if (result?.success) {
        if (canApplyRequest(generation)) {
          setState({
            connected: true,
            serverUrl,
            name: typeof result.name === 'string' ? result.name : null,
            pid: result.pid || null,
          });
        }
        return { success: true };
      }

      return {
        success: false,
        error: formatConnectorError(result?.error) || 'Failed to start connector',
      };
    } catch (error) {
      return { success: false, error: formatConnectorError(error) };
    } finally {
      if (loadingRequestRef.current === generation) {
        loadingRequestRef.current = null;
        setLoading(false);
      }
    }
  };

  const stopConnector = async (
    serverUrl: string,
  ): Promise<{ success: boolean; error?: string }> => {
    if (!enabled) return { success: false, error: 'Agent service is disabled' };
    const generation = beginRequest();
    loadingRequestRef.current = generation;
    setLoading(true);
    try {
      const result = await requestExtensionService('stop_cloud_connector', { serverUrl });

      if (result?.success) {
        if (canApplyRequest(generation)) applyConnectorList(null);
        return { success: true };
      }

      return {
        success: false,
        error: formatConnectorError(result?.error) || 'Failed to stop connector',
      };
    } catch (error) {
      return { success: false, error: formatConnectorError(error) };
    } finally {
      if (loadingRequestRef.current === generation) {
        loadingRequestRef.current = null;
        setLoading(false);
      }
    }
  };

  return { state, loading, startConnector, stopConnector, checkStatus };
};
