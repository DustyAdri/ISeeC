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
import os
import tempfile

# ---------------------------------------------------------------------------
# Heap registry  (Capability A)
# ---------------------------------------------------------------------------

# Maps hex address string → heap block dict.
# Entries are never removed — freed blocks remain with is_allocated: False.
_heap = {}          # type: dict[str, dict]
_malloc_size = [0]  # capture malloc argument across entry→finish

# ---------------------------------------------------------------------------
# Uninitialized/"garbage" value detection
# ---------------------------------------------------------------------------
#
# GDB has no notion of "has the program actually assigned this yet" — it
# just reads whatever bytes are sitting in memory, so a freshly-declared
# local or a just-malloc'd struct field reads back as a real-looking (but
# meaningless) number. There's no way to know this with certainty short of
# real data-flow analysis, so this uses a practical heuristic instead:
# remember the value first observed for a variable/field the moment its
# stack frame or heap allocation begins, and keep treating it as garbage
# for as long as it still matches that snapshot. The instant the program
# writes something different, it's treated as a real, known value from
# then on (even if later reassigned back to a coincidentally-matching
# value — a rare, accepted false negative).
#
# Keyed by (frame_key, variable_name) for locals, or (heap_address, field)
# for heap struct fields, so repeated/recursive invocations and reused
# heap addresses each start their own fresh episode rather than comparing
# against a stale value from a previous, unrelated occupant.
_uninit_baseline = {}       # (frame_key, name) -> first-seen value_str
_prev_frame_keys = set()    # frame keys present as of the previous step
_heap_field_baseline = {}   # (address, field_name) -> first-seen value_str


def _frame_key(frame):
    """A stable identifier for one specific *invocation* of a frame, so
    recursive/repeated calls to the same function don't share a garbage
    baseline just because the stack happens to reuse the same addresses."""
    try:
        return int(frame.read_register("sp"))
    except Exception:
        try:
            return frame.level()
        except Exception:
            return id(frame)


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


def _describe_type(t):
    """
    Beginner-friendly type label for the UI, e.g. "int",
    "pointer to struct Node", "array of 5 int".

    Typedefs are expanded when they hide a pointer/struct/array (so
    `nodePtr` reads as "pointer to struct Node"), but kept for plain
    scalars so e.g. `size_t` doesn't turn into "unsigned long long".
    Recursion only follows pointer/array targets and stops at a struct's
    name, so self-referential structs can't loop.
    """
    try:
        s = _strip_type(t)
        code = s.code
        if code == gdb.TYPE_CODE_PTR:
            return "pointer to " + _describe_type(s.target())
        if code == gdb.TYPE_CODE_ARRAY:
            try:
                lo, hi = s.range()
                return "array of {} {}".format(hi - lo + 1, _describe_type(s.target()))
            except Exception:
                return "array of " + _describe_type(s.target())
        if code == gdb.TYPE_CODE_STRUCT:
            return "struct " + s.tag if s.tag else "struct"
        if code == gdb.TYPE_CODE_UNION:
            return "union " + s.tag if s.tag else "union"
        if code == gdb.TYPE_CODE_ENUM:
            return "enum " + s.tag if s.tag else "enum"
        if code == gdb.TYPE_CODE_FUNC:
            return "function"
        return str(t.unqualified()).strip()
    except Exception:
        return _type_str(t)


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

def _encode_var(name, sym, frame, frame_key, is_fresh_frame):
    """
    Read one local variable / argument from *frame* and return its dict.

    *frame_key* identifies this specific frame invocation and *is_fresh_frame*
    is True the first time this invocation is observed — together these
    drive the garbage-value heuristic described above _uninit_baseline.

    That heuristic only applies to actual locals (sym.is_variable):
    function parameters (sym.is_argument) are real, program-supplied values
    from the moment the function is entered — the very first observation of
    a parameter is its genuine argument value, not garbage, so treating "the
    first value we see" as a garbage baseline would be wrong for them.
    """
    result = {
        "name": name,
        "type": "unknown",
        "type_label": "unknown",
        "value": "?",
        "target_address": None,
        "uninitialized": False,
    }

    try:
        result["type"] = _type_str(sym.type)
        result["type_label"] = _describe_type(sym.type)
    except Exception:
        pass

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
    result["type_label"] = _describe_type(val.type)
    value_str, target_addr = _encode_scalar(val)

    if value_str == "?":
        result["uninitialized"] = True
    elif sym.is_variable:
        baseline_key = (frame_key, name)
        if is_fresh_frame or baseline_key not in _uninit_baseline:
            # First time we've seen this local in this invocation —
            # whatever it holds right now is the "garbage" baseline.
            _uninit_baseline[baseline_key] = value_str
            result["uninitialized"] = True
        elif _uninit_baseline[baseline_key] == value_str:
            result["uninitialized"] = True
        # else: value differs from the entry snapshot — the program has
        # written to it, so it's treated as real from here on.

    if result["uninitialized"]:
        result["value"] = "?"
        result["target_address"] = None
    else:
        result["value"] = value_str
        result["target_address"] = target_addr
    return result


