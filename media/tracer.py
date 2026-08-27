"""
tracer.py  –  GDB Python tracer for C Execution Visualizer
Windows MSYS2 GDB compatible — steps from the top level, not inside callbacks.
Run as: gdb -batch --command tracer.py ./program
"""

import gdb
import json
import os
import platform
import traceback

try:
    MAX_STEPS = int(os.environ.get("CVIS_MAX_STEPS", "5000"))
except ValueError:
    MAX_STEPS = 5_000
MAX_STR_LEN    = 256
MAX_ARRAY_LEN  = 64
MAX_HEAP_BYTES = 512
MAX_DEPTH      = 4
MAX_PTR_FOLLOW = 8
OUTPUT_FILE    = os.environ.get("CVIS_TRACE_OUT", "cvis_trace.json")

# addr_str → {"size": int, "type": str|None}
# Populated by three independent mechanisms:
#   1. MallocBP finish breakpoints (works on Linux/macOS)
#   2. _scan_locals_for_heap_ptrs() at every step (works everywhere — this is
#      the primary mechanism on Windows/MinGW where malloc BPs silently fail)
#   3. _refresh_heap_ranges() OS segment map fallback
heap_registry = {}
timeline      = []
step_count    = 0

_in_progress  = set()

# ── OS heap segment ranges (fallback) ────────────────────────────────────────

_heap_ranges = []

def _refresh_heap_ranges():
    """Try to get heap segment bounds from the OS memory map.

    Works on Linux ('info proc mappings' labels the [heap] segment).
    On Windows/MinGW this usually returns nothing — that's fine because
    _scan_locals_for_heap_ptrs() handles that platform.
    """
    global _heap_ranges
    ranges = []
    try:
        out = gdb.execute("info proc mappings", to_string=True)
        for line in out.splitlines():
            if "[heap]" not in line:
                continue
            parts = line.split()
            if len(parts) >= 2:
                try:
                    ranges.append((int(parts[0], 16), int(parts[1], 16)))
                except ValueError:
                    pass
    except Exception:
        pass
    _heap_ranges = ranges


def _is_heap_addr(addr_int):
    """Return True if addr_int is a known heap address."""
    if hex(addr_int) in heap_registry:
        return True
    for start, end in _heap_ranges:
        if start <= addr_int < end:
            return True
    return False


# ── Heap discovery by scanning locals ────────────────────────────────────────
# This is the KEY mechanism on Windows/MinGW where 'malloc' breakpoints
# silently fail because MinGW routes malloc through __mingw_malloc / UCRT
# under a symbol name GDB can't resolve at the Python level.
#
# Strategy: at every step, walk all locals in all frames.  Any pointer whose
# target address is NOT in the stack region and NOT in the .text/.data
# region is almost certainly a heap pointer.  We register it immediately so
# subsequent steps can classify it correctly.

_stack_base   = None   # approximate top of stack (set once at first step)
_text_ranges  = []     # [(start, end)] for executable/read-only sections

def _init_address_ranges():
    """One-time initialisation: record the stack base and text ranges."""
    global _stack_base, _text_ranges
    # Stack base: current $rsp (or $esp on 32-bit)
    try:
        _stack_base = int(gdb.parse_and_eval("$rsp"))
    except Exception:
        try:
            _stack_base = int(gdb.parse_and_eval("$esp"))
        except Exception:
            _stack_base = None

    # Text/read-only ranges from maintenance info sections
    try:
        out = gdb.execute("maintenance info sections", to_string=True)
        for line in out.splitlines():
            if "->" not in line:
                continue
            # Keep only sections that look like code/read-only
            ro_tags = (".text", ".rodata", ".rdata", ".pdata", ".xdata",
                       "CODE", "READONLY")
            if not any(t in line for t in ro_tags):
                continue
            try:
                addr_part = line.strip().split()[0]
                s, e = addr_part.split("->")
                _text_ranges.append((int(s, 16), int(e, 16)))
            except Exception:
                pass
    except Exception:
        pass


