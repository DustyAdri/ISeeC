import React from "react";
import Xarrow from "react-xarrows";
import { StackFrame, HeapBlock } from "../types/stepTypes";
import { isNullAddress } from "../utils/pointerUtils";

interface Arrow {
  startId: string;
  endId: string;
  freed: boolean;
}

interface PointerArrowLayerProps {
  stackFrames: StackFrame[];
  heapBlocks: HeapBlock[];
}

/**
 * Builds the arrow list from all variables across all frames
 * then renders one <Xarrow> per arrow.
 *
 * Rules (per SRS Section 5 and Phase 3 prompt):
 * - Only draw for variables where target_address is non-null and value !== "0x0".
 * - Arrow is dashed/red if the target heap block is freed.
 * - Arrow is solid/blue if the target block is allocated.
 * - Null pointers and uninitialized variables are skipped.
 */
export const PointerArrowLayer: React.FC<PointerArrowLayerProps> = ({
  stackFrames,
  heapBlocks,
}) => {
  // Build a lookup of address → freed status for O(1) checks.
  const heapMap = new Map<string, boolean>();
  for (const block of heapBlocks) {
    heapMap.set(block.address, block.is_allocated);
  }

  const arrows: Arrow[] = [];

  stackFrames.forEach((frame, frameIndex) => {
    frame.variables.forEach((variable) => {
      // Skip if no target or if it is the null pointer.
      if (
        !variable.target_address ||
        isNullAddress(variable.value)
      ) {
        return;
      }

      const startId = `var-${frameIndex}-${variable.name}`;
      const endId = `heap-${variable.target_address}`;

      // Only draw the arrow if the target heap block actually exists in
      // the current step's heap_blocks list. Dangling pointers to
      // addresses we haven't tracked are silently skipped.
      if (!heapMap.has(variable.target_address)) {
        return;
      }

      const isAllocated = heapMap.get(variable.target_address) ?? false;

      arrows.push({
        startId,
        endId,
        freed: !isAllocated,
      });
    });
  });

  if (arrows.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {arrows.map(({ startId, endId, freed }) => (
        <Xarrow
          key={`${startId}->${endId}`}
          start={startId}
          end={endId}
          color={freed ? "#EF5350" : "#4FC3F7"}
          strokeWidth={2}
          headSize={6}
          dashness={freed ? { strokeLen: 6, nonStrokeLen: 4 } : false}
          path="smooth"
          startAnchor="right"
          endAnchor="left"
          animateDrawing={false}
          // Transparent arrow SVG must sit above the panels but not
          // capture pointer events (handled by the wrapper div above).
          zIndex={10}
          _cpx1Offset={30}
          _cpy1Offset={0}
          _cpx2Offset={-30}
          _cpy2Offset={0}
        />
      ))}
    </div>
  );
};