# ---------------------------------------------------------------------------
# Struct field reader  (Capability B)
# ---------------------------------------------------------------------------

def _read_struct_fields(ptr_val):
    """
    Given a gdb.Value that is a pointer-to-struct, dereference it and read
    all fields at depth 1.  Returns (type_name_str, data_dict, field_types).
    data_dict maps field_name → encoded_value_str; field_types maps
    field_name → _describe_type label.
    On any MemoryError returns (None, {}, {}).
    """
    data = {}
    field_types = {}
    type_name = None
    try:
        base_ptr_type = _strip_type(ptr_val.type)
        target_type = _strip_type(base_ptr_type.target())
        if target_type.code != gdb.TYPE_CODE_STRUCT:
            return None, {}, {}

        # Struct type name, e.g. "struct Node" (anonymous structs → "struct")
        type_name = _describe_type(target_type)

        # Identifies this specific allocation living at this address, so a
        # field's garbage baseline (see _uninit_baseline) doesn't carry
        # over from whatever previously occupied this address before being
        # freed and reallocated.
        try:
            block_addr = int(ptr_val)
        except Exception:
            block_addr = None

        deref = ptr_val.dereference()

        for field in target_type.fields():
            fname = field.name
            if fname is None:
                continue
            field_types[fname] = _describe_type(field.type)
            try:
                fval = deref[fname]
                value_str, _ = _encode_scalar(fval)

                if value_str == "?" or block_addr is None:
                    data[fname] = value_str
                    continue

                baseline_key = (block_addr, fname)
                if baseline_key not in _heap_field_baseline:
                    _heap_field_baseline[baseline_key] = value_str
                    data[fname] = "?"
                elif _heap_field_baseline[baseline_key] == value_str:
                    data[fname] = "?"
                else:
                    data[fname] = value_str
            except gdb.MemoryError:
                data[fname] = "?"
            except Exception:
                data[fname] = "?"

        return type_name, data, field_types

    except gdb.MemoryError:
        return None, {}, {}
    except Exception:
        return type_name, {}, {}


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

                type_name, data, field_types = _read_struct_fields(val)
                if type_name is not None:
                    _heap[h]["type"] = type_name
                if data:
                    _heap[h]["data"] = data
                    _heap[h]["field_types"] = field_types

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
    current_frame_keys = set()

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

        frame_key = _frame_key(frame)
        current_frame_keys.add(frame_key)
        is_fresh_frame = frame_key not in _prev_frame_keys

        variables = []
        try:
            block = frame.block()
            seen = set()
            b = block
            while b is not None:
                for sym in b:
                    if (sym.is_argument or sym.is_variable) and sym.name not in seen:
                        seen.add(sym.name)
                        variables.append(
                            _encode_var(sym.name, sym, frame, frame_key, is_fresh_frame)
                        )
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
    _prev_frame_keys.clear()
    _prev_frame_keys.update(current_frame_keys)
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


def _has_real_source(frame):
    """
    True if *frame* corresponds to a source file that actually exists on
    disk. Library/CRT frames (e.g. printf, mainCRTStartup) often carry a
    symtab with line numbers but no matching local file — those are the
    frames we want to silently step through rather than show to the user.
    """
    try:
        sal = frame.find_sal()
        if sal is None or sal.symtab is None or not sal.line:
            return False
        fullname = sal.symtab.fullname()
        return bool(fullname) and os.path.exists(fullname)
    except Exception:
        return False


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
# Inferior stdout capture
# ---------------------------------------------------------------------------
#
# GDB does not reliably share the debuggee's stdout with our own stdout pipe
# on Windows when GDB itself has no real console (exactly the case when the
# extension spawns it via a piped child process) — the traced program's own
# printf() output simply vanishes. Redirecting the inferior's output to a
# temp file we control and tailing it ourselves sidesteps that entirely.

_stdout_capture_path = [None]   # type: list[str | None]
_stdout_capture_pos = [0]
_stdout_accumulated = [""]      # full captured text so far, for replay-safety


class _RunTracedCommand(gdb.Command):
    """`run_traced` — like `run`, but redirects the inferior's stdout/stderr
    to a temp file so we can capture program output ourselves instead of
    relying on GDB to share it with our own stdout pipe."""

    def __init__(self):
        super().__init__("run_traced", gdb.COMMAND_RUNNING)

    def invoke(self, arg, from_tty):
        fd, path = tempfile.mkstemp(prefix="c_stack_viz_stdout_", suffix=".log")
        os.close(fd)
        _stdout_capture_path[0] = path
        gdb.execute("run > %s 2>&1" % path)


