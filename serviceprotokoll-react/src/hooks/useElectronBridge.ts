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
  const hostReady = useRef(false);

  useEffect(() => {
    if (!EMBEDDED) return;

    function onMessage(ev: MessageEvent) {
      const data = ev.data as BridgeMessage | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'SP_SYNC_STATE' && data.payload) {
        hostReady.current = true;
        // Länger unterdrücken als der Push-Debounce (120ms), sonst überschreibt
        // ein alter leerer React-State die gerade aus dem Anlagenstamm gefüllten Felder.
        suppressPush.current = true;
        setState(data.payload);
        window.setTimeout(() => {
          suppressPush.current = false;
        }, 250);
      }
      if (data.type === 'SP_TOAST' && data.message) {
        console.info('[Serviceprotokoll]', data.message);
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'SP_READY' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [setState]);

  // Status sofort pushen (nicht nur debounce), sonst geht „Justiert“ beim schnellen Speichern verloren
  const pushState = useCallback(() => {
    if (!EMBEDDED || suppressPush.current || !hostReady.current) return;
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
        // Vor Aktion aktuellen State inkl. Status sofort an den Host
        if (!suppressPush.current && hostReady.current) {
          window.parent.postMessage({ type: 'SP_STATE_CHANGE', payload: stateRef.current }, '*');
        }
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
