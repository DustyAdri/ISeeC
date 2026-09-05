"""
gdb_tracer.py — c-stack-viz Phase 1, Prompts 1+2
GDB Python script: event-driven line-by-line stepping with JSON state emission,
malloc/free heap tracking, and struct field reading.

Run inside GDB:
    gdb -batch -ex "source gdb_tracer.py" -ex "run" ./binary

One JSON object is emitted to stdout per step.
One control word is read from stdin after each emit:
    next | step | continue | quit
"""

import gdb
import sys
import json
import re

# ---------------------------------------------------------------------------
# Heap registry  (Capability A)
# ---------------------------------------------------------------------------

# Maps hex address string → heap block dict.
# Entries are never removed — freed blocks remain with is_allocated: False.
_heap = {}          # type: dict[str, dict]
_malloc_size = [0]  # capture malloc argument across entry→finish


# ---------------------------------------------------------------------------
# Type helpers  (shared by variable encoding and struct reading)
# ---------------------------------------------------------------------------

def _strip_type(t):
    """Remove typedef layers and const/volatile qualifiers."""
    try:
        while t.code == gdb.TYPE_CODE_TYPEDEF:
            t = t.target()
        return t.unqualified()
    except Exception:
        return t


def _is_char(t):
    try:
        return _strip_type(t).code == gdb.TYPE_CODE_CHAR
    except Exception:
        return False


def _is_int(t):
    try:
        return _strip_type(t).code == gdb.TYPE_CODE_INT
    except Exception:
        return False


def _is_ptr(t):
    try:
        return _strip_type(t).code == gdb.TYPE_CODE_PTR
    except Exception:
        return False


def _is_ptr_to_struct(t):
    """Return True if *t* is a pointer whose target (after typedef strip) is a struct."""
    try:
        bt = _strip_type(t)
        if bt.code != gdb.TYPE_CODE_PTR:
            return False
        target = _strip_type(bt.target())
        return target.code == gdb.TYPE_CODE_STRUCT
    except Exception:
        return False


def _type_str(t):
    try:
        return str(t).strip()
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Scalar value encoder  (used for both variables and struct fields)
# ---------------------------------------------------------------------------

def _encode_scalar(val):
    """
    Encode a gdb.Value as a string following the spec rules.
    Returns (value_str, target_address_str_or_None).
    Does NOT recurse into structs.
    """
    try:
        if val.is_optimized_out:
            return "?", None
    except Exception:
        pass

    raw_type = val.type
    try:
        if _is_ptr(raw_type):
            try:
                addr_int = int(val)
                if addr_int == 0:
                    return "0x0", None
                h = hex(addr_int)
                return h, h
            except Exception:
                return "?", None

        elif _is_char(raw_type):
            try:
                c = int(val)
                return "'{}'".format(chr(c) if 32 <= c <= 126 else c), None
            except Exception:
                return "?", None

        elif _is_int(raw_type):
            try:
                return str(int(val)), None
            except Exception:
                return "?", None

        else:
            try:
                return str(val), None
            except Exception:
                return "?", None

    except Exception:
        return "?", None


# ---------------------------------------------------------------------------
# Variable encoding  (Prompt 1 — unchanged interface)
# ---------------------------------------------------------------------------

def _encode_var(name, sym, frame):
    """
    Read one local variable / argument from *frame* and return its dict.
    """
    result = {
        "name": name,
        "type": "unknown",
        "value": "?",
        "target_address": None,
        "uninitialized": False,
    }

    try:
        val = frame.read_var(sym)
    except gdb.error:
        result["uninitialized"] = True
        return result

    try:
        if val.is_optimized_out:
            result["uninitialized"] = True
            return result
    except Exception:
        pass

    result["type"] = _type_str(val.type)
    value_str, target_addr = _encode_scalar(val)
    if value_str == "?":
        result["uninitialized"] = True
    result["value"] = value_str
    result["target_address"] = target_addr
    return result


# ---------------------------------------------------------------------------
# Struct field reader  (Capability B)
# ---------------------------------------------------------------------------

