# C Execution Stack Visualizer — Software Requirements Specification

**Project:** `c-stack-viz` — A VS Code Extension for Dynamic C Memory Visualization
**Version:** 1.0.0
**Status:** Pre-Development
**Inspired by:** Python Tutor (pythontutor.com)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Module Responsibilities](#3-module-responsibilities)
4. [JSON Contract Specification](#4-json-contract-specification)
5. [Visual Mapping Rules](#5-visual-mapping-rules)
6. [Core Features](#6-core-features)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [File Structure](#8-file-structure)
9. [Error States & Edge Cases](#9-error-states--edge-cases)
10. [Glossary](#10-glossary)

---

## 1. Project Overview

`c-stack-viz` is a VS Code extension that compiles and traces C programs line-by-line using GDB, capturing the state of the call stack, local variables, heap allocations, and pointer relationships at each execution step. This state is streamed to a React-powered webview panel that renders a live, interactive diagram — analogous to Python Tutor but for C, with explicit heap/stack separation, pointer arrows, and memory lifecycle visualization.

### Primary Goals

- Help developers trace pointer manipulation and dynamic memory bugs visually.
- Visualize linked list traversals with animated pointer re-routing.
- Make uninitialized memory, null pointers, and freed blocks immediately visible.
- Operate without requiring the user to write any GDB commands.

### Target Users

C learners, systems programming students, and developers debugging data structure implementations.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      VS Code Window                         │
│                                                             │
│  ┌──────────────────┐        ┌──────────────────────────┐   │
│  │   Editor Panel   │        │     Webview Panel        │   │
│  │  (C source file) │        │  (React + react-xarrows) │   │
│  └──────────────────┘        └──────────────┬───────────┘   │
│                                             │ postMessage   │
│  ┌──────────────────────────────────────────┴───────────┐   │
│  │              Extension Host (TypeScript)              │  │
│  │   - Compiles C via gcc subprocess                     │  │
│  │   - Spawns GDB with Python script via subprocess      │  │
│  │   - Parses stdout line-by-line                        │  │
│  │   - Validates JSON, forwards to webview               │  │
│  │   - Manages step cursor in active editor              │  │
│  └──────────────────────────────┬───────────────────────┘   │
│                                 │ stdin/stdout pipe         │
│  ┌──────────────────────────────┴───────────────────────┐   │
│  │          GDB Python Script (Python 3 + GDB API)       │  │
│  │   - Hooks malloc, free, realloc breakpoints           │  │
│  │   - Steps line-by-line through frames                 │  │
│  │   - Reads variable values, types, addresses           │  │
│  │   - Emits one JSON object per step to stdout          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Communication is strictly unidirectional at runtime:**
`GDB Python Script → stdout → Extension Host → postMessage → React Webview`

The Extension Host sends only control signals back to GDB (step, continue, quit) via stdin.

---

## 3. Module Responsibilities

### 3.1 Backend — `gdb_tracer.py`

**Runtime:** Python 3 embedded in GDB (`gdb.execute`, `gdb.parse_and_eval`)

| Responsibility | Detail |
|---|---|
| Line-by-line stepping | Uses `gdb.events.stop` to hook each `stepi`/`next` stop |
| Stack frame extraction | Iterates `gdb.selected_thread().is_stopped()` → `gdb.Frame` chain |
| Variable inspection | Reads `frame.read_var(name)` for each local; checks `gdb.Value` type |
| Uninitialized detection | Catches `gdb.MemoryError` or checks `optimized_out` flag |
| `malloc` hooking | Breakpoint on `malloc` entry + finish to capture returned address and size |
| `free` hooking | Breakpoint on `free` entry; marks block `is_allocated: false` |
| Struct field traversal | Follows `gdb.Type` fields recursively up to depth 3 |
| Output | Prints exactly one JSON line to `sys.stdout` per step; flushes immediately |
| Control input | Reads `"next"`, `"step"`, `"continue"`, `"quit"` from `sys.stdin` |

**Must NOT:** import VS Code APIs, open files, or perform any UI logic.

### 3.2 Middleware — Extension Host (`extension.ts`)

**Runtime:** Node.js inside VS Code Extension Host process

| Responsibility | Detail |
|---|---|
| Command registration | Registers `c-stack-viz.start`, `c-stack-viz.stop`, `c-stack-viz.stepForward`, `c-stack-viz.stepBack` |
| Compilation | Spawns `gcc -g -o <binary> <source>` and reports errors to VS Code Problems panel |
| GDB process management | Spawns `gdb -batch -x gdb_tracer.py -- <binary>`, manages lifecycle |
| stdout parsing | Reads GDB stdout line-by-line; validates each line as JSON against schema |
| Step buffering | Stores all received JSON steps in an ordered array for forward/backward navigation |
| Webview management | Creates and owns the `WebviewPanel`; handles `retainContextWhenHidden` |
| Message passing | Sends `{ type: "step", payload: <StepJSON> }` to webview via `panel.webview.postMessage` |
| Editor decoration | Highlights `current_line` in the active editor using `TextEditorDecorationType` |
| Error forwarding | Sends `{ type: "error", message: string }` to webview on GDB crash or schema violation |

**Must NOT:** execute GDB commands directly, parse C source, or contain rendering logic.

### 3.3 Frontend — React Webview (`App.tsx`)

**Runtime:** Browser (Chromium) inside VS Code Webview

| Responsibility | Detail |
|---|---|
| Message receiving | Listens for `window.addEventListener("message", ...)` from Extension Host |
| Step state management | Holds current `StepJSON` in React state; re-renders on update |
| Stack panel | Renders call stack frames top-to-bottom, newest frame on top |
| Heap panel | Renders heap blocks as labeled address cards |
| Pointer arrows | Uses `react-xarrows` to draw arrows from pointer variables to heap block cards |
| Visual encoding | Applies all visual mapping rules (see Section 5) |
| Null pointer display | Renders null pointers pointing to a fixed "NULL" sentinel node |
| Controls | Renders Step Forward / Step Back / Reset buttons; sends messages back to Extension Host |
| No-op on unknown messages | Ignores any message not matching known `type` values |

**Must NOT:** spawn processes, read files, or use Node.js APIs.

---

## 4. JSON Contract Specification

This schema is the **single source of truth** for all inter-module communication. Any deviation is a contract violation and must be treated as a parse error by the receiver.

### 4.1 Top-Level Step Object

```jsonc
{
  // Sequential integer starting at 1. Monotonically increasing.
  "step": 5,

  // 1-indexed line number of the line that just executed (source of truth for editor highlight).
  "current_line": 26,

  // 1-indexed line number that will execute next. Null if program is about to exit.
  "next_line": 27,

  // Ordered array of active call stack frames. Index 0 = outermost (main).
  // Last element = currently executing frame.
  "stack_frames": [ /* See 4.2 */ ],

  // Unordered array of all heap blocks ever allocated. Freed blocks remain with is_allocated: false.
  "heap_blocks": [ /* See 4.3 */ ]
}
```

### 4.2 Stack Frame Object

```jsonc
{
  // Name of the C function for this frame.
  "name": "main",

  // Ordered array of all local variables visible in this frame at this step.
  "variables": [
    {
      // C identifier name.
      "name": "head",

      // C type as a string, exactly as GDB reports it (e.g., "int", "node *", "char *").
      "type": "node *",

      // String representation of the value.
      // For pointers: hex address string e.g. "0x804020"
      // For integers: decimal string e.g. "42"
      // For chars: the character in single quotes e.g. "'A'"
      // For uninitialized: the string "?"
      // For null pointer: the string "0x0"
      "value": "0x0",

      // If this variable is a pointer and is non-null, this is the hex address string
      // of the heap block it points to. Null if not a pointer or if value is "0x0".
      "target_address": null,

      // True if GDB reports the variable as uninitialized or optimized out.
      "uninitialized": false
    }
  ]
}
```

### 4.3 Heap Block Object

```jsonc
{
  // Hex address string of the start of the allocated block. This is the stable unique ID.
  "address": "0x804020",

  // C type of the allocation as a string, e.g. "struct node", "int", "char".
  // Derived from the cast in the C source if detectable, else "void".
  "type": "struct node",

  // Key-value map of the struct fields at this step.
  // Keys are field names (strings). Values follow the same encoding rules as variable "value".
  // For non-struct allocations (e.g., malloc'd int), use {"_value": <value>}.
  "data": {
    "value": 10,
    "next": "0x0"
  },

  // True if this block is currently allocated. False after free() is called on this address.
  "is_allocated": true
}
```

### 4.4 Control Messages (Extension Host → GDB stdin)

These are plain newline-terminated strings, not JSON:

| Message | Effect |
|---|---|
| `"next\n"` | Advance one source line (GDB `next`) |
| `"step\n"` | Step into function call (GDB `step`) |
| `"continue\n"` | Run until next breakpoint or end |
| `"quit\n"` | Terminate GDB session |

### 4.5 Webview Message Envelope (Extension Host → Webview)

```jsonc
// Normal step update
{ "type": "step", "payload": { /* StepJSON 4.1 */ } }

// Compilation or runtime error
{ "type": "error", "message": "string describing the failure" }

// Program finished executing
{ "type": "finished", "final_step": 42 }

// Step buffer rebuilt (e.g. after rerun)
{ "type": "reset" }
```

### 4.6 Webview Message Envelope (Webview → Extension Host)

```jsonc
{ "type": "requestStep", "direction": "forward" | "backward" }
{ "type": "requestReset" }
```

---

## 5. Visual Mapping Rules

These rules are **mandatory** for the frontend renderer. They are not suggestions.

### 5.1 Variable Value Display

| Condition | Display Rule |
|---|---|
| `uninitialized: true` | Show `?` in the value cell with a yellow `⚠` icon |
| `value: "0x0"` (null pointer) | Show `null` label in red; draw no arrow |
| `value` is a hex address, `target_address` is non-null | Show shortened address (e.g., `0x804…`); draw pointer arrow |
| `value` is a hex address, `target_address` is null | Show address as plain text; no arrow |
| Scalar integer or char | Show value as-is |

### 5.2 Pointer Arrows (react-xarrows)

| Condition | Arrow Rule |
|---|---|
| Pointer points to an allocated block | Solid line, full opacity, color `#4FC3F7` |
| Pointer points to a freed block | Dashed line, 50% opacity, color `#EF5350` |
| Pointer is null (`"0x0"`) | No arrow drawn |
| Pointer is uninitialized | No arrow drawn; variable cell shows `?` |
| Two pointers share the same `target_address` | Both arrows drawn; offset slightly to avoid overlap |

### 5.3 Heap Block States

| Condition | Visual Rule |
|---|---|
| `is_allocated: true` | White card with solid border, full opacity |
| `is_allocated: false` | Dark grey card, 40% opacity, skull SVG overlay (`💀`) in top-right corner, border becomes dashed red |
| Block is the `target_address` of a current pointer | Pulse highlight animation (CSS `@keyframes pulse`) on the card border |

### 5.4 Stack Frame States

| Condition | Visual Rule |
|---|---|
| Frame is the currently executing frame (last in `stack_frames`) | Highlighted background `#1E3A5F`, left border `3px solid #4FC3F7` |
| Frame is a caller (not currently executing) | Muted background `#1A1A2E`, no left border highlight |
| Frame enters (newly added to stack) | Slide-in animation from the top |
| Frame exits (removed from stack) | Slide-out animation upward, then removed from DOM |

### 5.5 Layout Specification

```
┌─────────────────────────────────────────────────────────┐
│  CONTROLS: [◀ Back]  Step 5 / 42  [Forward ▶]  [Reset] │
├───────────────────────────┬─────────────────────────────┤
│       CALL STACK          │           HEAP              │
│  ┌────────────────────┐   │   ┌──────────┐             │
│  │ ▶ main (active)    │   │   │ 0x804020 │ ◀───────── ─┤─ arrow
│  │   head: 0x804…     │───┼──▶│ struct   │             │
│  │   i: 3             │   │   │ value:10 │             │
│  └────────────────────┘   │   │ next:0x0 │             │
│  ┌────────────────────┐   │   └──────────┘             │
│  │   insert (caller)  │   │                             │
│  │   new_node: 0x…    │   │                             │
│  └────────────────────┘   │                             │
└───────────────────────────┴─────────────────────────────┘
```

The layout is a fixed two-column flex container. The arrow SVG layer (`react-xarrows`) renders as a sibling positioned absolutely over both columns.

### 5.6 NULL Sentinel Node

A fixed, non-interactive node labeled **`NULL`** is always rendered at the bottom of the Heap panel. Null pointers do **not** draw arrows to this node — it is a visual landmark only. Its styling: dark background, red text, no border pulse.

---

## 6. Core Features

### 6.1 Phase 1 — Backend (Milestone: Backend Complete)

- [x] GDB Python script compiles and attaches to a C binary.
- [x] Steps line-by-line through `main` and any called functions.
- [x] Emits one valid JSON object per step to stdout.
- [x] Correctly identifies `int`, `char`, `int*`, `struct*` variable types.
- [x] Hooks `malloc` return address and size.
- [x] Hooks `free` and marks the corresponding block as freed.
- [x] Reads struct fields up to depth 3 (e.g., `node->next->value`).
- [x] Marks uninitialized variables as `"?"` without crashing.
- [x] Gracefully handles program exit (emits final step, then terminates).

### 6.2 Phase 2 — Middleware (Milestone: Extension Functional)

- [x] Extension activates on `.c` file open.
- [x] "Start Visualizer" command compiles the file with `gcc -g`.
- [x] Compilation errors surface in VS Code Problems panel.
- [x] GDB process is spawned and managed correctly.
- [x] All JSON steps are buffered in-memory for backward navigation.
- [x] Forward/backward step navigation works without re-running GDB.
- [x] `current_line` is highlighted in the active editor on each step.
- [x] GDB process is killed when the webview is closed or the command is re-run.

### 6.3 Phase 3 — Frontend (Milestone: Visualization Complete)

- [x] Webview renders stack frames and heap blocks from JSON.
- [x] All visual mapping rules (Section 5) are implemented.
- [x] `react-xarrows` draws pointer arrows between correct DOM elements.
- [x] Arrows update correctly when pointers change between steps.
- [x] Freed block skull overlay renders correctly.
- [x] Step counter and navigation controls are functional.
- [x] Webview correctly handles `reset` and `finished` messages.
- [x] Layout is stable when the VS Code panel is resized.

### 6.4 Stretch Features (Post-MVP)

- [ ] "Explain this step" button — sends current JSON to an LLM for a plain-English description.
- [ ] Array visualization — renders `int arr[5]` as a horizontal row of cells.
- [ ] Speed control — auto-step at a configurable delay.
- [ ] Bookmarks — flag specific steps for review.
- [ ] Export — save all steps as a JSON file for offline review.

---

## 7. Non-Functional Requirements

| Requirement | Constraint |
|---|---|
| GDB output latency | Each step's JSON must be emitted within 200ms of the step completing |
| Step buffer size | Must support up to 10,000 steps in memory without degrading performance |
| JSON schema validation | Extension Host must reject and log any malformed JSON without crashing |
| Webview re-render | Must complete in under 100ms for typical programs (< 20 stack variables, < 50 heap blocks) |
| GDB process cleanup | GDB process must be killed if VS Code window closes or extension deactivates |
| No global state in backend | `gdb_tracer.py` must be stateless between steps except for the heap block registry |
| Arrow stability | `react-xarrows` must not flicker on re-render; use stable DOM `id` attributes per heap block address |

---

## 8. File Structure

```
c-stack-viz/
├── package.json                  # VS Code extension manifest
├── tsconfig.json
├── .vscodeignore
│
├── src/
│   ├── extension.ts              # Extension Host entry point
│   ├── gdbManager.ts             # GDB process lifecycle & stdout parsing
│   ├── compiler.ts               # gcc subprocess wrapper
│   ├── stepBuffer.ts             # In-memory step store with forward/back cursor
│   ├── webviewProvider.ts        # Webview panel creation & message bridge
│   └── schemas/
│       └── stepSchema.ts         # Zod or JSON Schema validator for StepJSON
│
├── backend/
│   └── gdb_tracer.py             # GDB Python script (self-contained, no VS Code deps)
│
├── webview/                      # React app (built separately, output served by extension)
│   ├── package.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── StackPanel.tsx
│   │   │   ├── StackFrame.tsx
│   │   │   ├── HeapPanel.tsx
│   │   │   ├── HeapBlock.tsx
│   │   │   ├── PointerArrowLayer.tsx
│   │   │   ├── NullSentinel.tsx
│   │   │   └── Controls.tsx
│   │   ├── hooks/
│   │   │   └── useVscodeMessage.ts
│   │   ├── types/
│   │   │   └── stepTypes.ts      # TypeScript types mirroring Section 4 schema
│   │   └── utils/
│   │       └── pointerUtils.ts   # Resolves target_address → heap block DOM id
│   └── public/
│       └── index.html
│
└── test/
    ├── backend/
    │   ├── fixtures/             # .c test programs
    │   └── test_tracer.py        # Runs gdb_tracer against fixtures, validates JSON output
    ├── middleware/
    │   └── extension.test.ts     # VS Code Extension Test Runner tests
    └── frontend/
        └── App.test.tsx          # React Testing Library tests with mocked messages
```

---

## 9. Error States & Edge Cases

| Scenario | Backend Behavior | Middleware Behavior | Frontend Behavior |
|---|---|---|---|
| Variable is optimized out | Emit `uninitialized: true`, `value: "?"` | Forward as-is | Show `?` with warning icon |
| `malloc` fails (returns NULL) | Emit no new heap block; null pointer in variable | Forward as-is | Variable shows `null` in red |
| Recursive function (deep stack) | Emit all frames; depth capped at 20 | Forward as-is | Stack panel scrollable |
| `realloc` call | Treat as `free` of old address + `malloc` of new | Forward as-is | Old block shows skull; new block appears |
| Program crashes (SIGSEGV) | Emit final step with `next_line: null`; print `"SIGSEGV"` to stderr | Send `{ type: "error", message: "Segmentation fault at line N" }` | Display error banner over heap panel |
| GDB fails to start | — | Send `{ type: "error" }` to webview | Show "GDB not found" with install instructions |
| Malformed JSON from GDB | — | Log to Extension output channel; skip frame | No change to display |
| Circular linked list | Emit up to depth 3; do not follow cycles | Forward as-is | Arrows may create visual loop; no infinite render |

---

## 10. Glossary

| Term | Definition |
|---|---|
| **Step** | One source-line execution event, captured as a single JSON object |
| **Stack Frame** | One function's activation record: its name and currently visible local variables |
| **Heap Block** | One `malloc`'d memory region, identified by its start address |
| **target_address** | The heap block address that a pointer variable points to; used to route arrow rendering |
| **Uninitialized** | A variable GDB reports as having no assigned value or being optimized out |
| **Freed block** | A heap block with `is_allocated: false`; visually marked with skull overlay |
| **NULL sentinel** | A fixed UI node representing address `0x0`; pointers with `value: "0x0"` do not arrow to it |
| **Extension Host** | The Node.js process VS Code provides for extension logic; has full Node.js API access |
| **Webview** | A sandboxed browser context inside VS Code with no Node.js access |
| **JSON Contract** | The schema defined in Section 4; both sides must strictly conform to it |

---

*End of SRS — c-stack-viz v1.0.0*
