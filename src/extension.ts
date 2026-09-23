import * as vscode from "vscode";
import * as path from "path";
import { compileFile, clearDiagnostics, CompilationError } from "./compiler";
import { GdbManager } from "./gdbManager";
import { StepBuffer } from "./stepBuffer";
import { WebviewProvider } from "./webviewProvider";
import { StepData, StepMessage } from "./types/stepTypes";

// ---------------------------------------------------------------------------
// Module-level singletons (one active session at a time)
// ---------------------------------------------------------------------------

let _outputChannel: vscode.OutputChannel;
let _gdbManager: GdbManager | null = null;
let _stepBuffer: StepBuffer | null = null;
let _webviewProvider: WebviewProvider | null = null;
let _lineDecoration: vscode.TextEditorDecorationType | null = null;
let _activeSourcePath: string | null = null;
// True while the whole trace is being run eagerly to completion (see
// cmdStart) so the total step count is known before anything is shown.
let _preloading = false;

// Matches the SRS's own "must support up to 10,000 steps" buffer-size
// requirement — also doubles as a safety cap so a student's infinite loop
// can't hang the initial trace forever.
const MAX_PRELOAD_STEPS = 10000;

// ---------------------------------------------------------------------------
// Activation entry point
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  _outputChannel = vscode.window.createOutputChannel("C Stack Visualizer");

  context.subscriptions.push(
    vscode.commands.registerCommand("c-stack-viz.start", () =>
      cmdStart(context)
    ),
    vscode.commands.registerCommand("c-stack-viz.stop", cmdStop),
    vscode.commands.registerCommand("c-stack-viz.stepForward", cmdStepForward),
    vscode.commands.registerCommand("c-stack-viz.stepBack", cmdStepBack)
  );
}

export function deactivate(): void {
  teardown();
}

// ---------------------------------------------------------------------------
// Command: start
// ---------------------------------------------------------------------------

async function cmdStart(context: vscode.ExtensionContext): Promise<void> {
  // 1. Validate active editor is a .c file.
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("c-stack-viz: No active editor.");
    return;
  }

  const sourcePath = editor.document.uri.fsPath;
  if (path.extname(sourcePath).toLowerCase() !== ".c") {
    vscode.window.showErrorMessage(
      "c-stack-viz: Active file is not a .c file."
    );
    return;
  }

  // Tear down any existing session before starting a new one.
  teardown();
  _activeSourcePath = sourcePath;

  // 2. Compile.
  clearDiagnostics(sourcePath);
  let binaryPath: string;
  try {
    binaryPath = await compileFile(sourcePath);
  } catch (err) {
    if (err instanceof CompilationError) {
      vscode.window.showErrorMessage(
        `c-stack-viz: Compilation failed. See Problems panel for details.`
      );
    } else {
      vscode.window.showErrorMessage(
        `c-stack-viz: Unexpected error during compilation: ${String(err)}`
      );
    }
    return;
  }

  // 3. Set up the webview.
  _webviewProvider = new WebviewProvider();
  _webviewProvider.onDidDisposeCallback = () => {
    teardown();
  };
  _webviewProvider.onStepRequest = (direction) => {
    if (direction === "forward") {
      cmdStepForward();
    } else {
      cmdStepBack();
    }
  };
  _webviewProvider.onResetRequest = () => {
    teardown();
    _webviewProvider?.postReset();
  };
  _webviewProvider.onReady = () => {
    // The panel just (re)loaded with a blank page — restore what it showed.
    if (_preloading) {
      _webviewProvider?.postPreloadProgress(_stepBuffer?.length ?? 0);
      return;
    }
    const current = _stepBuffer?.current();
    if (current) {
      _displayStep(current);
    }
  };
  _webviewProvider.show(context);
  // Enables the Alt+Left/Right step keybindings (see package.json) only
  // while a session is live, so they don't shadow VS Code's own
  // navigate back/forward the rest of the time.
  vscode.commands.executeCommand("setContext", "c-stack-viz.active", true);

  // 4. Set up the step buffer.
  _stepBuffer = new StepBuffer();

  // 5. Create editor line highlight decoration.
  _lineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      "editor.findMatchHighlightBackground"
    ),
    isWholeLine: true,
    borderRadius: "2px",
  });

  // 6. Resolve the tracer path.
  const tracerPath = path.join(
    context.extensionPath,
    "backend",
    "gdb_tracer.py"
  );

  // 7. Start GDB. The whole trace is run eagerly to completion before
  // anything is shown — see the _preloading block below — so that the
  // "Step N / total" counter can show the program's real final step count
  // from the very first frame, instead of a number that just always
  // matches whatever step is currently on screen.
  _preloading = true;

  const manager = new GdbManager(
    binaryPath,
    tracerPath,
    (msg: StepMessage) => {
      // A killed GDB can still flush already-buffered stdout lines after
      // teardown() (or after a newer session replaced it) — drop those
      // instead of dereferencing a null/foreign _stepBuffer.
      if (_gdbManager !== manager || !_stepBuffer) {
        return;
      }
      const step = _stepBuffer.push(msg);

      if (_preloading) {
        // A crash (SIGSEGV, SIGFPE, ...) ends the trace too — the tracer
        // only accepts "quit" after emitting this step, so sending it
        // another "step" would just hang waiting for a response that
        // never comes.
        const reachedEnd = step.current_line === null || !!step.crash_signal;
        const hitCap = _stepBuffer!.length >= MAX_PRELOAD_STEPS;

        if (!reachedEnd && !hitCap) {
          // Preloading can take a while on a slow/loaded machine (each
          // step is a real GDB round-trip) and nothing was shown to the
          // user yet — without this, a slow trace and a genuinely hung
          // one look identical from the webview's side.
          _webviewProvider?.postPreloadProgress(_stepBuffer!.length);
          // "step" (not "next") so calls into user-defined functions build
          // a real call stack instead of being stepped over.
          _gdbManager?.sendControl("step");
          return;
        }

        _preloading = false;
        if (hitCap && !reachedEnd) {
          _outputChannel.appendLine(
            `[c-stack-viz] Trace truncated at ${MAX_PRELOAD_STEPS} steps — ` +
              `the program hadn't finished yet (possible infinite loop).`
          );
        }

        // Reveal step 1 now that the buffer holds the entire trace and the
        // true total is known.
        const first = _stepBuffer!.forward();
        if (first) {
          _displayStep(first);
        }
        return;
      }

      // Not preloading — every other step is served from the buffer by
      // cmdStepForward/cmdStepBack, so arrival here would only mean a stray
      // GDB message; nothing to display.
    },
    _outputChannel
  );
  _gdbManager = manager;

  manager.on("error", ({ code }: { code: number | null }) => {
    // Same guard: an old GDB being killed during teardown exits non-zero,
    // which must not show up as an error in a newer session's panel.
    if (_gdbManager !== manager) {
      return;
    }
    const msg = `GDB exited with code ${code ?? "unknown"}.`;
    _outputChannel.appendLine(`[c-stack-viz] ${msg}`);
    _webviewProvider?.postError(msg);
  });

  try {
    _gdbManager.start();
    // The tracer's initial "break main" hit fires as soon as GDB starts, so
    // the arrival callback above takes it from here — kick off the eager
    // pre-run loop by requesting the first "step".
    _gdbManager.sendControl("step");
  } catch (err) {
    vscode.window.showErrorMessage(
      `c-stack-viz: Failed to start GDB: ${String(err)}`
    );
    _webviewProvider?.postError(`Failed to start GDB: ${String(err)}`);
    teardown();
    return;
  }
}