def _looks_like_heap_ptr(addr_int):
    """Heuristic: is this pointer value likely a heap address?

    Rejects:
      - NULL
      - Stack addresses (within ~16 MB of the initial $rsp)
      - Code/read-only section addresses
    Accepts everything else as a probable heap pointer.
    """
    if addr_int == 0:
        return False
    # Already known
    if hex(addr_int) in heap_registry:
        return True
    # OS heap ranges (Linux)
    for start, end in _heap_ranges:
        if start <= addr_int < end:
            return True
    # Code/RO sections — definitely not heap
    for start, end in _text_ranges:
        if start <= addr_int < end:
            return False
    # Stack heuristic: within 16 MB above or below the initial $rsp
    if _stack_base is not None:
        diff = abs(addr_int - _stack_base)
        if diff < 16 * 1024 * 1024:
            return False
    # Sanity: pointer must be at least somewhat aligned and non-tiny
    if addr_int < 0x10000:
        return False
    if addr_int % 4 != 0:
        return False
    return True


def _scan_locals_for_heap_ptrs():
    """Walk every local in every frame; register any likely heap pointers.

    For each pointer local we:
      1. Classify the address with _looks_like_heap_ptr().
      2. If it looks like heap, add it to heap_registry with size estimated
         from the pointee type (sizeof).  If we already have it, skip.
    """
    try:
        frame = gdb.newest_frame()
        while frame:
            try:
                block = frame.block()
            except RuntimeError:
                frame = frame.older()
                continue
            while block:
                for sym in block:
                    if not sym.is_variable and not sym.is_argument:
                        continue
                    try:
                        v = sym.value(frame)
                        t = v.type.strip_typedefs()
                        if t.code != gdb.TYPE_CODE_PTR:
                            continue
                        addr_int = int(v)
                        if addr_int == 0:
                            continue
                        addr_s = hex(addr_int)
                        if addr_s in heap_registry:
                            continue
                        if not _looks_like_heap_ptr(addr_int):
                            continue
                        # Estimate size from pointee type
                        try:
                            size = int(t.target().strip_typedefs().sizeof)
                        except Exception:
                            size = 0
                        heap_registry[addr_s] = {"size": size, "type": None}
                    except Exception:
                        pass
                if block.is_static or block.is_global:
                    break
                block = block.superblock
            frame = frame.older()
    except Exception:
        pass


# ── Uninitialized detection ───────────────────────────────────────────────────

_UNINIT_PATTERNS = {
    0xCCCCCCCC, 0xCDCDCDCD, 0xDDDDDDDD, 0xFEEEFEEE,
    0xABABABAB, 0xBAADF00D,
}

def _looks_uninit(int_val):
    u32 = int_val & 0xFFFFFFFF
    u64 = int_val & 0xFFFFFFFFFFFFFFFF
    return u32 in _UNINIT_PATTERNS or u64 in {
        0xCCCCCCCCCCCCCCCC, 0xCDCDCDCDCDCDCDCD, 0xDDDDDDDDDDDDDDDD,
    }


# ── Safe wrapper ──────────────────────────────────────────────────────────────

def safe(fn, default="<e>"):
    try:
        return fn()
    except Exception:
        return default


# ── Value serialiser ──────────────────────────────────────────────────────────

