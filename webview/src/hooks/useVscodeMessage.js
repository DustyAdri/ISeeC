import { useEffect } from 'react';
export function useVscodeMessage(handlers) {
    useEffect(() => {
        const listener = (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'step':
                    handlers.onStep(msg.payload);
                    break;
                case 'error':
                    handlers.onError(msg.message);
                    break;
                case 'finished':
                    handlers.onFinished(msg.final_step);
                    break;
                case 'reset':
                    handlers.onReset();
                    break;
            }
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }, []); // empty deps intentional — handlers are stable refs
}