// ---------------------------------------------------------------------------
// Command: stop
// ---------------------------------------------------------------------------

function cmdStop(): void {
  teardown();
}

// ---------------------------------------------------------------------------
// Command: stepForward
// ---------------------------------------------------------------------------

function cmdStepForward(): void {
  if (!_stepBuffer || !_webviewProvider) {
    return;
  }

  // The entire trace is already buffered by the time the user can click
  // Forward (see the eager pre-run in cmdStart), so this is always a pure
  // in-buffer navigation — no GDB round-trip needed.
  const step = _stepBuffer.forward();
  if (step !== null) {
    _displayStep(step);
  }
}

// ---------------------------------------------------------------------------
// Command: stepBack
// ---------------------------------------------------------------------------

function cmdStepBack(): void {
  if (!_stepBuffer || !_webviewProvider) {
    return;
  }

  // Backward navigation always serves from the buffer.
  // Never send a control command to GDB for backward steps.
  const step = _stepBuffer.backward();
  if (step !== null) {
    _displayStep(step);
  }
}

// ---------------------------------------------------------------------------
// Shared display helper — the only place that posts a step to the webview,
// so "finished" is always derived from the step actually being shown
// (whether reached live from GDB or by navigating buffered history) rather
// than getting stuck from a stale one-time message.
// ---------------------------------------------------------------------------

function _displayStep(step: StepData): void {
  // The buffer holds the entire trace by the time anything is ever shown
  // (see the eager pre-run in cmdStart), so its length IS the program's
  // real total step count — not just "the highest step seen so far".
  const totalSteps = _stepBuffer?.length ?? step.step;
  if (step.current_line === null) {
    _webviewProvider?.postFinished(step, totalSteps);
  } else {
    _webviewProvider?.postStep(step, totalSteps);
  }
  highlightLine(step.current_line);
}

// ---------------------------------------------------------------------------
// Editor highlight helper
// ---------------------------------------------------------------------------

function highlightLine(line: number | null): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !_lineDecoration || line === null) {
    return;
  }

  // Only highlight if the active editor shows the file we're tracing.
  if (
    _activeSourcePath &&
    editor.document.uri.fsPath !== _activeSourcePath
  ) {
    return;
  }

  const zeroIndexed = line - 1; // GDB lines are 1-indexed
  if (zeroIndexed < 0) {
    return;
  }

  const range = new vscode.Range(
    zeroIndexed,
    0,
    zeroIndexed,
    editor.document.lineAt(zeroIndexed).text.length
  );

  editor.setDecorations(_lineDecoration, [{ range }]);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function teardown(): void {
  // Send quit to GDB before disposing so it exits cleanly.
  try {
    _gdbManager?.sendControl("quit");
  } catch {
    // best-effort
  }
  _gdbManager?.dispose();
  _gdbManager = null;

  _webviewProvider?.dispose();
  _webviewProvider = null;

  _lineDecoration?.dispose();
  _lineDecoration = null;

  _stepBuffer?.reset();
  _stepBuffer = null;

  _activeSourcePath = null;

  vscode.commands.executeCommand("setContext", "c-stack-viz.active", false);
}
