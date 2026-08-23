"""
tracer.py  –  GDB Python tracer for C Execution Visualizer
Windows MSYS2 GDB compatible — steps from the top level, not inside callbacks.
Run as: gdb -batch -ex "source tracer.py" ./program
"""

import gdb
import json
import os
import traceback

# ── Tunables ─────────────────────────────────────────────────────────────────
MAX_STEPS      = 5_000
MAX_STR_LEN    = 256
MAX_ARRAY_LEN  = 32
MAX_HEAP_BYTES = 512
MAX_DEPTH      = 3
OUTPUT_FILE    = os.environ.get("CVIS_TRACE_OUT", "cvis_trace.json")
# ─────────────────────────────────────────────────────────────────────────────

heap_registry = {}   # addr_str → {"size": int}
timeline      = []
step_count    = 0


# ── Safe wrapper ──────────────────────────────────────────────────────────────

def safe(fn, default="<error>"):
    try:
        return fn()
    except Exception as e:
        return f"<error: {e}>"


# ── Value serialiser ──────────────────────────────────────────────────────────

def serialise(val, depth=0):
    if depth > MAX_DEPTH:
        return {"type": "...", "value": "<max depth>"}
    try:
        t  = val.type.strip_typedefs()
        tc = t.code

        if tc in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                  gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_ENUM):
            return {"type": str(t), "value": int(val)}

        if tc == gdb.TYPE_CODE_FLT:
            return {"type": str(t), "value": float(val)}

        if tc == gdb.TYPE_CODE_PTR:
            addr = int(val)
            if addr == 0:
                return {"type": str(t), "value": "NULL", "address": "0x0"}
            addr_s = hex(addr)
            if t.target().strip_typedefs().code == gdb.TYPE_CODE_CHAR:
                try:
                    return {"type": str(t), "value": repr(val.string(length=MAX_STR_LEN)), "address": addr_s}
                except Exception:
                    pass
            try:
                return {"type": str(t), "address": addr_s, "points_to": serialise(val.dereference(), depth+1)}
            except Exception:
                return {"type": str(t), "address": addr_s, "points_to": "<unreadable>"}

        if tc == gdb.TYPE_CODE_ARRAY:
            lo, hi = t.range()
            hi = min(hi, lo + MAX_ARRAY_LEN - 1)
            return {"type": str(t), "value": [safe(lambda i=i: serialise(val[i], depth+1)) for i in range(lo, hi+1)]}

        if tc in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            return {"type": str(t), "value": {
                f.name: safe(lambda f=f: serialise(val[f.name], depth+1))
                for f in t.fields() if f.name
            }}

        return {"type": str(t), "value": safe(lambda: str(val))}
    except Exception as e:
        return {"type": "unknown", "value": f"<error: {e}>"}


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
                result.append({"name": sym.name, "type": str(sym.type),
                                "address": addr, "value": serialise(v)})
            except Exception as e:
                result.append({"name": sym.name, "type": str(sym.type),
                                "address": None, "value": f"<error: {e}>"})
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
        try:
            raw   = gdb.inferiors()[0].read_memory(int(addr_s, 16), min(size, MAX_HEAP_BYTES))
            bytes_ = list(bytes(raw))
        except Exception:
            bytes_ = []
        snap.append({"address": addr_s, "size": size, "bytes": bytes_})
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
    data = {"version": 1, "total_steps": len(timeline), "timeline": timeline}
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
                heap_registry[hex(int(rv))] = {"size": self._size}
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
                heap_registry[hex(int(rv))] = {"size": self._size}
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
                heap_registry[hex(int(rv))] = {"size": self._size}
        except Exception:
            pass
        return False

class MallocBP(gdb.Breakpoint):
    def stop(self):
        try: MallocFinish(int(gdb.parse_and_eval("$rdi")))
        except Exception: pass
        return False

class CallocBP(gdb.Breakpoint):
    def stop(self):
        try: CallocFinish(int(gdb.parse_and_eval("$rdi")) * int(gdb.parse_and_eval("$rsi")))
        except Exception: pass
        return False

class ReallocBP(gdb.Breakpoint):
    def stop(self):
        try: ReallocFinish(hex(int(gdb.parse_and_eval("$rdi"))), int(gdb.parse_and_eval("$rsi")))
        except Exception: pass
        return False

class FreeBP(gdb.Breakpoint):
    def stop(self):
        try: heap_registry.pop(hex(int(gdb.parse_and_eval("$rdi"))), None)
        except Exception: pass
        return False


# ── Main tracer — runs entirely at the top level, not inside a callback ───────

def run_trace():
    """
    Key insight for Windows MSYS2 GDB:
    Calling gdb.execute('next') inside a Breakpoint.stop() callback causes
    the inferior to appear dead immediately. The fix is to run the entire
    step loop at the TOP LEVEL of the Python script, after gdb.execute('run')
    has hit the main breakpoint and returned control to us.
    We use a temporary breakpoint at main, run to it, then step from here.
    """

    # Set a one-shot breakpoint at main
    main_bp = gdb.Breakpoint("main", temporary=True)
    main_bp.silent = True

    # Install heap breakpoints (best-effort)
    for name, cls in [("malloc", MallocBP), ("calloc", CallocBP),
                      ("realloc", ReallocBP), ("free", FreeBP)]:
        try:
            bp = cls(name, internal=True)
            bp.silent = True
        except Exception:
            pass

    # Run the program — stops at main
    try:
        gdb.execute("run", to_string=True)
    except Exception as e:
        print(f"[tracer] run failed: {e}")
        return

    # Confirm we actually stopped inside user code
    try:
        frame = gdb.newest_frame()
        sal   = frame.find_sal()
        if not sal or not sal.symtab:
            print("[tracer] did not stop in user code after run")
            return
    except Exception as e:
        print(f"[tracer] no frame after run: {e}")
        return

    print(f"[tracer] stopped at main, beginning step loop")

    # ── Top-level step loop ───────────────────────────────────────────────────
    outside_count = 0

    while step_count < MAX_STEPS:
        # Check inferior is still alive
        try:
            inf = gdb.inferiors()[0]
            if not inf.is_valid() or inf.pid == 0:
                break
        except Exception:
            break

        # Step one source line
        try:
            gdb.execute("next", to_string=True)
        except gdb.error as e:
            msg = str(e).lower()
            if any(k in msg for k in ("cannot find bounds", "no registers",
                                       "not being run", "exited", "killed",
                                       "ptrace", "no stack")):
                break
            # transient error — try once more then give up
            try:
                gdb.execute("next", to_string=True)
            except Exception:
                break

        # Check if still alive after step
        try:
            inf = gdb.inferiors()[0]
            if not inf.is_valid() or inf.pid == 0:
                break
        except Exception:
            break

        # Check we're in user code
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
