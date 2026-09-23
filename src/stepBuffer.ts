import { StepData, StepMessage, HeapBlock } from "./types/stepTypes";

/**
 * StepBuffer stores all received StepData objects and maintains a cursor
 * for forward/backward navigation without re-running GDB.
 *
 * Cursor starts at -1 (no steps yet).
 * After the first push(), cursor is still -1 until the caller calls forward().
 * This lets the extension explicitly control when the webview advances.
 */
export class StepBuffer {
  private _steps: StepData[] = [];
  private _cursor: number = -1;

  // Every heap block seen so far, keyed by address. Map keeps a key's
  // original insertion position when it's overwritten — the same rule as
  // the tracer's own dict — so the rebuilt list matches the tracer's order.
  private _heap = new Map<string, HeapBlock>();

  /**
   * Rebuild the full step from the tracer's delta (see StepMessage), append
   * it, and return it. Does NOT advance the cursor.
   *
   * Blocks that didn't change keep being the very same object from step to
   * step, so each buffered step only really costs what changed rather than
   * a full copy of the heap. Buffered steps are never mutated, so sharing
   * objects between them is safe.
   */
  push(msg: StepMessage): StepData {
    for (const block of msg.heap_changes) {
      this._heap.set(block.address, block);
    }

    const prev = this._steps[this._steps.length - 1];
    const { heap_changes: _changes, ...rest } = msg;
    const step: StepData = {
      ...rest,
      heap_blocks: Array.from(this._heap.values()),
      program_output:
        "program_output" in msg ? msg.program_output : prev?.program_output,
    };

    this._steps.push(step);
    return step;
  }

  /**
   * Return the step at the current cursor position.
   * Returns null if the buffer is empty or cursor is before the first step.
   */
  current(): StepData | null {
    if (this._cursor < 0 || this._cursor >= this._steps.length) {
      return null;
    }
    return this._steps[this._cursor];
  }

  /**
   * Advance cursor by one and return the new current step.
   * Returns null if already at the end of the buffer.
   */
  forward(): StepData | null {
    if (this._cursor < this._steps.length - 1) {
      this._cursor++;
    }
    return this.current();
  }

  /**
   * Move cursor back by one (floor: 0) and return the new current step.
   * Returns null if the buffer is empty.
   */
  backward(): StepData | null {
    if (this._cursor > 0) {
      this._cursor--;
    }
    return this.current();
  }

  /**
   * Returns true if the cursor is sitting at the last buffered step.
   * Used by extension.ts to decide whether to send "next" to GDB.
   */
  isAtEnd(): boolean {
    return this._cursor === this._steps.length - 1;
  }

  /** Clear all steps and reset the cursor to -1. */
  reset(): void {
    this._steps = [];
    this._cursor = -1;
    this._heap.clear();
  }

  /** Number of steps currently in the buffer. */
  get length(): number {
    return this._steps.length;
  }

  /** Current cursor position (0-indexed). -1 means before any step. */
  get cursor(): number {
    return this._cursor;
  }
}