_RunTracedCommand()


def _flush_inferior_stdio():
    """Force the debuggee to flush its own C stdio buffers right now.

    Redirecting stdout to a file (rather than a tty) switches the CRT to
    fully-buffered mode, so printf() output can sit unflushed for a long
    time — and if the inferior is later killed (e.g. by "quit" before it
    reaches its own natural exit), whatever's still buffered is lost for
    good. Calling this before every read means each step only ever risks
    losing output produced *since* the last step, not everything printed
    so far.

    Must NOT be attempted once the inferior has already exited (i.e. when
    called from _on_exit for the final tombstone): calling a function in a
    process that no longer exists is undefined behavior, and on Windows —
    specifically when gdb itself has no real console, exactly the case
    when the extension spawns it as a child process — this doesn't raise a
    catchable gdb.error, it crashes gdb.exe itself outright. Checking for a
    live thread first avoids ever reaching that call in the first place;
    whatever the process printed before it exited is already flushed by
    its own normal C runtime exit sequence anyway, so skipping this here
    loses nothing.
    """
    try:
        if gdb.selected_thread() is None:
            return
        gdb.execute("call (int) fflush(0)", to_string=True)
    except (gdb.error, RuntimeError):
        pass  # no running inferior, or fflush not callable right now


def _read_new_output(attempt_flush=True):
    """Returns all program output captured so far (cumulative, not just the
    delta) so that any buffered step — whether just emitted or replayed via
    backward/forward navigation — carries the output that was visible at
    that exact point in execution.

    *attempt_flush* must be False when the inferior just crashed: it's
    still technically "alive" (gdb.selected_thread() is not None) so the
    guard in _flush_inferior_stdio() won't catch it, but calling a function
    in a thread that's mid-signal is exactly the kind of undefined
    behavior that guard exists to avoid. Reading whatever already made it
    to disk is still safe and lossless for anything printed before the
    crash.
    """
    path = _stdout_capture_path[0]
    if not path:
        return _stdout_accumulated[0]
    if attempt_flush:
        _flush_inferior_stdio()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(_stdout_capture_pos[0])
            data = f.read()
            _stdout_capture_pos[0] = f.tell()
        if data:
            _stdout_accumulated[0] += data
    except Exception:
        pass
    return _stdout_accumulated[0]


def _cleanup_stdout_capture():
    path = _stdout_capture_path[0]
    if path:
        try:
            os.remove(path)
        except Exception:
            pass
        _stdout_capture_path[0] = None


# ---------------------------------------------------------------------------
# I/O  (Prompt 1 — _emit updated to include heap_blocks)
# ---------------------------------------------------------------------------

_step_count = [0]


# Last JSON sent for each heap block, and the last program output sent —
# steps only carry what changed since the previous step (see _write_step).
_sent_heap_json = {}      # address -> json string
_sent_output = [None]


def _write_step(current_line, next_ln, stack_frames, crash_signal, output):
    """
    Emit one step as a *delta* against the previous one, to keep both the
    pipe traffic and the extension's memory proportional to what actually
    changed rather than to (steps x heap size):

    - "heap_changes": only blocks that are new or differ from what was last
      sent. Blocks are never removed from _heap and a dict keeps a key's
      original position when reassigned, so the extension can rebuild the
      full, identically-ordered list by applying changes to an ordered map.
    - "program_output": included only when it differs from the last value
      sent; when absent, the previous step's output still applies.
    """
    _step_count[0] += 1
    changes = []
    for addr, block in _heap.items():
        j = json.dumps(block, sort_keys=True)
        if _sent_heap_json.get(addr) != j:
            _sent_heap_json[addr] = j
            changes.append(block)

    obj = {
        "step": _step_count[0],
        "current_line": current_line,
        "next_line": next_ln,
        "stack_frames": stack_frames,
        "heap_changes": changes,
        "crash_signal": crash_signal,
    }
    if output != _sent_output[0]:
        _sent_output[0] = output
        obj["program_output"] = output

    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _emit(current_line, next_ln, stack_frames):
    # Cumulative program stdout/stderr captured so far (see
    # _RunTracedCommand / _read_new_output above).
    _write_step(current_line, next_ln, stack_frames, None, _read_new_output())


