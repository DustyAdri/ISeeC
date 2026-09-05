import * as vscode from "vscode";
import * as path from "path";
import { compileFile, clearDiagnostics, CompilationError } from "./compiler";
import { GdbManager } from "./gdbManager";
import { StepBuffer } from "./stepBuffer";
import { WebviewProvider } from "./webviewProvider";
import { StepData } from "./types/stepTypes";

// ---------------------------------------------------------------------------
// Module-level singletons (one active session at a time)
// ---------------------------------------------------------------------------

let _outputChannel: vscode.OutputChannel;
let _gdbManager: GdbManager | null = null;
let _stepBuffer: StepBuffer | null = null;
let _webviewProvider: WebviewProvider | null = null;
let _lineDecoration: vscode.TextEditorDecorationType | null = null;
let _activeSourcePath: string | null = null;

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
  
  _webviewProvider.onResetRequest = () => {
  teardown();
  
  _webviewProvider?.postReset();
  };

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
  _webviewProvider.show(context);
  _webviewProvider.onDidDisposeCallback = () => {
    // Panel closed by user — kill GDB.
    teardown();
  };
  _webviewProvider.onStepRequest = (direction) => {
    if (direction === "forward") {
      cmdStepForward();
    } else {
      cmdStepBack();
    }
  };

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

  // 6. Resolve the tracer path (backend/gdb_tracer.py relative to extension).
  const tracerPath = path.join(
    context.extensionPath,
    "backend",
    "gdb_tracer.py"
  );

  // 7. Start GDB.
  _gdbManager = new GdbManager(
    binaryPath,
    tracerPath,
    (step: StepData) => {
      _stepBuffer!.push(step);
      _webviewProvider?.postStep(step);
      highlightLine(step.current_line);

      // Tombstone step: GDB has finished (current_line is null).
      if (step.current_line === null) {
        _webviewProvider?.postFinished(step);
      }
    },
    _outputChannel
  );

  _gdbManager.on("error", ({ code }: { code: number | null }) => {
    const msg = `GDB exited with code ${code ?? "unknown"}.`;
    _outputChannel.appendLine(`[c-stack-viz] ${msg}`);
    _webviewProvider?.postError(msg);
  });

  try {
    _gdbManager.start();
  } catch (err) {
    vscode.window.showErrorMessage(
      `c-stack-viz: Failed to start GDB: ${String(err)}`
    );
    _webviewProvider?.postError(`Failed to start GDB: ${String(err)}`);
    teardown();
    return;
  }

  // Send "next" to advance past the breakpoint GDB inserts at main().
  // gdb_tracer.py's bootstrap does `break main`, so on the first stop event
  // the tracer emits a step and then waits for a control command.
  // We do NOT auto-send here — the user drives with stepForward.
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
  if (!_stepBuffer || !_gdbManager || !_webviewProvider) {
    return;
  }

  const wasAtEnd = _stepBuffer.isAtEnd();
  const step = _stepBuffer.forward();

  if (step !== null) {
    // We advanced within the buffer — serve the cached step.
    _webviewProvider.postStep(step);
    highlightLine(step.current_line);

    // If we were sitting at the end before advancing, we consumed the last
    // buffered step but GDB hasn't sent the next one yet. Send "next" now
    // to ask GDB to execute one more line.
    if (wasAtEnd) {
      _gdbManager.sendControl("next");
    }
  } else {
    // Buffer was empty; send "next" unconditionally.
    _gdbManager.sendControl("next");
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
    _webviewProvider.postStep(step);
    highlightLine(step.current_line);
  }
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
}