def _read_struct_fields(ptr_val):
    """
    Given a gdb.Value that is a pointer-to-struct, dereference it and read
    all fields at depth 1.  Returns (type_name_str, data_dict).
    data_dict maps field_name → encoded_value_str.
    On any MemoryError returns (None, {}).
    """
    data = {}
    type_name = None
    try:
        base_ptr_type = _strip_type(ptr_val.type)
        target_type = _strip_type(base_ptr_type.target())
        if target_type.code != gdb.TYPE_CODE_STRUCT:
            return None, {}

        # Struct type name (may be None for anonymous structs)
        try:
            type_name = str(target_type.tag or target_type).strip()
        except Exception:
            type_name = "struct"

        deref = ptr_val.dereference()

        for field in target_type.fields():
            fname = field.name
            if fname is None:
                continue
            try:
                fval = deref[fname]
                value_str, _ = _encode_scalar(fval)
                data[fname] = value_str
            except gdb.MemoryError:
                data[fname] = "?"
            except Exception:
                data[fname] = "?"

        return type_name, data

    except gdb.MemoryError:
        return None, {}
    except Exception:
        return type_name, {}


# ---------------------------------------------------------------------------
# Heap enrichment — scan pointer vars and update heap block metadata
# ---------------------------------------------------------------------------

def _enrich_heap_from_frames(frames_data, all_frame_objects):
    """
    Walk all frame *gdb.Frame* objects, find pointer-to-struct variables
    that point into _heap, dereference them, and update the heap block's
    type/data fields.  frame_objects is the raw gdb.Frame list (innermost
    first, before reversal).

    We do this once per step so heap_blocks always reflects the latest
    struct contents at heap addresses, not just the raw allocation.
    """
    for frame in all_frame_objects:
        try:
            block = frame.block()
        except Exception:
            continue

        seen = set()
        b = block
        while b is not None:
            for sym in b:
                if not (sym.is_argument or sym.is_variable):
                    continue
                if sym.name in seen:
                    continue
                seen.add(sym.name)

                try:
                    val = frame.read_var(sym)
                except gdb.error:
                    continue

                try:
                    if val.is_optimized_out:
                        continue
                except Exception:
                    continue

                # Only care about non-null pointer-to-struct
                if not _is_ptr_to_struct(val.type):
                    continue

                try:
                    addr_int = int(val)
                except Exception:
                    continue

                if addr_int == 0:
                    continue

                h = hex(addr_int)
                if h not in _heap:
                    continue  # not a tracked heap block

                type_name, data = _read_struct_fields(val)
                if type_name is not None:
                    _heap[h]["type"] = type_name
                if data:
                    _heap[h]["data"] = data

            try:
                parent = b.superblock
                if parent is None or parent.is_static or parent.is_global:
                    break
                b = parent
            except Exception:
                break


# ---------------------------------------------------------------------------
# Stack frame collection  (Prompt 1 — returns list + raw gdb.Frame objects)
# ---------------------------------------------------------------------------

def _collect_frames():
    """
    Walk the frame chain.
    Returns (frames_list, raw_gdb_frames_list).
    frames_list is outermost-first (JSON output).
    raw_gdb_frames_list is in the same order (for heap enrichment).
    """
    frames = []
    raw_frames = []

    try:
        frame = gdb.newest_frame()
    except gdb.error:
        return [], []

    while frame is not None:
        raw_frames.append(frame)

        try:
            func_name = frame.name() or "<unknown>"
        except gdb.error:
            func_name = "<unknown>"

        variables = []
        try:
            block = frame.block()
            seen = set()
            b = block
            while b is not None:
                for sym in b:
                    if (sym.is_argument or sym.is_variable) and sym.name not in seen:
                        seen.add(sym.name)
                        variables.append(_encode_var(sym.name, sym, frame))
                try:
                    parent = b.superblock
                    if parent is None or parent.is_static or parent.is_global:
                        break
                    b = parent
                except Exception:
                    break
        except (gdb.error, RuntimeError):
            pass

        frames.append({"name": func_name, "variables": variables})

        try:
            frame = frame.older()
        except gdb.error:
            break

    frames.reverse()
    raw_frames.reverse()
    return frames, raw_frames


# ---------------------------------------------------------------------------
# Line number helpers  (Prompt 1 — unchanged)
# ---------------------------------------------------------------------------

def _current_line():
    try:
        sal = gdb.selected_frame().find_sal()
        return sal.line if sal and sal.line else None
    except Exception:
        return None


