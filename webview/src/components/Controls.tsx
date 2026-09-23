import React, { useEffect } from "react";
import { vscodeApi } from "../vscodeApi";

interface ControlsProps {
  step: number;
  totalSteps: number;
  finished: boolean;
  // Number of steps traced so far during the initial eager pre-run, or
  // null once that's finished (or hasn't started). Lets the counter show
  // visible progress instead of a static "waiting" message that looks
  // identical whether the trace is running slowly or genuinely stuck.
  preloadCount: number | null;
  showAddresses: boolean;
  onToggleShowAddresses: (value: boolean) => void;
  showArrows: boolean;
  onToggleShowArrows: (value: boolean) => void;
}

export const Controls: React.FC<ControlsProps> = ({
  step,
  totalSteps,
  finished,
  preloadCount,
  showAddresses,
  onToggleShowAddresses,
  showArrows,
  onToggleShowArrows,
}) => {
  const canGoBack = step > 1;
  const canGoForward = !finished && totalSteps > 0;

  // Left/Right arrow keys step through the trace while the visualizer
  // panel has focus — same effect (and same disabled rules) as the buttons.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "ArrowLeft" && canGoBack) {
        e.preventDefault();
        vscodeApi.postMessage({ type: "requestStep", direction: "backward" });
      } else if (e.key === "ArrowRight" && canGoForward) {
        e.preventDefault();
        vscodeApi.postMessage({ type: "requestStep", direction: "forward" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoBack, canGoForward]);

  return (
    <div className="controls">
      <button
        className="ctrl-btn"
        onClick={() => vscodeApi.postMessage({ type: "requestStep", direction: "backward" })}
        disabled={!canGoBack}
        title="Step back (←)"
      >
        ◀ Back
      </button>

      <span className="ctrl-counter">
        {totalSteps === 0 ? (
          <span className="ctrl-counter__idle">
            {preloadCount ? `Tracing… ${preloadCount} steps so far` : "Waiting for trace…"}
          </span>
        ) : (
          <>Step <strong>{step}</strong> / <strong>{totalSteps}</strong>{finished && <span className="ctrl-counter__done"> · Done</span>}</>
        )}
      </span>

      <button
        className="ctrl-btn"
        onClick={() => vscodeApi.postMessage({ type: "requestStep", direction: "forward" })}
        disabled={finished}
        title="Step forward (→)"
      >
        Forward ▶
      </button>

      <label className="ctrl-toggle" title="Show the raw hex address next to pointer values">
        <input
          type="checkbox"
          checked={showAddresses}
          onChange={(e) => onToggleShowAddresses(e.target.checked)}
        />
        Addresses
      </label>

      <label className="ctrl-toggle" title="Draw arrows from pointers to what they point to">
        <input
          type="checkbox"
          checked={showArrows}
          onChange={(e) => onToggleShowArrows(e.target.checked)}
        />
        Arrows
      </label>

      <button
        className="ctrl-btn ctrl-btn--reset"
        onClick={() => vscodeApi.postMessage({ type: "requestReset" })}
      >
        Reset
      </button>
    </div>
  );
};