import { useEffect } from 'react';
import { StepData } from '../types/stepTypes';

interface Handlers {
  onStep: (data: StepData) => void;
  onError: (message: string) => void;
  onFinished: (finalStep: StepData | null) => void;
  onReset: () => void;
}

export function useVscodeMessage(handlers: Handlers) {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case 'step':    handlers.onStep(msg.payload); break;
        case 'error':   handlers.onError(msg.message); break;
        case 'finished': handlers.onFinished(msg.final_step); break;
        case 'reset':   handlers.onReset(); break;
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []); // empty deps intentional — handlers are stable refs
}