def _next_line(cur_line):
    if cur_line is None:
        return None
    try:
        pc = gdb.selected_frame().pc()
        for offset in (1, 2, 4, 6, 8, 12, 16):
            try:
                peeked = gdb.find_pc_line(pc + offset)
                if peeked and peeked.line and peeked.line != cur_line:
                    return peeked.line
            except Exception:
                continue
        return None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# I/O  (Prompt 1 — _emit updated to include heap_blocks)
# ---------------------------------------------------------------------------

_step_count = [0]


def _emit(current_line, next_ln, stack_frames):
    _step_count[0] += 1
    obj = {
        "step": _step_count[0],
        "current_line": current_line,
        "next_line": next_ln,
        "stack_frames": stack_frames,
        # Emit all heap blocks (allocated and freed) as a stable list
        "heap_blocks": list(_heap.values()),
    }
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _read_cmd():
    try:
        line = sys.stdin.readline()
        return line.strip() if line else "quit"
    except Exception:
        return "quit"


# ---------------------------------------------------------------------------
# Malloc / free breakpoints  (Capability A)
# ---------------------------------------------------------------------------

class _MallocBreakpoint(gdb.Breakpoint):
    """Fires on malloc entry; captures size and installs a FinishBreakpoint."""

    def __init__(self):
        super().__init__("malloc", internal=True)
        self.silent = True

    def stop(self):
        try:
            size = int(gdb.parse_and_eval("(size_t)$rdi"))
            _malloc_size[0] = size
            _MallocFinish(gdb.selected_frame(), size)
        except Exception:
            _malloc_size[0] = 0
        return False  # don't pause the inferior


class _MallocFinish(gdb.FinishBreakpoint):
    """Fires when malloc returns; records the allocated block in _heap."""

    def __init__(self, frame, size):
        super().__init__(frame, internal=True)
        self.silent = True
        self._size = size

    def stop(self):
        try:
            rv = self.return_value
            addr_int = int(rv) if rv is not None else int(gdb.parse_and_eval("(void*)$rax"))
            if addr_int != 0:
                h = hex(addr_int)
                _heap[h] = {
                    "address": h,
                    "type": "void",
                    "data": {},
                    "is_allocated": True,
                }
        except Exception:
            pass
        return False

    def out_of_scope(self):
        # malloc returned but FinishBreakpoint missed it — non-fatal
        pass


class _FreeBreakpoint(gdb.Breakpoint):
    """Fires on free entry; marks the corresponding block as freed."""

    def __init__(self):
        super().__init__("free", internal=True)
        self.silent = True

    def stop(self):
        try:
            addr_int = int(gdb.parse_and_eval("(void*)$rdi"))
            h = hex(addr_int)
            if h in _heap:
                _heap[h]["is_allocated"] = False
        except Exception:
            pass
        return False


# ---------------------------------------------------------------------------
# GDB event handlers  (Prompt 1 core, extended for heap enrichment)
# ---------------------------------------------------------------------------

_heap_bps_installed = [False]


def _on_stop(event):
    """
    Fired after each step/next/breakpoint stop.

    Note: gdb.execute("next") fires stop synchronously (recursive call),
    so no re-entrancy guard is used — recursion IS the loop.
    """
    # Install malloc/free breakpoints on first stop (after PLT is resolved)
    if not _heap_bps_installed[0]:
        _heap_bps_installed[0] = True
        try:
            _MallocBreakpoint()
            _FreeBreakpoint()
        except Exception:
            pass

    cur = _current_line()
    nxt = _next_line(cur)
    frames, raw_frames = _collect_frames()

    # Enrich heap blocks with struct field data from current pointer variables
    _enrich_heap_from_frames(frames, raw_frames)

    _emit(cur, nxt, frames)

    cmd = _read_cmd()

    if cmd == "quit":
        try:
            gdb.execute("quit")
        except Exception:
            pass
        return

    gdb_cmd = {"next": "next", "step": "step", "continue": "continue"}.get(cmd, "next")
    try:
        gdb.execute(gdb_cmd)
    except gdb.error:
        pass  # inferior likely exited; exited event fires next


def _on_exit(event):
    """Emit final tombstone step when the inferior exits cleanly."""
    _emit(None, None, [])


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

gdb.execute("set pagination off", to_string=True)
gdb.execute("set confirm off", to_string=True)
gdb.execute("set print pretty off", to_string=True)

gdb.events.stop.connect(_on_stop)
gdb.events.exited.connect(_on_exit)

gdb.execute("break main", to_string=True)