def serialise(val, depth=0, ptr_hops=0, check_heap=False):
    if depth > MAX_DEPTH:
        return {"kind": "truncated", "value": "<max depth>"}
    try:
        t  = val.type.strip_typedefs()
        tc = t.code

        # ── Primitives ────────────────────────────────────────────────────
        if tc in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                  gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_ENUM):
            iv = int(val)
            return {"kind": "primitive", "type": str(t), "value": iv,
                    "uninit": _looks_uninit(iv)}

        if tc == gdb.TYPE_CODE_FLT:
            return {"kind": "primitive", "type": str(t),
                    "value": float(val), "uninit": False}

        # ── Pointers ──────────────────────────────────────────────────────
        if tc == gdb.TYPE_CODE_PTR:
            addr = int(val)
            if addr == 0:
                return {"kind": "pointer", "type": str(t),
                        "value": "NULL", "address": "0x0"}
            addr_s = hex(addr)

            # Heap pointer → emit a reference token so the UI can draw an arrow
            # to the Heap panel instead of inlining the node data here.
            if check_heap and _is_heap_addr(addr):
                return {"kind": "heap_ref", "type": str(t), "address": addr_s}

            # char* → string
            target_type = t.target().strip_typedefs()
            if target_type.code == gdb.TYPE_CODE_CHAR:
                try:
                    s = val.string(length=MAX_STR_LEN)
                    return {"kind": "string", "type": str(t),
                            "value": repr(s), "address": addr_s}
                except Exception:
                    pass

            # Linked-list pattern: pointer to a struct with a self-referential field
            if (target_type.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION)
                    and ptr_hops < MAX_PTR_FOLLOW
                    and addr_s not in _in_progress):
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
                            node_val = gdb.Value(cursor_addr).cast(
                                target_type.pointer()).dereference()
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
                                            in (gdb.TYPE_CODE_STRUCT,
                                                gdb.TYPE_CODE_UNION)):
                                        next_addr = int(fv)
                                        node_fields[f.name] = {
                                            "kind": "pointer",
                                            "address": hex(next_addr) if next_addr else "0x0",
                                            "value": "NULL" if next_addr == 0 else "->",
                                        }
                                    else:
                                        node_fields[f.name] = serialise(
                                            fv, depth + 1,
                                            ptr_hops + len(nodes),
                                            check_heap=check_heap)
                                except Exception as e:
                                    node_fields[f.name] = {"kind": "error", "value": str(e)}
                            nodes.append({"kind": "node", "address": a_s,
                                          "fields": node_fields})
                            cursor_addr = next_addr
                        except Exception as e:
                            nodes.append({"kind": "error", "address": a_s,
                                          "value": str(e)})
                            break
                        finally:
                            _in_progress.discard(a_s)
                    return {"kind": "linked_list", "type": str(t),
                            "address": addr_s, "nodes": nodes}

            # Plain pointer — follow one level
            if addr_s not in _in_progress:
                _in_progress.add(addr_s)
                try:
                    deref = serialise(val.dereference(), depth + 1,
                                      ptr_hops + 1, check_heap=check_heap)
                    return {"kind": "pointer", "type": str(t),
                            "address": addr_s, "points_to": deref}
                except Exception:
                    return {"kind": "pointer", "type": str(t),
                            "address": addr_s, "points_to": "<unreadable>"}
                finally:
                    _in_progress.discard(addr_s)
            return {"kind": "pointer", "type": str(t),
                    "address": addr_s, "points_to": "<cycle>"}

        # ── Arrays ────────────────────────────────────────────────────────
        if tc == gdb.TYPE_CODE_ARRAY:
            lo, hi = t.range()
            hi = min(hi, lo + MAX_ARRAY_LEN - 1)
            elements = []
            for i in range(lo, hi + 1):
                try:
                    elements.append(serialise(val[i], depth + 1,
                                              check_heap=check_heap))
                except Exception as e:
                    elements.append({"kind": "error", "value": str(e)})
            return {"kind": "array", "type": str(t),
                    "length": hi - lo + 1, "elements": elements}

        # ── Structs / unions ──────────────────────────────────────────────
        if tc in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            fields = {}
            for f in t.fields():
                if not f.name:
                    continue
                try:
                    fields[f.name] = serialise(val[f.name], depth + 1,
                                               check_heap=check_heap)
                except Exception as e:
                    fields[f.name] = {"kind": "error", "value": str(e)}
            return {"kind": "struct", "type": str(t), "fields": fields}

        return {"kind": "primitive", "type": str(t),
                "value": safe(lambda: str(val)), "uninit": False}

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
                    "value":   serialise(v, check_heap=True),
                })
            except Exception as e:
                result.append({"name": sym.name, "type": str(sym.type),
                                "address": None,
                                "value": {"kind": "error", "value": str(e)}})
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
            "file":     safe(lambda s=sal: os.path.basename(s.symtab.filename)
                             if s and s.symtab else "<unknown>"),
            "line":     safe(lambda s=sal: s.line if s else 0),
            "locals":   capture_locals(frame),
        })
        frame = frame.older()
        depth += 1
    return frames


# ── Heap snapshot ─────────────────────────────────────────────────────────────

