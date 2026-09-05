export interface VariableData {
  name: string;
  type: string;
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
  is_allocated: boolean;
}

export interface StepData {
  step: number;
  current_line: number | null;
  next_line: number | null;
  stack_frames: StackFrame[];
  heap_blocks: HeapBlock[];
}
