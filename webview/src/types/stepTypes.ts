export interface VariableData {
  name: string;
  type: string;
  // Readable form of `type` with pointer typedefs expanded, e.g.
  // "pointer to struct Node". Optional for older tracers.
  type_label?: string;
  value: string;
  target_address: string | null;
  uninitialized: boolean;
}

export interface StackFrame {
  name: string;
  variables: VariableData[];
}

export interface HeapBlock {
  address: string;
  type: string;
  data: Record<string, string | number>;
  // field name -> readable type label (same format as type_label).
  field_types?: Record<string, string>;
  is_allocated: boolean;
}

export interface StepData {
  step: number;
  current_line: number | null;
  next_line: number | null;
  stack_frames: StackFrame[];
  heap_blocks: HeapBlock[];
  // Cumulative stdout/stderr the traced program has produced up to and
  // including this step. Optional for backward compatibility with any
  // stale compiled tracer that predates this field.
  program_output?: string;
  // Set (e.g. "SIGSEGV", "SIGFPE") when this step is the program crashing,
  // rather than a normal line of execution or a clean finish. current_line
  // still points at the crashing line so its exact state remains visible.
  crash_signal?: string | null;
}

/**
 * What the tracer actually sends per step: a delta against the previous
 * step. StepBuffer rebuilds the full StepData from these.
 * - heap_changes: only blocks that are new or changed since the last step.
 * - program_output: present only when it changed since the last step.
 */
export type StepMessage = Omit<StepData, "heap_blocks"> & {
  heap_changes: HeapBlock[];
};
