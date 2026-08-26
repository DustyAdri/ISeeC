/**
 * VisualizerPanel.ts
 *
 * Owns the WebviewPanel lifecycle end-to-end:
 *   1. Compiles the .c file with gcc.
 *   2. Runs GDB + tracer.py to produce trace.json.
 *   3. Creates / revives a WebviewPanel and sends the trace into it.
 *   4. Handles bidirectional messaging with the Webview.
 */
import * as vscode from "vscode";
export declare class VisualizerPanel {
    private static _instance;
    private readonly _panel;
    private readonly _context;
    private _currentFileUri;
    private _disposables;
    private _isRunning;
    private _traceLoaded;
    private _lastTrace;
    static createOrShow(context: vscode.ExtensionContext, fileUri: vscode.Uri): Promise<void>;
    static rerun(context: vscode.ExtensionContext): Promise<void>;
    static dispose(): void;
    private constructor();
    disposePanel(): void;
    /**
     * Full pipeline: compile → GDB trace → read JSON → post to Webview.
     * All errors surface as VS Code error notifications + Webview error banners.
     */
    private _runTrace;
    private _compile;
    private _runGdb;
    private _readTrace;
    /**
     * Resolve tracer.py: look beside the active .c file first, then
     * fall back to the copy bundled with the extension under /media.
     */
    private _resolveTracerPath;
    private _postMessage;
    private _showError;
    private _handleWebviewMessage;
    private _syncEditorToStep;
    private _stubReadMemory;
    private _buildWebviewHtml;
}
