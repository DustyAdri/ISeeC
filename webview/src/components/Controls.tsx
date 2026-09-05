import React from "react";
import { vscodeApi } from "../vscodeApi";

interface ControlsProps {
  step: number;
  totalSteps: number;
  finished: boolean;
}

export const Controls: React.FC<ControlsProps> = ({ step, totalSteps, finished }) => {
  return (
    <div className="controls">
      <button
        className="ctrl-btn"
        onClick={() => vscodeApi.postMessage({ type: "requestStep", direction: "backward" })}
        disabled={step <= 1}
      >
        ◀ Back
      </button>

      <span className="ctrl-counter">
        {totalSteps === 0 ? (
          <span className="ctrl-counter__idle">Waiting for trace…</span>
        ) : (
          <>Step <strong>{step}</strong> / <strong>{totalSteps}</strong>{finished && <span className="ctrl-counter__done"> · Done</span>}</>
        )}
      </span>

      <button
        className="ctrl-btn"
        onClick={() => vscodeApi.postMessage({ type: "requestStep", direction: "forward" })}
        disabled={finished}
      >
        Forward ▶
      </button>

      <button
        className="ctrl-btn ctrl-btn--reset"
        onClick={() => vscodeApi.postMessage({ type: "requestReset" })}
      >
        Reset
      </button>
    </div>
  );
};