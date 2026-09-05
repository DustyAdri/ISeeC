import React from "react";
import { StackFrame } from "../types/stepTypes";
import { StackFrameComponent } from "./StackFrame";

interface StackPanelProps {
  frames: StackFrame[];
}

export const StackPanel: React.FC<StackPanelProps> = ({ frames }) => {
  if (frames.length === 0) {
    return (
      <div className="panel stack-panel">
        <h2 className="panel__title">Call Stack</h2>
        <p className="panel__empty">No active frames</p>
      </div>
    );
  }

  const reversed = [...frames].reverse();

  return (
    <div className="panel stack-panel">
      <h2 className="panel__title">Call Stack</h2>
      <div className="stack-panel__frames">
        {reversed.map((frame, reversedIndex) => {
          const originalIndex = frames.length - 1 - reversedIndex;
          const isActive = reversedIndex === 0;
          return (
            <StackFrameComponent
              key={`${frame.name}-${originalIndex}`}
              frame={frame}
              frameIndex={originalIndex}
              isActive={isActive}
            />
          );
        })}
      </div>
    </div>
  );
};