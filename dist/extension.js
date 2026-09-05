"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const compiler_1 = require("./compiler");
const gdbManager_1 = require("./gdbManager");
const stepBuffer_1 = require("./stepBuffer");
const webviewProvider_1 = require("./webviewProvider");
// ---------------------------------------------------------------------------
// Module-level singletons (one active session at a time)
// ---------------------------------------------------------------------------
let _outputChannel;
let _gdbManager = null;
let _stepBuffer = null;
let _webviewProvider = null;
let _lineDecoration = null;
let _activeSourcePath = null;
// ---------------------------------------------------------------------------
// Activation entry point
// ---------------------------------------------------------------------------
function activate(context) {
    _outputChannel = vscode.window.createOutputChannel("C Stack Visualizer");
    context.subscriptions.push(vscode.commands.registerCommand("c-stack-viz.start", () => cmdStart(context)), vscode.commands.registerCommand("c-stack-viz.stop", cmdStop), vscode.commands.registerCommand("c-stack-viz.stepForward", cmdStepForward), vscode.commands.registerCommand("c-stack-viz.stepBack", cmdStepBack));
}
function deactivate() {
    teardown();
}
// ---------------------------------------------------------------------------
// Command: start
// ---------------------------------------------------------------------------
async function cmdStart(context) {
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
        vscode.window.showErrorMessage("c-stack-viz: Active file is not a .c file.");
        return;
    }
    // Tear down any existing session before starting a new one.
    teardown();
    _activeSourcePath = sourcePath;
    // 2. Compile.
    (0, compiler_1.clearDiagnostics)(sourcePath);
    let binaryPath;
    try {
        binaryPath = await (0, compiler_1.compileFile)(sourcePath);
    }
    catch (err) {
        if (err instanceof compiler_1.CompilationError) {
            vscode.window.showErrorMessage(`c-stack-viz: Compilation failed. See Problems panel for details.`);
        }
        else {
            vscode.window.showErrorMessage(`c-stack-viz: Unexpected error during compilation: ${String(err)}`);
        }
        return;
    }
    // 3. Set up the webview.
    _webviewProvider = new webviewProvider_1.WebviewProvider();
    _webviewProvider.show(context);
    _webviewProvider.onDidDisposeCallback = () => {
        // Panel closed by user — kill GDB.
        teardown();
    };
    _webviewProvider.onStepRequest = (direction) => {
        if (direction === "forward") {
            cmdStepForward();
        }
        else {
            cmdStepBack();
        }
    };
    // 4. Set up the step buffer.
    _stepBuffer = new stepBuffer_1.StepBuffer();
    // 5. Create editor line highlight decoration.
    _lineDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
        isWholeLine: true,
        borderRadius: "2px",
    });
    // 6. Resolve the tracer path (backend/gdb_tracer.py relative to extension).
    const tracerPath = path.join(context.extensionPath, "backend", "gdb_tracer.py");
    // 7. Start GDB.
    _gdbManager = new gdbManager_1.GdbManager(binaryPath, tracerPath, (step) => {
        _stepBuffer.push(step);
        _webviewProvider?.postStep(step);
        highlightLine(step.current_line);
        // Tombstone step: GDB has finished (current_line is null).
        if (step.current_line === null) {
            _webviewProvider?.postFinished(step);
        }
    }, _outputChannel);
    _gdbManager.on("error", ({ code }) => {
        const msg = `GDB exited with code ${code ?? "unknown"}.`;
        _outputChannel.appendLine(`[c-stack-viz] ${msg}`);
        _webviewProvider?.postError(msg);
    });
    try {
        _gdbManager.start();
    }
    catch (err) {
        vscode.window.showErrorMessage(`c-stack-viz: Failed to start GDB: ${String(err)}`);
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
function cmdStop() {
    teardown();
}
// ---------------------------------------------------------------------------
// Command: stepForward
// ---------------------------------------------------------------------------
function cmdStepForward() {
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
    }
    else {
        // Buffer was empty; send "next" unconditionally.
        _gdbManager.sendControl("next");
    }
}
// ---------------------------------------------------------------------------
// Command: stepBack
// ---------------------------------------------------------------------------
function cmdStepBack() {
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
function highlightLine(line) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !_lineDecoration || line === null) {
        return;
    }
    // Only highlight if the active editor shows the file we're tracing.
    if (_activeSourcePath &&
        editor.document.uri.fsPath !== _activeSourcePath) {
        return;
    }
    const zeroIndexed = line - 1; // GDB lines are 1-indexed
    if (zeroIndexed < 0) {
        return;
    }
    const range = new vscode.Range(zeroIndexed, 0, zeroIndexed, editor.document.lineAt(zeroIndexed).text.length);
    editor.setDecorations(_lineDecoration, [{ range }]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
function teardown() {
    // Send quit to GDB before disposing so it exits cleanly.
    try {
        _gdbManager?.sendControl("quit");
    }
    catch {
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
