import React from "react";
import Xarrow from "react-xarrows";
import { StackFrame, HeapBlock } from "../types/stepTypes";
import { isNullAddress } from "../utils/pointerUtils";

interface Arrow {
  startId: string;
  endId: string;
  freed: boolean;
  color: string;
  // Stack->heap arrows cross from the left column to the right one, so a
  // right->left anchor reads naturally. Heap->heap arrows (e.g. a node's
  // "next" field pointing at another node) start and end in the same
  // column, so they instead loop out the left side to avoid tangling with
  // every stack arrow arriving from the right.
  kind: "stackToHeap" | "heapToHeap";
  // Vertical nudge applied to the arrowhead so multiple arrows sharing the
  // same target land at visibly different points along its edge instead
  // of all converging on the exact same pixel — see the grouping pass
  // below where this is computed.
  endOffsetY: number;
}

// Vertical gap, in pixels, between the landing points of arrows that
// share the same target block/field.
const SHARED_TARGET_SPACING = 12;

// Distinct, readable-on-dark-background hues, one per pointer identity.
// Freed/live status is conveyed separately via dash pattern + opacity,
// so this palette only needs to maximize contrast between arrows.
const ARROW_PALETTE = [
  "#4FC3F7", // blue
  "#FFB74D", // orange
  "#BA68C8", // purple
  "#81C784", // green
  "#F06292", // pink
  "#FFD54F", // yellow
  "#4DD0E1", // cyan
  "#E57373", // red
];

/**
 * Assigns each key a color, reusing the same color for the same key across
 * calls (stable per pointer identity across steps) while guaranteeing no
 * two keys seen in the same call get the same color, up to palette size.
 */
function assignColors(keys: string[]): Map<string, string> {
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  const unassigned: string[] = [];

  for (const key of keys) {
    const remembered = _colorMemory.get(key);
    if (remembered && !used.has(remembered)) {
      assigned.set(key, remembered);
      used.add(remembered);
    } else {
      unassigned.push(key);
    }
  }

  let paletteIndex = 0;
  for (const key of unassigned) {
    // Once every palette color is taken, repeats are unavoidable — without
    // this guard the loop below would spin forever looking for a free one.
    if (used.size >= ARROW_PALETTE.length) {
      used.clear();
    }
    while (used.has(ARROW_PALETTE[paletteIndex % ARROW_PALETTE.length])) {
      paletteIndex++;
    }
    const color = ARROW_PALETTE[paletteIndex % ARROW_PALETTE.length];
    assigned.set(key, color);
    used.add(color);
    paletteIndex++;
  }

  _colorMemory = assigned;
  return assigned;
}

// Remembers the previous step's color assignment so a pointer that's still
// alive keeps the same color as execution advances, instead of reshuffling
// every render.
let _colorMemory = new Map<string, string>();

/** react-xarrows has no opacity prop, so freed/faded arrows use an rgba stroke color instead. */
function fadeColor(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

  const pending: Omit<Arrow, "color" | "endOffsetY">[] = [];

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

      pending.push({ startId, endId, freed: !isAllocated, kind: "stackToHeap" });
    });
  });

  // Heap blocks can point at other heap blocks too (e.g. a linked list
  // node's "next" field) — those pointers live inside the block's own
  // data table, not in a stack frame, so they need their own pass.
  heapBlocks.forEach((block) => {
    Object.entries(block.data).forEach(([key, value]) => {
      if (typeof value !== "string" || isNullAddress(value)) {
        return;
      }
      if (!heapMap.has(value)) {
        return; // dangling/uninitialized garbage — nothing to point at
      }

      const startId = `heap-field-${block.address}-${key}`;
      const endId = `heap-${value}`;
      const isAllocated = heapMap.get(value) ?? false;

      pending.push({ startId, endId, freed: !isAllocated, kind: "heapToHeap" });
    });
  });

  if (pending.length === 0) {
    return null;
  }

  // Keyed on the variable's identity (not target) so a given pointer keeps
  // the same color across steps even as it's reassigned to different heap
  // blocks, while arrows visible in the same step never collide.
  const colors = assignColors(pending.map((a) => a.startId));

  // Spread out arrows that share a target: two or more pointers to the
  // same block/field would otherwise all draw their arrowhead at the
  // exact same point, making it impossible to tell them apart where they
  // arrive. Centering the spread around 0 keeps a single arrow to a given
  // target anchored exactly where it was before this existed.
  const targetTotals = new Map<string, number>();
  for (const a of pending) {
    targetTotals.set(a.endId, (targetTotals.get(a.endId) ?? 0) + 1);
  }
  const targetSeen = new Map<string, number>();

  const arrows: Arrow[] = pending.map((a) => {
    const total = targetTotals.get(a.endId) ?? 1;
    const index = targetSeen.get(a.endId) ?? 0;
    targetSeen.set(a.endId, index + 1);
    const endOffsetY = total > 1 ? (index - (total - 1) / 2) * SHARED_TARGET_SPACING : 0;

    return { ...a, color: colors.get(a.startId)!, endOffsetY };
  });

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
      {arrows.map(({ startId, endId, freed, color, kind, endOffsetY }) => (
        <Xarrow
          key={`${startId}->${endId}`}
          start={startId}
          end={endId}
          color={freed ? fadeColor(color, 0.5) : color}
          strokeWidth={2}
          headSize={6}
          dashness={freed ? { strokeLen: 6, nonStrokeLen: 4 } : false}
          path="smooth"
          // Scales the curve to the actual distance between the two
          // points instead of a fixed pixel offset, so short and long
          // arrows don't all bulge into the same overlapping shape.
          curveness={0.7}
          startAnchor={kind === "heapToHeap" ? "left" : "right"}
          endAnchor={{ position: "left", offset: { x: 0, y: endOffsetY } }}
          animateDrawing={false}
          // Transparent arrow SVG must sit above the panels but not
          // capture pointer events (handled by the wrapper div above).
          zIndex={10}
        />
      ))}
    </div>
  );
};
