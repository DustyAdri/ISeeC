"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidStepData = isValidStepData;
/**
 * Returns true if the parsed object satisfies the StepData contract.
 * Rejects if any required top-level field is absent or wrong type.
 */
function isValidStepData(obj) {
    if (typeof obj !== "object" || obj === null) {
        return false;
    }
    const o = obj;
    if (typeof o["step"] !== "number") {
        return false;
    }
    // current_line and next_line can be null (program exit tombstone)
    if (typeof o["current_line"] !== "number" && o["current_line"] !== null) {
        return false;
    }
    if (typeof o["next_line"] !== "number" && o["next_line"] !== null) {
        return false;
    }
    if (!Array.isArray(o["stack_frames"])) {
        return false;
    }
    if (!Array.isArray(o["heap_blocks"])) {
        return false;
    }
    return true;
}