def _emit_crash(signal_name, current_line, stack_frames):
    """Emits the terminal step for a real crash (SIGSEGV, SIGABRT, SIGFPE,
    etc). *current_line* is deliberately the crashing line, not None —
    unlike a normal finish, seeing exactly where and with what state the
    program crashed is the whole point. next_line is always None: there is
    no next line, the program cannot continue from here.
    """
    # Never attempt a flush here — see _read_new_output's docstring.
    _write_step(current_line, None, stack_frames, signal_name,
                _read_new_output(attempt_flush=False))
    sys.stderr.write("%s\n" % signal_name)
    sys.stderr.flush()


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
            # First integer/pointer argument: $rcx under the Microsoft x64
            # calling convention (native Windows gdb), not $rdi (System V).
            size = int(gdb.parse_and_eval("(size_t)$rcx"))
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
            # By the time a FinishBreakpoint fires, execution is back in
            # the caller of malloc — so this is the frame that actually
            # requested the allocation. If it has no real local source
            # (e.g. printf's internal buffer setup, CRT startup), this is
            # library bookkeeping the user never asked to see, not their
            # allocation — skip tracking it so it doesn't pollute the heap
            # panel with unrelated blocks.
            if not _has_real_source(gdb.selected_frame()):
                return False

            rv = self.return_value
            addr_int = int(rv) if rv is not None else int(gdb.parse_and_eval("(void*)$rax"))
            if addr_int != 0:
                h = hex(addr_int)
                _heap[h] = {
                    "address": h,
                    "type": "void",
                    "data": {},
                    "field_types": {},
                    "is_allocated": True,
                }
                # A fresh allocation at this address starts its own
                # garbage-detection episode — clear any stale per-field
                # baselines left over from whatever previously occupied it
                # (freed, then reallocated to the same spot).
                for key in [k for k in _heap_field_baseline if k[0] == addr_int]:
                    del _heap_field_baseline[key]
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
            # $rcx, not $rdi — see the matching note in _MallocBreakpoint.
            addr_int = int(gdb.parse_and_eval("(void*)$rcx"))
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
_crashed = [False]  # True once _emit_crash has sent the terminal step


def _on_stop(event):
    """
    Fired after each step/next/breakpoint stop.

    Note: gdb.execute("next") fires stop synchronously (recursive call),
    so no re-entrancy guard is used — recursion IS the loop.
    """
    # A real crash (segfault, abort, floating-point exception, ...) leaves
    # the inferior in an undefined state. This must be checked first,
    # before anything else below touches the process — stepping further,
    # or even calling an inferior function like the fflush() inside
    # _emit()'s normal output-flushing, can send gdb itself into a
    # runaway loop of trap signals on Windows instead of raising a clean,
    # catchable error. SIGTRAP is gdb's own internal single-step/breakpoint
    # mechanism, and SIGINT is a user-requested interrupt — neither is the
    # user's program crashing, so both are excluded here.
    if isinstance(event, gdb.SignalEvent) and event.stop_signal not in ("SIGTRAP", "SIGINT"):
        _crashed[0] = True
        cur = _current_line()
        frames, _ = _collect_frames()
        _emit_crash(event.stop_signal, cur, frames)
        # The only safe remaining action is to wait for "quit" and let gdb
        # tear the crashed inferior down itself; anything else (stepping,
        # continuing, inferior calls) is exactly what must be avoided now.
        while True:
            cmd = _read_cmd()
            if cmd == "quit":
                try:
                    gdb.execute("quit")
                except Exception:
                    pass
                return
        return

    # Install malloc/free breakpoints on first stop (after PLT is resolved)
    if not _heap_bps_installed[0]:
        _heap_bps_installed[0] = True
        try:
            _MallocBreakpoint()
            _FreeBreakpoint()
        except Exception:
            pass

    # "step" (used so calls into user functions build a real call stack) also
    # steps into library/CRT code that has no matching local source file.
    # Silently finish back out of those frames instead of emitting a step
    # for them — this re-enters _on_stop recursively and keeps unwinding
    # until we land back in code we can actually show.
    try:
        if not _has_real_source(gdb.selected_frame()):
            # Keep stepping until we're back in code with real source.
            # NOTE: to_string=True must NOT be used here — it suppresses
            # gdb's synchronous re-dispatch of events.stop, which this
            # recursive design (and the dispatch at the bottom of this
            # function) depends on to keep the loop going.
            gdb.execute("step")
            return
    except (gdb.error, RuntimeError):
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
    """Emit final tombstone step when the inferior exits cleanly.

    Skipped if a crash already sent its own terminal step — gdb's "quit"
    on a crashed-but-still-attached inferior fires this event too, and a
    generic empty tombstone right after the crash step would just be a
    confusing, redundant extra step.
    """
    if not _crashed[0]:
        _emit(None, None, [])
    _cleanup_stdout_capture()


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

gdb.execute("set pagination off", to_string=True)
gdb.execute("set confirm off", to_string=True)
gdb.execute("set print pretty off", to_string=True)

gdb.events.stop.connect(_on_stop)
gdb.events.exited.connect(_on_exit)

gdb.execute("break main", to_string=True)
