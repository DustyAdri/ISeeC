import { jsx as _jsx } from "react/jsx-runtime";
import Xarrow from "react-xarrows";
import { isNullAddress } from "../utils/pointerUtils";
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
export const PointerArrowLayer = ({ stackFrames, heapBlocks, }) => {
    // Build a lookup of address → freed status for O(1) checks.
    const heapMap = new Map();
    for (const block of heapBlocks) {
        heapMap.set(block.address, block.is_allocated);
    }
    const arrows = [];
    stackFrames.forEach((frame, frameIndex) => {
        frame.variables.forEach((variable) => {
            var _a;
            // Skip if no target or if it is the null pointer.
            if (!variable.target_address ||
                isNullAddress(variable.value)) {
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
            const isAllocated = (_a = heapMap.get(variable.target_address)) !== null && _a !== void 0 ? _a : false;
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
    return (_jsx("div", { style: {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
        }, children: arrows.map(({ startId, endId, freed }) => (_jsx(Xarrow, { start: startId, end: endId, color: freed ? "#EF5350" : "#4FC3F7", strokeWidth: 2, headSize: 6, dashness: freed ? { strokeLen: 6, nonStrokeLen: 4 } : false, path: "smooth", startAnchor: "right", endAnchor: "left", animateDrawing: false, 
            // Transparent arrow SVG must sit above the panels but not
            // capture pointer events (handled by the wrapper div above).
            zIndex: 10, _cpx1Offset: 30, _cpy1Offset: 0, _cpx2Offset: -30, _cpy2Offset: 0 }, `${startId}->${endId}`))) }));
};
