import { useState, useCallback } from "react";
import { StepData } from "./types/stepTypes";
import { useVscodeMessage } from "./hooks/useVscodeMessage";
import { Controls } from "./components/Controls";
import { StackPanel } from "./components/StackPanel";
import { HeapPanel } from "./components/HeapPanel";
import { PointerArrowLayer } from "./components/PointerArrowLayer";

export default function App() {
  const [currentStep, setCurrentStep] = useState<StepData | null>(null);
  const [totalSteps, setTotalSteps] = useState(0);
  const [finished, setFinished] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleStep = useCallback((step: StepData) => {
    setCurrentStep(step);
    setTotalSteps((prev) => Math.max(prev, step.step));
    setErrorMessage(null);
  }, []);

  const handleError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const handleFinished = useCallback((finalStep: StepData | null) => {
    if (finalStep) {
      setCurrentStep(finalStep);
      setTotalSteps((prev) => Math.max(prev, finalStep.step));
    }
    setFinished(true);
  }, []);

  const handleReset = useCallback(() => {
    setCurrentStep(null);
    setTotalSteps(0);
    setFinished(false);
    setErrorMessage(null);
  }, []);

  useVscodeMessage({
    onStep: handleStep,
    onError: handleError,
    onFinished: handleFinished,
    onReset: handleReset,
  });

  const step = currentStep?.step ?? 0;
  const stackFrames = currentStep?.stack_frames ?? [];
  const heapBlocks = currentStep?.heap_blocks ?? [];

  return (
    <div className="app">
      <Controls step={step} totalSteps={totalSteps} finished={finished} />

      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <div className="main-area">
        <StackPanel frames={stackFrames} />
        <HeapPanel blocks={heapBlocks} />

        {/* Arrow layer sits absolutely over both columns */}
        <PointerArrowLayer
          stackFrames={stackFrames}
          heapBlocks={heapBlocks}
        />
      </div>
    </div>
  );
}
