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

            # Heap pointer → always emit a reference token regardless of check_heap.
            # This ensures malloc'd nodes never get inlined into the call stack;
            # they show as a dot (heap_ref) in locals and in full in the Heap panel.
            if _is_heap_addr(addr):
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


# ── Stdout capture via printf/puts interception ───────────────────────────────
# Primary:  intercept printf/puts/putchar/fputs at the GDB breakpoint level.
#           Works on all platforms without file-redirect gymnastics and captures
#           output even when the program hasn't flushed its stdio buffers yet.
# Fallback: redirect the inferior's stdout to a temp file before "run" so that
#           output is still captured when ALL stdio breakpoints fail to install
#           (e.g. fully-stripped binaries, macOS dyld shared cache, MinGW UCRT
#           symbols that GDB cannot resolve at the Python level).

import tempfile as _tempfile

_captured_stdout      = ""    # accumulated output from breakpoint interception
_stdout_redirect_file = None  # path to temp file used as fallback redirect

def _setup_stdout_redirect():
    """Create a temp file and configure GDB to send the inferior's stdout there.

    On POSIX (Linux / macOS) we use 'set inferior-tty' which correctly
    redirects only the *inferior's* file descriptors, not GDB's own output.

    On Windows / MinGW 'set inferior-tty' is unavailable.  Instead we store
    the path and pass it as a shell redirect to the 'run' command — GDB on
    MinGW does forward that redirect to the inferior rather than to itself.
    Either way, failures are silently ignored: the breakpoint path remains
    the primary capture mechanism and the redirect is only a safety net.
    """
    global _stdout_redirect_file
    try:
        fd, path = _tempfile.mkstemp(suffix="_cvis_stdout.txt")
        os.close(fd)
        _stdout_redirect_file = path

        if platform.system() != "Windows":
            # POSIX: 'set inferior-tty' redirects fd 1 of the child process.
            # We open a second fd so GDB can write to it as a tty-like file.
            try:
                gdb.execute(f"set inferior-tty {path}", to_string=True)
                print(f"[tracer] inferior-tty redirect: {path}")
                return   # run_trace will just call 'run' normally
            except Exception as e:
                print(f"[tracer] inferior-tty failed ({e}), trying shell redirect")

        # Windows or inferior-tty fallback: pass "> path" to 'run'.
        # NOTE: on MinGW GDB this redirects the inferior's stdout correctly.
        # On native Windows GDB it may redirect GDB's own output instead —
        # we accept that risk and still fall back to the BP path.
        print(f"[tracer] stdout shell-redirect file: {path}")

    except Exception as e:
        print(f"[tracer] stdout redirect setup failed (non-fatal): {e}")
        _stdout_redirect_file = None


