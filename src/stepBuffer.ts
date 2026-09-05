import { StepData } from "./types/stepTypes";

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

  /** Append a new step to the buffer. Does NOT advance the cursor. */
  push(step: StepData): void {
    this._steps.push(step);
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
