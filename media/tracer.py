"""
tracer.py  –  GDB Python tracer for C Execution Visualizer
Windows MSYS2 GDB compatible — steps from the top level, not inside callbacks.
Run as: gdb -batch --command tracer.py ./program
"""

import gdb
import json
import os
import traceback

try:
    MAX_STEPS = int(os.environ.get("CVIS_MAX_STEPS", "5000"))
except ValueError:
    MAX_STEPS = 5_000
MAX_STR_LEN    = 256
MAX_ARRAY_LEN  = 64
MAX_HEAP_BYTES = 512
MAX_DEPTH      = 4          # deeper now so linked list nodes resolve
MAX_PTR_FOLLOW = 8          # max linked-list hops before we stop
OUTPUT_FILE    = os.environ.get("CVIS_TRACE_OUT", "cvis_trace.json")

heap_registry = {}   # addr_str → {"size": int, "type": str|None}
timeline      = []
step_count    = 0

# Track addresses currently being serialised to break cycles
_in_progress  = set()


# ── Safe wrapper ──────────────────────────────────────────────────────────────

def safe(fn, default="<e>"):
    try:
        return fn()
    except Exception as e:
        return default


# ── Uninitialized detection ───────────────────────────────────────────────────

# GDB doesn't expose an "is this memory initialized?" API, but variables that
# have never been assigned tend to read as recognizable garbage patterns on
# Windows (0xCCCCCCCC stack canary, 0xCDCDCDCD heap, 0xDDDDDDDD freed).
# We tag these so the UI can render them distinctly instead of showing a raw number.

_UNINIT_PATTERNS = {
    0xCCCCCCCC,           # MSVC debug stack fill
    0xCDCDCDCD,           # MSVC debug heap fill
    0xDDDDDDDD,           # MSVC freed heap fill
    0xFEEEFEEE,           # MSVC freed heap (older)
    0xABABABAB,           # Windows heap guard bytes
    0xBAADF00D,           # LocalAlloc uninit
}

def _looks_uninit(int_val):
    """Return True if the value matches a known garbage/uninit fill pattern."""
    u32 = int_val & 0xFFFFFFFF
    u64 = int_val & 0xFFFFFFFFFFFFFFFF
    return u32 in _UNINIT_PATTERNS or u64 in {
        0xCCCCCCCCCCCCCCCC,
        0xCDCDCDCDCDCDCDCD,
        0xDDDDDDDDDDDDDDDD,
    }


# ── Value serialiser ──────────────────────────────────────────────────────────

