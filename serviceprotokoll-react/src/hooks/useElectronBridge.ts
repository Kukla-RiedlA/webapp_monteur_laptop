import { useCallback, useEffect, useRef } from 'react';
import type { MeasurementRow, ServiceProtocolFormState, TestLoadValues, WorkStep } from '../types';

export interface SpBridgePayload {
  jobId: string;
  jobs: { id: string; label: string }[];
  fabNumbers: string[];
  form: ServiceProtocolFormState;
  measurements: MeasurementRow[];
  testLoad: TestLoadValues;
  workSteps: WorkStep[];
}

type BridgeMessage =
  | { type: 'SP_SYNC_STATE'; payload: SpBridgePayload }
  | { type: 'SP_JOBS'; jobs: { id: string; label: string }[] }
  | { type: 'SP_TOAST'; message: string };

const EMBEDDED = typeof window !== 'undefined' && window.self !== window.top;

export function useEmbeddedMode() {
  return EMBEDDED;
}

export function useElectronBridge(
  state: SpBridgePayload,
  setState: (payload: SpBridgePayload) => void,
  onAction: (action: string) => void,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const suppressPush = useRef(false);

  useEffect(() => {
    if (!EMBEDDED) return;

    function onMessage(ev: MessageEvent) {
      const data = ev.data as BridgeMessage | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'SP_SYNC_STATE' && data.payload) {
        suppressPush.current = true;
        setState(data.payload);
        queueMicrotask(() => {
          suppressPush.current = false;
        });
      }
      if (data.type === 'SP_TOAST' && data.message) {
        console.info('[Serviceprotokoll]', data.message);
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'SP_READY' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [setState]);

  const pushState = useCallback(() => {
    if (!EMBEDDED || suppressPush.current) return;
    window.parent.postMessage({ type: 'SP_STATE_CHANGE', payload: stateRef.current }, '*');
  }, []);

  useEffect(() => {
    if (!EMBEDDED) return;
    const t = window.setTimeout(pushState, 120);
    return () => window.clearTimeout(t);
  }, [state, pushState]);

  const sendAction = useCallback(
    (action: string) => {
      if (EMBEDDED) {
        window.parent.postMessage(
          { type: 'SP_ACTION', action, payload: stateRef.current },
          '*',
        );
      } else {
        onAction(action);
      }
    },
    [onAction],
  );

  return { embedded: EMBEDDED, sendAction };
}
