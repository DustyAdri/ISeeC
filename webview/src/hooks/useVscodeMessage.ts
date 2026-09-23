import { useEffect } from 'react';
import { StepData } from '../types/stepTypes';
import { vscodeApi } from '../vscodeApi';

interface Handlers {
  onStep: (data: StepData, totalSteps: number) => void;
  onError: (message: string) => void;
  onFinished: (finalStep: StepData | null, totalSteps: number) => void;
  onReset: () => void;
  onPreloadProgress: (stepsTraced: number) => void;
}

export function useVscodeMessage(handlers: Handlers) {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        // Note: the extension posts the step under "payload" for both
        // "step" and "finished" messages — "final_step" was never actually
        // sent, so reading it here always yielded undefined.
        case 'step':             handlers.onStep(msg.payload, msg.totalSteps); break;
        case 'error':            handlers.onError(msg.message); break;
        case 'finished':         handlers.onFinished(msg.payload, msg.totalSteps); break;
        case 'reset':            handlers.onReset(); break;
        case 'preloadProgress':  handlers.onPreloadProgress(msg.stepsTraced); break;
      }
    };
    window.addEventListener('message', listener);
    // Tell the extension we're listening, so it can (re-)send the current
    // step — the page is rebuilt from scratch whenever the panel is shown
    // again after being hidden.
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []); // empty deps intentional — handlers are stable refs
}