def serialise(val, depth=0, ptr_hops=0):
    """
    Recursively serialise a gdb.Value into a JSON-compatible dict.
    Extra fields:
      - uninit: true  → value matches a known garbage pattern
      - kind: "array" | "struct" | "pointer" | "primitive" | "string"
      - elements: [...]  for arrays
      - fields: {...}    for structs
      - points_to: ...   for pointers (followed up to MAX_PTR_FOLLOW hops)
      - linked_list: [node, node, ...]  when we detect a self-referential struct
    """
    if depth > MAX_DEPTH:
        return {"kind": "truncated", "value": "<max depth>"}
    try:
        t  = val.type.strip_typedefs()
        tc = t.code

        # ── Primitives ────────────────────────────────────────────────────
        if tc in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                  gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_ENUM):
            iv = int(val)
            return {
                "kind":  "primitive",
                "type":  str(t),
                "value": iv,
                "uninit": _looks_uninit(iv),
            }

        if tc == gdb.TYPE_CODE_FLT:
            fv = float(val)
            return {"kind": "primitive", "type": str(t), "value": fv, "uninit": False}

        # ── Pointers ──────────────────────────────────────────────────────
        if tc == gdb.TYPE_CODE_PTR:
            addr = int(val)
            if addr == 0:
                return {"kind": "pointer", "type": str(t), "value": "NULL", "address": "0x0"}
            addr_s = hex(addr)

            # char* → string
            target_type = t.target().strip_typedefs()
            if target_type.code == gdb.TYPE_CODE_CHAR:
                try:
                    s = val.string(length=MAX_STR_LEN)
                    return {"kind": "string", "type": str(t), "value": repr(s), "address": addr_s}
                except Exception:
                    pass

            # Detect linked-list pattern: pointer to a struct that contains
            # a field of the same pointer type (self-referential struct).
            if (target_type.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION)
                    and ptr_hops < MAX_PTR_FOLLOW
                    and addr_s not in _in_progress):
                # Check if any field is a pointer back to the same struct type
                is_linked = any(
                    f.type.strip_typedefs().code == gdb.TYPE_CODE_PTR and
                    f.type.strip_typedefs().target().strip_typedefs().code
                        in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION)
                    for f in target_type.fields() if f.name
                )
                if is_linked:
                    nodes = []
                    cursor_addr = addr
                    visited = set()
                    while cursor_addr != 0 and ptr_hops + len(nodes) < MAX_PTR_FOLLOW:
                        a_s = hex(cursor_addr)
                        if a_s in visited:
                            nodes.append({"kind": "cycle", "address": a_s})
                            break
                        visited.add(a_s)
                        _in_progress.add(a_s)
                        try:
                            node_val = gdb.Value(cursor_addr).cast(target_type.pointer()).dereference()
                            node_fields = {}
                            next_addr = 0
                            for f in target_type.fields():
                                if not f.name:
                                    continue
                                try:
                                    fv = node_val[f.name]
                                    ft = fv.type.strip_typedefs()
                                    if (ft.code == gdb.TYPE_CODE_PTR and
                                            ft.target().strip_typedefs().code
                                            in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION)):
                                        next_addr = int(fv)
                                        node_fields[f.name] = {"kind": "pointer", "address": hex(next_addr) if next_addr else "0x0", "value": "NULL" if next_addr == 0 else "->"}
                                    else:
                                        node_fields[f.name] = serialise(fv, depth + 1, ptr_hops + len(nodes))
                                except Exception as e:
                                    node_fields[f.name] = {"kind": "error", "value": str(e)}
                            nodes.append({"kind": "node", "address": a_s, "fields": node_fields})
                            cursor_addr = next_addr
                        except Exception as e:
                            nodes.append({"kind": "error", "address": a_s, "value": str(e)})
                            break
                        finally:
                            _in_progress.discard(a_s)
                    return {"kind": "linked_list", "type": str(t), "address": addr_s, "nodes": nodes}

            # Plain pointer — follow one level
            if addr_s not in _in_progress:
                _in_progress.add(addr_s)
                try:
                    deref = serialise(val.dereference(), depth + 1, ptr_hops + 1)
                    return {"kind": "pointer", "type": str(t), "address": addr_s, "points_to": deref}
                except Exception:
                    return {"kind": "pointer", "type": str(t), "address": addr_s, "points_to": "<unreadable>"}
                finally:
                    _in_progress.discard(addr_s)
            return {"kind": "pointer", "type": str(t), "address": addr_s, "points_to": "<cycle>"}

        # ── Arrays ────────────────────────────────────────────────────────
        if tc == gdb.TYPE_CODE_ARRAY:
            lo, hi = t.range()
            hi = min(hi, lo + MAX_ARRAY_LEN - 1)
            elements = []
            for i in range(lo, hi + 1):
                try:
                    elements.append(serialise(val[i], depth + 1))
                except Exception as e:
                    elements.append({"kind": "error", "value": str(e)})
            return {"kind": "array", "type": str(t), "length": hi - lo + 1, "elements": elements}

        # ── Structs / unions ──────────────────────────────────────────────
        if tc in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            fields = {}
            for f in t.fields():
                if not f.name:
                    continue
                try:
                    fields[f.name] = serialise(val[f.name], depth + 1)
                except Exception as e:
                    fields[f.name] = {"kind": "error", "value": str(e)}
            return {"kind": "struct", "type": str(t), "fields": fields}

        # ── Fallback ──────────────────────────────────────────────────────
        return {"kind": "primitive", "type": str(t), "value": safe(lambda: str(val)), "uninit": False}

    except Exception as e:
        return {"kind": "error", "value": str(e)}


