import React from "react";
import { useXarrow } from "react-xarrows";
import { StackFrame } from "../types/stepTypes";
import { StackFrameComponent } from "./StackFrame";

interface StackPanelProps {
  frames: StackFrame[];
  showAddresses: boolean;
}

export const StackPanel: React.FC<StackPanelProps> = ({ frames, showAddresses }) => {
  // react-xarrows only recalculates arrow positions on window-level
  // resize/scroll by default — it has no way to know this panel's own
  // overflow-y:auto scrolling just moved every anchor underneath it, so
  // without this the arrows stay put at their old screen coordinates and
  // end up pointing at whatever row scrolled into that spot instead.
  const updateXarrow = useXarrow();

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
    <div className="panel stack-panel" onScroll={updateXarrow}>
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
              showAddresses={showAddresses}
            />
          );
        })}
      </div>
    </div>
  );
};