def heap_snapshot():
    """Snapshot every live heap allocation with typed content where possible."""
    _refresh_heap_ranges()

    # Build addr → pointee-type map by scanning all frames/locals.
    heap_type_map = {}
    try:
        frame = gdb.newest_frame()
        while frame:
            try:
                block = frame.block()
            except RuntimeError:
                frame = frame.older()
                continue
            while block:
                for sym in block:
                    if not sym.is_variable and not sym.is_argument:
                        continue
                    try:
                        v = sym.value(frame)
                        t = v.type.strip_typedefs()
                        if t.code == gdb.TYPE_CODE_PTR:
                            pointed_addr = int(v)
                            if pointed_addr != 0:
                                a_s = hex(pointed_addr)
                                if _is_heap_addr(pointed_addr) and a_s not in heap_type_map:
                                    heap_type_map[a_s] = t.target().strip_typedefs()
                    except Exception:
                        pass
                if block.is_static or block.is_global:
                    break
                block = block.superblock
            frame = frame.older()
    except Exception:
        pass

    snap = []
    for addr_s, info in list(heap_registry.items()):
        size      = info["size"]
        type_hint = info.get("type")
        try:
            raw    = gdb.inferiors()[0].read_memory(
                int(addr_s, 16), min(size, MAX_HEAP_BYTES) if size > 0 else 16)
            bytes_ = list(bytes(raw))
        except Exception:
            bytes_ = []

        typed_value = None

        if addr_s in heap_type_map:
            try:
                target_t = heap_type_map[addr_s]
                ptr = gdb.Value(int(addr_s, 16)).cast(target_t.pointer())
                typed_value = serialise(ptr.dereference(), depth=0,
                                        check_heap=True)
            except Exception:
                pass

        if typed_value is None and type_hint:
            try:
                t   = gdb.lookup_type(type_hint)
                ptr = gdb.Value(int(addr_s, 16)).cast(t.pointer())
                typed_value = serialise(ptr.dereference(), depth=0,
                                        check_heap=True)
            except Exception:
                pass

        entry = {
            "address":     addr_s,
            "size":        size,
            "bytes":       bytes_,
            "typed_value": typed_value,
        }
        if size > MAX_HEAP_BYTES:
            entry["truncated"] = True
        snap.append(entry)
    return snap


# ── Record one step ───────────────────────────────────────────────────────────

def record_step(event="step"):
    global step_count
    # Scan locals BEFORE capturing stack so heap_registry is up to date
    # when capture_locals() calls serialise() with check_heap=True.
    _scan_locals_for_heap_ptrs()
    try:
        frame = gdb.newest_frame()
        sal   = frame.find_sal()
        timeline.append({
            "step":  step_count,
            "event": event,
            "file":  safe(lambda: os.path.basename(sal.symtab.filename)
                          if sal and sal.symtab else "<unknown>"),
            "line":  safe(lambda: sal.line if sal else 0),
            "stack": capture_stack(),
            "heap":  heap_snapshot(),
        })
    except Exception as e:
        timeline.append({"step": step_count, "event": "error",
                         "message": str(e)})
    step_count += 1


# ── Flush to disk ─────────────────────────────────────────────────────────────

def flush():
    data = {"version": 2, "total_steps": len(timeline), "timeline": timeline}
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"[tracer] {len(timeline)} steps → {OUTPUT_FILE}")


# ── Heap breakpoints (best-effort — may silently fail on Windows/MinGW) ───────

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

def _read_arg1():
    for reg in ("$rcx", "$rdi", "$r0"):
        try:
            return int(gdb.parse_and_eval(reg))
        except Exception:
            pass
    return None

def _read_arg2():
    for reg in ("$rdx", "$rsi", "$r1"):
        try:
            return int(gdb.parse_and_eval(reg))
        except Exception:
            pass
    return None

class MallocBP(gdb.Breakpoint):
    def stop(self):
        try:
            a1 = _read_arg1()
            if a1 is not None:
                MallocFinish(a1)
        except Exception:
            pass
        return False

class CallocBP(gdb.Breakpoint):
    def stop(self):
        try:
            a1, a2 = _read_arg1(), _read_arg2()
            if a1 is not None and a2 is not None:
                CallocFinish(a1 * a2)
        except Exception:
            pass
        return False

class FreeBP(gdb.Breakpoint):
    def stop(self):
        try:
            a1 = _read_arg1()
            if a1 is not None:
                heap_registry.pop(hex(a1), None)
        except Exception:
            pass
        return False


# ── Main tracer ───────────────────────────────────────────────────────────────

def run_trace():
    main_bp = gdb.Breakpoint("main", temporary=True)
    main_bp.silent = True

    # Best-effort heap breakpoints — failures are non-fatal
    for name, cls in [("malloc", MallocBP), ("calloc", CallocBP),
                       ("free",   FreeBP)]:
        try:
            bp = cls(name, internal=True)
            bp.silent = True
            print(f"[tracer] heap bp set: {name}")
        except Exception as e:
            print(f"[tracer] heap bp skipped ({name}): {e}")

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
    _init_address_ranges()   # initialise stack base + text ranges once

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