# ── Stack / locals capture ────────────────────────────────────────────────────

def capture_locals(frame):
    result = []
    try:
        block = frame.block()
    except RuntimeError:
        return result
    while block:
        for sym in block:
            if not sym.is_variable and not sym.is_argument:
                continue
            try:
                v    = sym.value(frame)
                addr = safe(lambda v=v: hex(int(v.address))) if v.address else None
                result.append({
                    "name":    sym.name,
                    "type":    str(sym.type),
                    "address": addr,
                    "value":   serialise(v),
                })
            except Exception as e:
                result.append({"name": sym.name, "type": str(sym.type),
                                "address": None, "value": {"kind": "error", "value": str(e)}})
        if block.is_static or block.is_global:
            break
        block = block.superblock
    return result


def capture_stack():
    frames = []
    frame  = gdb.newest_frame()
    depth  = 0
    while frame and depth < 32:
        sal = frame.find_sal()
        frames.append({
            "depth":    depth,
            "function": safe(frame.name, "<unknown>"),
            "file":     safe(lambda s=sal: os.path.basename(s.symtab.filename) if s and s.symtab else "<unknown>"),
            "line":     safe(lambda s=sal: s.line if s else 0),
            "locals":   capture_locals(frame),
        })
        frame = frame.older()
        depth += 1
    return frames


# ── Heap snapshot ─────────────────────────────────────────────────────────────

def heap_snapshot():
    snap = []
    for addr_s, info in list(heap_registry.items()):
        size = info["size"]
        type_hint = info.get("type")
        try:
            raw    = gdb.inferiors()[0].read_memory(int(addr_s, 16), min(size, MAX_HEAP_BYTES))
            bytes_ = list(bytes(raw))
        except Exception:
            bytes_ = []

        # Try to deserialise the heap block as its cast type (e.g. struct Node*)
        typed_value = None
        if type_hint:
            try:
                t   = gdb.lookup_type(type_hint)
                ptr = gdb.Value(int(addr_s, 16)).cast(t.pointer())
                typed_value = serialise(ptr.dereference(), depth=0)
            except Exception:
                pass

        entry = {
            "address":      addr_s,
            "size":         size,
            "bytes":        bytes_,
            "typed_value":  typed_value,
        }
        if size > MAX_HEAP_BYTES:
            entry["truncated"] = True
        snap.append(entry)
    return snap


# ── Record one step ───────────────────────────────────────────────────────────

def record_step(event="step"):
    global step_count
    try:
        frame = gdb.newest_frame()
        sal   = frame.find_sal()
        timeline.append({
            "step":  step_count,
            "event": event,
            "file":  safe(lambda: os.path.basename(sal.symtab.filename) if sal and sal.symtab else "<unknown>"),
            "line":  safe(lambda: sal.line if sal else 0),
            "stack": capture_stack(),
            "heap":  heap_snapshot(),
        })
    except Exception as e:
        timeline.append({"step": step_count, "event": "error", "message": str(e)})
    step_count += 1


# ── Flush to disk ─────────────────────────────────────────────────────────────

def flush():
    data = {"version": 2, "total_steps": len(timeline), "timeline": timeline}
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"[tracer] {len(timeline)} steps → {OUTPUT_FILE}")


# ── Heap breakpoints ──────────────────────────────────────────────────────────

class MallocFinish(gdb.FinishBreakpoint):
    def __init__(self, size):
        super().__init__(internal=True)
        self._size = size
    def stop(self):
        try:
            rv = self.return_value
            if rv:
                heap_registry[hex(int(rv))] = {"size": self._size, "type": None}
        except Exception:
            pass
        return False

