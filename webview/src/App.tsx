import { useState, useCallback, useEffect } from "react";
import { Xwrapper } from "react-xarrows";
import { StepData } from "./types/stepTypes";
import { useVscodeMessage } from "./hooks/useVscodeMessage";
import { Controls } from "./components/Controls";
import { StackPanel } from "./components/StackPanel";
import { HeapPanel } from "./components/HeapPanel";
import { PointerArrowLayer } from "./components/PointerArrowLayer";
import { ProgramOutput } from "./components/ProgramOutput";
import { vscodeApi } from "./vscodeApi";

interface SavedState {
  showAddresses?: boolean;
  showArrows?: boolean;
}

// The page is unloaded whenever the panel is hidden, so view toggles live
// in VS Code's webview state (which survives that) instead of only in React.
const saved = (vscodeApi.getState() ?? {}) as SavedState;

const CRASH_SIGNAL_LABELS: Record<string, string> = {
  SIGSEGV: "Segmentation fault (invalid memory access)",
  SIGFPE: "Arithmetic exception (e.g. division by zero)",
  SIGABRT: "Program aborted",
  SIGILL: "Illegal instruction",
  SIGBUS: "Bus error (misaligned or invalid memory access)",
  SIGSTKFLT: "Stack overflow",
};

function describeCrash(signal: string, line: number | null): string {
  const label = CRASH_SIGNAL_LABELS[signal] ?? signal;
  return line !== null
    ? `Program crashed: ${label} at line ${line}`
    : `Program crashed: ${label}`;
}

export default function App() {
  const [currentStep, setCurrentStep] = useState<StepData | null>(null);
  const [totalSteps, setTotalSteps] = useState(0);
  const [finished, setFinished] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showAddresses, setShowAddresses] = useState(saved.showAddresses ?? true);
  const [showArrows, setShowArrows] = useState(saved.showArrows ?? true);

  useEffect(() => {
    vscodeApi.setState({ showAddresses, showArrows } satisfies SavedState);
  }, [showAddresses, showArrows]);
  const [preloadCount, setPreloadCount] = useState<number | null>(null);

  const handleStep = useCallback((step: StepData, totalSteps: number) => {
    setCurrentStep(step);
    // The extension sends the program's real final step count directly
    // (known up front — see cmdStart's eager pre-run) rather than us
    // inferring it from whatever step happens to be current.
    setTotalSteps(totalSteps);
    // Preloading is over the moment any real step is shown.
    setPreloadCount(null);

    if (step.crash_signal) {
      // A crash is a terminal step, same as reaching the natural end —
      // there's nothing to step forward into, so Forward should disable
      // exactly like it does for a clean finish.
      setErrorMessage(describeCrash(step.crash_signal, step.current_line));
      setFinished(true);
    } else {
      setErrorMessage(null);
      // A regular "step" message means we're not at the end — this matters
      // when the user steps back from the final step and then forward again
      // through history, which shouldn't leave Forward stuck disabled.
      setFinished(false);
    }
  }, []);

  const handleError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const handleFinished = useCallback((finalStep: StepData | null, totalSteps: number) => {
    if (finalStep) {
      setCurrentStep(finalStep);
      setTotalSteps(totalSteps);
    }
    setPreloadCount(null);
    setFinished(true);
  }, []);

  const handlePreloadProgress = useCallback((stepsTraced: number) => {
    setPreloadCount(stepsTraced);
  }, []);

  const handleReset = useCallback(() => {
    setCurrentStep(null);
    setTotalSteps(0);
    setFinished(false);
    setErrorMessage(null);
    setPreloadCount(null);
  }, []);

  useVscodeMessage({
    onStep: handleStep,
    onError: handleError,
    onFinished: handleFinished,
    onReset: handleReset,
    onPreloadProgress: handlePreloadProgress,
  });

  const step = currentStep?.step ?? 0;
  const stackFrames = currentStep?.stack_frames ?? [];
  const heapBlocks = currentStep?.heap_blocks ?? [];
  const programOutput = currentStep?.program_output ?? "";

  return (
    <div className="app">
      <Controls
        step={step}
        totalSteps={totalSteps}
        finished={finished}
        preloadCount={preloadCount}
        showAddresses={showAddresses}
        onToggleShowAddresses={setShowAddresses}
        showArrows={showArrows}
        onToggleShowArrows={setShowArrows}
      />

      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <div className="main-area">
        {/* Xwrapper is what lets useXarrow() in StackPanel/HeapPanel tell
            react-xarrows to recompute on scroll — without it, arrows only
            ever update on window-level events and go stale the moment
            either panel's own overflow-y:auto scrolls. */}
        <Xwrapper>
          <StackPanel frames={stackFrames} showAddresses={showAddresses} />
          <HeapPanel blocks={heapBlocks} showAddresses={showAddresses} />

          {/* Arrow layer sits absolutely over both columns */}
          {showArrows && (
            <PointerArrowLayer
              stackFrames={stackFrames}
              heapBlocks={heapBlocks}
            />
          )}
        </Xwrapper>
      </div>

      <ProgramOutput text={programOutput} />
    </div>
  );
}