def _read_redirect_file():
    """Read the redirect file and return its contents, or '' on any error.

    We re-open the file on every call so we always get the latest flushed
    content — the inferior may have written more since the last step.
    """
    if not _stdout_redirect_file:
        return ""
    try:
        if not os.path.exists(_stdout_redirect_file):
            return ""
        with open(_stdout_redirect_file, "r", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


def _read_captured_stdout():
    """Return the best available stdout snapshot, merging both sources.

    The breakpoint path captures output *before* the C runtime flushes its
    FILE* buffer to the OS — ideal for mid-execution steps.  The redirect
    file catches anything the breakpoints missed (e.g. all BPs failed, or
    output came from a path we don't intercept).

    We return whichever source has more content so neither silently wins.
    If the BP string and the file disagree we prefer the longer one, which
    in practice is always the more complete snapshot.
    """
    bp_out   = _captured_stdout
    file_out = _read_redirect_file()
    # Use the longer of the two — they should converge; if they diverge it
    # means one source captured something the other missed.
    return bp_out if len(bp_out) >= len(file_out) else file_out


def _gdb_read_string(addr_val, max_len=MAX_STR_LEN):
    """Read a C string from a GDB value (pointer or integer address)."""
    try:
        if hasattr(addr_val, 'string'):
            return addr_val.string(length=max_len)
        return gdb.Value(int(addr_val)).cast(
            gdb.lookup_type("char").pointer()).string(length=max_len)
    except Exception:
        return ""


def _detect_abi():
    """Detect calling convention: 'sysv' (Linux/macOS) or 'ms' (Windows/MinGW).

    Checks multiple signals in order of reliability so that at least one
    succeeds even when individual GDB APIs vary across versions.
    """
    # 1. GDB osabi parameter — most authoritative when available
    try:
        out = gdb.execute("show osabi", to_string=True).lower()
        if any(k in out for k in ("windows", "mingw", "cygwin")):
            return "ms"
    except Exception:
        pass

    # 2. Target file format (PE = Windows, ELF = Linux/macOS)
    try:
        out = gdb.execute("info target", to_string=True).lower()
        if any(k in out for k in ("pe ", "pei ", ".exe", "coff", "mingw")):
            return "ms"
    except Exception:
        pass

    # 3. Presence of MinGW-specific runtime symbols
    for sym in ("__mingw_vfprintf", "__mingw_printf", "__ms_vsnprintf",
                "_mingw_vfprintf"):
        try:
            gdb.parse_and_eval(f"(void*){sym}")
            return "ms"
        except Exception:
            pass

    # 4. Python platform as a last-resort hint (only valid when GDB runs
    #    natively on the same OS as the target — not cross-debugging)
    if platform.system() == "Windows":
        return "ms"

    return "sysv"

_ABI = None  # cached after first call

def _get_abi():
    global _ABI
    if _ABI is None:
        _ABI = _detect_abi()
    return _ABI


def _read_printf_args(n_args=5):
    """Read printf arguments from the correct call-site frame.

    On MinGW/UCRT, printf fires inside a wrapper (ucrt_printf.c) several
    frames deep.  The frame chain looks like:

        frame 0: printf (ucrt_printf.c:15)   -- has _Format, but $rdx etc clobbered
        frame 1: __local_stdio_printf_options -- UCRT internal
        frame 2: printf (ucrt_printf.c:18)   -- UCRT internal
        frame 3: user code (main/printLinkedList)  <-- THIS is where registers are live

    We walk up until we find the first frame whose source file is NOT a UCRT/
    mingw internal (i.e. it's in user code), then read registers from there.
    At that frame the MS ABI registers $rcx/$rdx/$r8/$r9 still hold the args
    as the user passed them.

    Returns a list: [fmt_addr, arg1, arg2, ...] as Python ints.
    """
    try:
        frame = gdb.newest_frame()
        while frame:
            sal = frame.find_sal()
            filename = ""
            try:
                if sal and sal.symtab:
                    filename = sal.symtab.filename or ""
            except Exception:
                pass

            # Stop at the first frame that is NOT inside the UCRT/mingw-crt sources
            is_internal = any(p in filename for p in (
                "ucrt_printf", "mingw-w64-crt", "ucrt___local",
                "stdio.h", "D:/W/B/src",
            ))

            if not is_internal and filename:
                # This is user code — registers here are the original call-site values
                abi = _get_abi()
                reg_names = ["$rcx", "$rdx", "$r8", "$r9"] if abi == "ms" \
                            else ["$rdi", "$rsi", "$rdx", "$rcx", "$r8", "$r9"]
                args = []
                for r in reg_names[:n_args + 1]:
                    try:
                        args.append(int(frame.read_register(r.lstrip("$"))))
                    except Exception:
                        args.append(0)
                return args

            frame = frame.older()
    except Exception:
        pass

    # Fallback: read from innermost frame (works on Linux/macOS)
    abi = _get_abi()
    reg_names = ["$rcx", "$rdx", "$r8", "$r9"] if abi == "ms" \
                else ["$rdi", "$rsi", "$rdx", "$rcx", "$r8", "$r9"]
    args = []
    for r in reg_names[:n_args + 1]:
        try:
            args.append(int(gdb.parse_and_eval(r)))
        except Exception:
            args.append(0)
    return args


def _read_register_args(n_args=5, frame=None):
    """Read printf-style args from ABI registers.

    When frame is provided, reads the saved register values from that specific
    frame rather than the current innermost frame.  This is the key fix for
    MinGW/UCRT: we pass the *caller* of the printf wrapper so we get the
    register values as they were at the moment of the CALL, before the UCRT
    prologue clobbered them.
    """
    abi = _get_abi()
    if abi == "ms":
        reg_names = ["$rcx", "$rdx", "$r8", "$r9"]
    else:
        reg_names = ["$rdi", "$rsi", "$rdx", "$rcx", "$r8", "$r9"]
    args = []
    for r in reg_names[:n_args + 1]:
        try:
            if frame is not None:
                args.append(int(frame.read_register(r.lstrip("$"))))
            else:
                args.append(int(gdb.parse_and_eval(r)))
        except Exception:
            args.append(0)
    return args


def _py_sprintf(fmt, raw_args):
    """Python reimplementation of printf formatting, handling flags/width/precision."""
    import struct as _struct
    result = ""
    arg_idx = 0   # next variadic arg index (raw_args[0] is fmt, vars start at [1])
    i = 0
    while i < len(fmt):
        c = fmt[i]
        if c != "%":
            result += c
            i += 1
            continue
        i += 1
        if i >= len(fmt):
            break
        if fmt[i] == "%":
            result += "%"
            i += 1
            continue

        # Consume optional flags: -, +, space, 0, #
        flags = ""
        while i < len(fmt) and fmt[i] in "-+ 0#":
            flags += fmt[i]
            i += 1

        # Width
        width = ""
        while i < len(fmt) and fmt[i].isdigit():
            width += fmt[i]
            i += 1
        width = int(width) if width else 0

        # Precision
        precision = None
        if i < len(fmt) and fmt[i] == ".":
            i += 1
            prec_str = ""
            while i < len(fmt) and fmt[i].isdigit():
                prec_str += fmt[i]
                i += 1
            precision = int(prec_str) if prec_str else 0

        # Length modifier (h, l, ll, z — consume and ignore for our purposes)
        while i < len(fmt) and fmt[i] in "hlLqz":
            i += 1

        if i >= len(fmt):
            break
        spec = fmt[i]
        i += 1

        # Consume one variadic arg
        arg_idx += 1
        val = raw_args[arg_idx] if arg_idx < len(raw_args) else 0

        try:
            if spec in ("d", "i"):
                # Treat as signed 64-bit
                signed = val if val < 2**63 else val - 2**64
                s = str(signed)
            elif spec == "u":
                s = str(val & 0xFFFFFFFFFFFFFFFF)
            elif spec in ("f", "F"):
                fval = _struct.unpack("d", _struct.pack("Q", val & 0xFFFFFFFFFFFFFFFF))[0]
                prec = precision if precision is not None else 6
                s = f"{fval:.{prec}f}"
            elif spec in ("e", "E"):
                fval = _struct.unpack("d", _struct.pack("Q", val & 0xFFFFFFFFFFFFFFFF))[0]
                prec = precision if precision is not None else 6
                s = f"{fval:.{prec}e}"
            elif spec in ("g", "G"):
                fval = _struct.unpack("d", _struct.pack("Q", val & 0xFFFFFFFFFFFFFFFF))[0]
                prec = precision if precision is not None else 6
                s = f"{fval:.{prec}g}"
            elif spec == "s":
                s = _gdb_read_string(val)
                if precision is not None:
                    s = s[:precision]
            elif spec == "c":
                s = chr(val & 0xFF)
            elif spec in ("x",):
                s = format(val & 0xFFFFFFFF, "x")
            elif spec in ("X",):
                s = format(val & 0xFFFFFFFF, "X")
            elif spec == "o":
                s = format(val & 0xFFFFFFFF, "o")
            elif spec == "p":
                s = hex(val)
            else:
                s = f"%{spec}"

            # Apply width/alignment
            if width and len(s) < width:
                pad = "0" if "0" in flags and "-" not in flags else " "
                if "-" in flags:
                    s = s.ljust(width)
                else:
                    s = s.rjust(width, pad)

            result += s
        except Exception:
            result += f"%{spec}"

    return result


class PrintfBP(gdb.Breakpoint):
    """Intercept printf — capture the formatted output into _captured_stdout."""
    def stop(self):
        global _captured_stdout
        try:
            raw_args = _read_printf_args()
            fmt_str = _gdb_read_string(raw_args[0]) if raw_args else ""

            if not fmt_str:
                for expr in ("_Format", "(char*)$rcx", "(char*)$rdi"):
                    try:
                        v = gdb.parse_and_eval(expr)
                        s = v.string(length=MAX_STR_LEN)
                        if s:
                            fmt_str = s
                            raw_args = [int(v)] + (raw_args[1:] if raw_args else [0]*4)
                            break
                    except Exception:
                        continue

            if not fmt_str:
                return False

            formatted = _py_sprintf(fmt_str, raw_args)
            print(f"[tracer] printf captured: fmt={repr(fmt_str)} args={raw_args[1:5]} -> {repr(formatted)}")
            _captured_stdout += formatted
        except Exception as exc:
            print(f"[tracer] PrintfBP error: {exc}")
        return False


class PutsBP(gdb.Breakpoint):
    """Intercept puts(str) — appends str + newline."""
    def stop(self):
        global _captured_stdout
        try:
            raw_args = _read_printf_args()
            if not raw_args:
                return False
            s = _gdb_read_string(raw_args[0])
            # puts always appends a newline even for an empty string
            _captured_stdout += s + "\n"
        except Exception as exc:
            print(f"[tracer] PutsBP error: {exc}")
        return False


class PutcharBP(gdb.Breakpoint):
    """Intercept putchar(c)."""
    def stop(self):
        global _captured_stdout
        try:
            raw_args = _read_printf_args()
            if not raw_args:
                return False
            c = raw_args[0] & 0xFF
            _captured_stdout += chr(c)
        except Exception as exc:
            print(f"[tracer] PutcharBP error: {exc}")
        return False


class FprintfBP(gdb.Breakpoint):
    """Intercept fprintf(stream, fmt, ...) — captures writes to stdout/stderr."""
    def stop(self):
        global _captured_stdout
        try:
            raw_args = _read_printf_args(n_args=6)
            # raw_args[0]=stream, raw_args[1]=fmt, raw_args[2..]=variadic
            fmt_str = _gdb_read_string(raw_args[1]) if raw_args and len(raw_args) > 1 else ""

            if not fmt_str:
                # Fallback: try GDB expressions for the format param
                for expr in ("_Format", "(char*)$rdx", "(char*)$rsi"):
                    try:
                        v = gdb.parse_and_eval(expr)
                        s = v.string(length=MAX_STR_LEN)
                        if s:
                            fmt_str = s
                            if raw_args and len(raw_args) > 1:
                                raw_args[1] = int(v)
                            break
                    except Exception:
                        continue

            if not fmt_str:
                return False

            # _py_sprintf expects raw_args[0]=fmt_addr, variadic args at [1+].
            # For fprintf the ABI layout is [stream, fmt, var1, var2, ...], so
            # drop arg 0 (stream) to get [fmt, var1, var2, ...] — matching the
            # printf layout that _py_sprintf was written for.
            printf_style_args = raw_args[1:] if raw_args and len(raw_args) > 1 else [0]
            formatted = _py_sprintf(fmt_str, printf_style_args)
            _captured_stdout += formatted
        except Exception as exc:
            print(f"[tracer] FprintfBP error: {exc}")
        return False


class FputsBP(gdb.Breakpoint):
    """Intercept fputs(str, stream)."""
    def stop(self):
        global _captured_stdout
        try:
            raw_args = _read_printf_args()
            if raw_args:
                s = _gdb_read_string(raw_args[0])
                _captured_stdout += s
        except Exception as exc:
            print(f"[tracer] FputsBP error: {exc}")
        return False


def _install_stdio_breakpoints():
    """Install silent intercept breakpoints for common stdio output functions.

    We try every known symbol variant so that at least one succeeds regardless
    of platform (Linux glibc, macOS libc, Windows MinGW/UCRT).
    Logging both successes and failures is intentional: the VS Code output
    panel will show exactly which symbols resolved so problems are diagnosable.
    """
    targets = [
        # Standard C printf family
        ("printf",              PrintfBP),
        ("__printf_chk",        PrintfBP),   # glibc hardened mode (-D_FORTIFY_SOURCE)
        ("__mingw_printf",      PrintfBP),   # MinGW runtime
        ("__mingw_vfprintf",    PrintfBP),   # MinGW va-list variant (catches vprintf too)
        # fprintf variants — catches fprintf(stdout, ...) used by some code
        ("fprintf",             FprintfBP),
        ("__fprintf_chk",       FprintfBP),  # glibc hardened
        ("__mingw_fprintf",     FprintfBP),  # MinGW
        # puts / putchar
        ("puts",                PutsBP),
        ("__puts_chk",          PutsBP),     # glibc hardened
        ("putchar",             PutcharBP),
        ("putchar_unlocked",    PutcharBP),  # glibc unlocked variant
        ("_putchar_nolock",     PutcharBP),  # MinGW
        # fputs
        ("fputs",               FputsBP),
        ("fputs_unlocked",      FputsBP),    # glibc
    ]
    installed = 0
    for name, cls in targets:
        try:
            bp = cls(name, internal=True)
            bp.silent = True
            print(f"[tracer] stdio bp OK:      {name}")
            installed += 1
        except Exception as e:
            print(f"[tracer] stdio bp skipped: {name} — {e}")

    if installed == 0:
        # Last-resort: use GDB's regex breakpoint to find printf anywhere in
        # the binary's own symbol table, covering mangled/aliased variants that
        # the explicit name list above missed.
        for pattern, cls in (("^printf$", PrintfBP), ("^puts$", PutsBP),
                              ("^putchar$", PutcharBP), ("^fputs$", FputsBP)):
            try:
                # rbreak sets one bp per matching symbol — collect them all.
                gdb.execute(f"rbreak {pattern}", to_string=True)
                # The breakpoints are plain gdb.Breakpoint objects; re-wrap the
                # most recently created one with our subclass so stop() fires.
                cls(pattern.strip("^$"), internal=True).silent = True
                print(f"[tracer] stdio rbreak fallback OK: {pattern}")
                installed += 1
            except Exception as e:
                print(f"[tracer] stdio rbreak fallback failed ({pattern}): {e}")

    if installed == 0:
        print("[tracer] WARNING: no stdio breakpoints installed — "
              "falling back to file redirect for stdout capture")


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
            "step":   step_count,
            "event":  event,
            "file":   safe(lambda: os.path.basename(sal.symtab.filename)
                           if sal and sal.symtab else "<unknown>"),
            "line":   safe(lambda: sal.line if sal else 0),
            "stack":  capture_stack(),
            "heap":   heap_snapshot(),
            "stdout": _read_captured_stdout(),
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

    # Install printf/puts/putchar intercept breakpoints so we can capture
    # the inferior's stdout without any platform-specific file redirects.
    _install_stdio_breakpoints()

    # Set up the file-redirect fallback *before* running the inferior so that
    # even unflushed output buffered by the C runtime ends up in the file.
    _setup_stdout_redirect()

    try:
        if _stdout_redirect_file and platform.system() == "Windows":
            # On Windows/MinGW 'inferior-tty' is unavailable, so we use a
            # shell redirect appended to the run command.  Forward slashes
            # are required for MinGW GDB even on Windows paths.
            redir = _stdout_redirect_file.replace("\\", "/")
            gdb.execute(f"run > {redir}", to_string=True)
        else:
            # On POSIX: 'set inferior-tty' was already configured by
            # _setup_stdout_redirect(), so a plain 'run' picks it up.
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

            # After finish, re-check whether we are back in user code.
            # If we are, record a step NOW — this is critical for printf:
            # the PrintfBP fired during the preceding 'step' (which entered
            # printf), appending to _captured_stdout.  If we skip recording
            # here and just 'continue', the output is attributed to the
            # *next* user-code step instead of the line that called printf.
            try:
                frame   = gdb.newest_frame()
                sal     = frame.find_sal()
                in_user = sal and sal.symtab and sal.symtab.filename
            except Exception:
                break

            if in_user:
                outside_count = 0
                record_step("step")
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