class CallocFinish(gdb.FinishBreakpoint):
    def __init__(self, size):
        super().__init__(internal=True)
        self._size = size
    def stop(self):
        try:
            rv = self.return_value
            if rv:
                heap_registry[hex(int(rv))] = {"size": self._size, "type": None}
        except Exception:
            pass
        return False

class ReallocFinish(gdb.FinishBreakpoint):
    def __init__(self, old, size):
        super().__init__(internal=True)
        self._old  = old
        self._size = size
    def stop(self):
        try:
            heap_registry.pop(self._old, None)
            rv = self.return_value
            if rv:
                heap_registry[hex(int(rv))] = {"size": self._size, "type": None}
        except Exception:
            pass
        return False

class MallocBP(gdb.Breakpoint):
    def stop(self):
        try: MallocFinish(int(gdb.parse_and_eval("$rcx")))
        except Exception as e: print(f"[tracer] heap bp malloc failed: {e}")
        return False

class CallocBP(gdb.Breakpoint):
    def stop(self):
        try: CallocFinish(int(gdb.parse_and_eval("$rcx")) * int(gdb.parse_and_eval("$rdx")))
        except Exception as e: print(f"[tracer] heap bp calloc failed: {e}")
        return False

class ReallocBP(gdb.Breakpoint):
    def stop(self):
        try: ReallocFinish(hex(int(gdb.parse_and_eval("$rcx"))), int(gdb.parse_and_eval("$rdx")))
        except Exception as e: print(f"[tracer] heap bp realloc failed: {e}")
        return False

class FreeBP(gdb.Breakpoint):
    def stop(self):
        try: heap_registry.pop(hex(int(gdb.parse_and_eval("$rcx"))), None)
        except Exception as e: print(f"[tracer] heap bp free failed: {e}")
        return False


# ── Main tracer ───────────────────────────────────────────────────────────────

def run_trace():
    main_bp = gdb.Breakpoint("main", temporary=True)
    main_bp.silent = True

    for name, cls in [("malloc",  MallocBP),  ("calloc",  CallocBP),
                      ("realloc", ReallocBP), ("free",    FreeBP)]:
        try:
            bp = cls(name, internal=True)
            bp.silent = True
        except Exception:
            pass

    try:
        gdb.execute("run", to_string=True)
    except Exception as e:
        print(f"[tracer] run failed: {e}")
        return

    try:
        frame = gdb.newest_frame()
        sal   = frame.find_sal()
        if not sal or not sal.symtab:
            print("[tracer] did not stop in user code after run")
            return
    except Exception as e:
        print(f"[tracer] no frame after run: {e}")
        return

    print("[tracer] stopped at main, beginning step loop")

    outside_count = 0

    while step_count < MAX_STEPS:
        try:
            inf = gdb.inferiors()[0]
            if not inf.is_valid() or inf.pid == 0:
                break
        except Exception:
            break

        try:
            gdb.execute("step", to_string=True)
        except gdb.error as e:
            msg = str(e).lower()
            if any(k in msg for k in ("cannot find bounds", "no registers",
                                       "not being run", "exited", "killed",
                                       "ptrace", "no stack")):
                break
            try:
                gdb.execute("step", to_string=True)
            except Exception:
                break

        try:
            inf = gdb.inferiors()[0]
            if not inf.is_valid() or inf.pid == 0:
                break
        except Exception:
            break

        try:
            frame = gdb.newest_frame()
            sal   = frame.find_sal()
            in_user = sal and sal.symtab and sal.symtab.filename
        except Exception:
            break

        if not in_user:
            outside_count += 1
            if outside_count > 100:
                print("[tracer] too many steps outside user code, stopping")
                break
            try:
                gdb.execute("finish", to_string=True)
            except Exception:
                break
            continue

        outside_count = 0
        record_step("step")

    print(f"[tracer] step loop done — {step_count} steps recorded")


# ── Entry point ───────────────────────────────────────────────────────────────

try:
    run_trace()
except Exception:
    traceback.print_exc()
finally:
    flush()
