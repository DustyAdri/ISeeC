"use strict";
/**
 * VisualizerPanel.ts
 *
 * Owns the WebviewPanel lifecycle end-to-end:
 *   1. Compiles the .c file with gcc.
 *   2. Runs GDB + tracer.py to produce trace.json.
 *   3. Creates / revives a WebviewPanel and sends the trace into it.
 *   4. Handles bidirectional messaging with the Webview.
 */
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
exports.VisualizerPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// ── Constants ──────────────────────────────────────────────────────────────
const VIEW_TYPE = "cExecutionVisualizer";
const PANEL_TITLE = "C Execution Visualizer";
/** tracer.py must live next to the extension or be bundled under /media */
const TRACER_SCRIPT = "tracer.py";
const TRACE_OUTPUT = "trace.json";
/** Milliseconds before we consider a GDB run hung */
const GDB_TIMEOUT_MS = 120_000;
// ── VisualizerPanel ────────────────────────────────────────────────────────
class VisualizerPanel {
    // Singleton — only one panel at a time.
    static _instance;
    _panel;
    _context;
    _currentFileUri;
    _disposables = [];
    _isRunning = false;
    _traceLoaded = false;
    _webviewReady = false;
    _lastTrace;
    // ── Factory ──────────────────────────────────────────────────────────────
    static async createOrShow(context, fileUri) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (VisualizerPanel._instance) {
            // Reuse existing panel but retarget to the new file.
            VisualizerPanel._instance._currentFileUri = fileUri;
            VisualizerPanel._instance._panel.reveal(column);
            await VisualizerPanel._instance._runTrace();
            return;
        }
        const panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                // Allow the Webview to load assets from the extension's /media folder.
                vscode.Uri.joinPath(context.extensionUri, "media"),
            ],
        });
        VisualizerPanel._instance = new VisualizerPanel(context, panel, fileUri);
    }
    static async rerun(context) {
        if (VisualizerPanel._instance) {
            await VisualizerPanel._instance._runTrace();
        }
    }
    static dispose() {
        VisualizerPanel._instance?.disposePanel();
        _outputChannel.dispose();
    }
    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(context, panel, fileUri) {
        this._context = context;
        this._panel = panel;
        this._currentFileUri = fileUri;
        // Set the initial HTML shell (spinner shown until trace arrives).
        this._panel.webview.html = this._buildWebviewHtml();
        // Listen for panel disposal (user closed the tab).
        this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);
        // Handle messages from the Webview.
        this._panel.webview.onDidReceiveMessage((msg) => this._handleWebviewMessage(msg), null, this._disposables);
        // Kick off the first trace immediately.
        this._runTrace();
    }
    // ── Public teardown ──────────────────────────────────────────────────────
    disposePanel() {
        VisualizerPanel._instance = undefined;
        this._panel.dispose();
        for (const d of this._disposables)
            d.dispose();
        this._disposables = [];
    }
    // ── Core pipeline ────────────────────────────────────────────────────────
    /**
     * Full pipeline: compile → GDB trace → read JSON → post to Webview.
     * All errors surface as VS Code error notifications + Webview error banners.
     */
    async _runTrace() {
        if (this._isRunning) {
            this._postMessage({ command: "STATUS", text: "Trace already running…" });
            return;
        }
        this._isRunning = true;
        this._traceLoaded = false;
        try {
            const filePath = this._currentFileUri.fsPath;
            const dir = path.dirname(filePath);
            const ext = process.platform === 'win32' ? '.exe' : '.out';
            const outDir = this._context.globalStorageUri.fsPath;
            fs.mkdirSync(outDir, { recursive: true });
            const outBinary = path.join(outDir, `cvis_program${ext}`);
            const traceFile = path.join(outDir, `cvis_trace.json`);
            // Delete stale files so Windows doesn't lock the exe between runs.
            try {
                if (fs.existsSync(outBinary)) {
                    fs.unlinkSync(outBinary);
                }
            }
            catch (_) { }
            try {
                if (fs.existsSync(traceFile)) {
                    fs.unlinkSync(traceFile);
                }
            }
            catch (_) { }
            const tracerPath = this._resolveTracerPath(dir);
            _outputChannel.appendLine(`\n${'='.repeat(60)}`);
            _outputChannel.appendLine(`[cVisualizer] Source:  ${filePath}`);
            _outputChannel.appendLine(`[cVisualizer] Binary:  ${outBinary}`);
            _outputChannel.appendLine(`[cVisualizer] Trace:   ${traceFile}`);
            _outputChannel.appendLine(`[cVisualizer] Tracer:  ${tracerPath}`);
            _outputChannel.show(true);
            this._postMessage({ command: "STATUS", text: "Compiling…" });
            // ── Step 1: Compile ─────────────────────────────────────────────────
            try {
                const r = await this._compile(filePath, outBinary);
                _outputChannel.appendLine(`[gcc stdout] ${r.stdout}`);
                _outputChannel.appendLine(`[gcc stderr] ${r.stderr}`);
            }
            catch (err) {
                const msg = `Compilation failed:\n${err.message}`;
                _outputChannel.appendLine(`[gcc ERROR] ${msg}`);
                this._showError(msg);
                return;
            }
            if (!fs.existsSync(outBinary)) {
                const msg = `gcc ran but binary not found at: ${outBinary}`;
                _outputChannel.appendLine(`[gcc ERROR] ${msg}`);
                this._showError(msg);
                return;
            }
            _outputChannel.appendLine(`[gcc] binary OK: ${outBinary}`);
            this._postMessage({ command: "STATUS", text: "Running GDB trace…" });
            // ── Step 2: GDB trace ────────────────────────────────────────────────
            let gdbOut = { stdout: "", stderr: "" };
            try {
                gdbOut = await this._runGdb(tracerPath, outBinary, outDir, traceFile);
            }
            catch (err) {
                const e = err;
                gdbOut.stdout = e.stdout ?? "";
                gdbOut.stderr = e.stderr ?? err.message;
            }
            _outputChannel.appendLine(`[GDB stdout]\n${gdbOut.stdout}`);
            _outputChannel.appendLine(`[GDB stderr]\n${gdbOut.stderr}`);
            // ── Step 3: Read trace.json ──────────────────────────────────────────
            _outputChannel.appendLine(`[cVisualizer] Checking for trace at: ${traceFile}`);
            _outputChannel.appendLine(`[cVisualizer] File exists: ${fs.existsSync(traceFile)}`);
            let traceData;
            try {
                traceData = this._readTrace(traceFile);
            }
            catch (err) {
                const gdbDiag = gdbOut.stderr || gdbOut.stdout || "(no output)";
                const msg = `GDB did not produce trace.json.\n\nCheck the "C Visualizer" output panel for full GDB logs.\n\nGDB output:\n${gdbDiag}`;
                this._showError(msg);
                return;
            }
            _outputChannel.appendLine(`[cVisualizer] Loaded ${traceData.total_steps} steps OK`);
            // ── Step 4: Read source file and send to Webview ───────────────────
            let sourceText = "";
            try {
                sourceText = fs.readFileSync(filePath, "utf8");
            }
            catch (_) { }
            // Cache the trace so READY can replay it without re-running GDB.
            this._lastTrace = { data: traceData, source: sourceText, filename: path.basename(filePath) };
            this._traceLoaded = true;
            if (this._webviewReady) {
                this._postMessage({
                    command: "LOAD_TRACE",
                    data: traceData,
                    source: sourceText,
                    filename: path.basename(filePath),
                });
            }
        }
        finally {
            this._isRunning = false;
        }
    }
    // ── Step implementations ─────────────────────────────────────────────────
    async _compile(src, out) {
        const cfg = vscode.workspace.getConfiguration("cVisualizer");
        const cc = cfg.get("compiler", "gcc");
        const flags = cfg.get("compilerFlags", "-g -O0 -Wall");
        const flagArgs = flags.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((flag) => flag.replace(/^"|"$/g, "")) ?? [];
        const args = [...flagArgs, src, "-o", out];
        _outputChannel.appendLine(`[gcc] spawn: ${cc} ${JSON.stringify(args)}`);
        try {
            const r = await execFileAsync(cc, args, { timeout: 30_000 });
            _outputChannel.appendLine(`[gcc] exit ok, checking: ${out}`);
            return r;
        }
        catch (err) {
            const e = err;
            throw new Error(e.stderr || e.message);
        }
    }
    async _runGdb(tracerPath, binary, cwd, traceFile) {
        const cfg = vscode.workspace.getConfiguration("cVisualizer");
        const gdbBin = cfg.get("gdbPath", "gdb");
        // GDB (MinGW/MSYS2) requires forward slashes even on Windows.
        const tracerFwd = tracerPath.replace(/\\/g, '/');
        const binaryFwd = binary.replace(/\\/g, '/');
        const traceFwd = traceFile.replace(/\\/g, '/');
        const env = {
            ...process.env,
            CVIS_TRACE_OUT: traceFwd,
            CVIS_MAX_STEPS: String(cfg.get("maxSteps", 5000)),
        };
        _outputChannel.appendLine(`[GDB] tracer : ${tracerFwd}`);
        _outputChannel.appendLine(`[GDB] binary : ${binaryFwd}`);
        _outputChannel.appendLine(`[GDB] trace  : ${traceFwd}`);
        return new Promise((resolve) => {
            const args = ["-batch", "--command", tracerFwd, binaryFwd];
            _outputChannel.appendLine(`[GDB] spawn  : ${gdbBin} ${JSON.stringify(args)}`);
            let stdout = "";
            let stderr = "";
            let settled = false;
            let timeoutHandle;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutHandle);
                resolve({ stdout, stderr });
            };
            const proc = (0, child_process_1.spawn)(gdbBin, args, { cwd, env });
            proc.stdout.on("data", (d) => { stdout += d.toString(); });
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("error", (err) => {
                stderr += `\nspawn error: ${err.message}`;
                finish();
            });
            proc.on("close", finish);
            timeoutHandle = setTimeout(() => {
                stderr += "\n[cVisualizer] GDB timed out after 120s -- the traced program is likely waiting on input (scanf) or stuck in an infinite loop";
                try {
                    proc.kill();
                }
                catch (_) { }
                finish();
            }, GDB_TIMEOUT_MS);
        });
    }
    _readTrace(tracePath) {
        if (!fs.existsSync(tracePath)) {
            throw new Error(`trace.json not found at ${tracePath}`);
        }
        const raw = fs.readFileSync(tracePath, "utf-8");
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error("trace.json exists but contains invalid JSON.");
        }
    }
    /**
     * Resolve tracer.py: look beside the active .c file first, then
     * fall back to the copy bundled with the extension under /media.
     */
    _resolveTracerPath(cFileDir) {
        const candidates = [
            path.join(cFileDir, TRACER_SCRIPT),
            path.join(this._context.extensionPath, "media", TRACER_SCRIPT),
            path.join(this._context.extensionPath, TRACER_SCRIPT),
        ];
        _outputChannel.appendLine(`[tracer] extensionPath = ${this._context.extensionPath}`);
        for (const p of candidates) {
            _outputChannel.appendLine(`[tracer] checking: ${p} → exists=${fs.existsSync(p)}`);
            if (fs.existsSync(p)) {
                return p;
            }
        }
        throw new Error(`tracer.py not found. Checked:\n${candidates.join("\n")}`);
    }
    // ── Messaging helpers ─────────────────────────────────────────────────────
    _postMessage(msg) {
        this._panel.webview.postMessage(msg).then(undefined, (err) => console.error("[cVisualizer] postMessage failed:", err));
    }
    _showError(message) {
        vscode.window.showErrorMessage(`C Visualizer: ${message}`);
        this._postMessage({ command: "ERROR", message });
    }
    // ── Inbound message handler ───────────────────────────────────────────────
    _handleWebviewMessage(msg) {
        switch (msg.command) {
            case "READY":
                this._webviewReady = true;
                if (this._traceLoaded && this._lastTrace) {
                    // Webview just (re)loaded — push the cached trace, no GDB rerun needed.
                    this._postMessage({
                        command: "LOAD_TRACE",
                        data: this._lastTrace.data,
                        source: this._lastTrace.source,
                        filename: this._lastTrace.filename,
                    });
                }
                else if (!this._isRunning) {
                    this._runTrace();
                }
                break;
            case "RERUN":
                this._runTrace();
                break;
            case "JUMP_TO_STEP":
                this._syncEditorToStep(msg.step);
                break;
            case "INSPECT_MEMORY": {
                const bytes = this._stubReadMemory(msg.address, msg.byteCount);
                this._postMessage({
                    command: "MEMORY_REGION",
                    address: msg.address,
                    bytes,
                });
                break;
            }
            case "LOG":
                _outputChannel.appendLine(`[webview][${msg.level}] ${msg.text}`);
                break;
            default:
                console.warn("[cVisualizer] Unknown message from Webview:", msg);
        }
    }
    _syncEditorToStep(step) {
        void step;
    }
    _stubReadMemory(_address, byteCount) {
        return new Array(byteCount).fill(0);
    }
    // ── HTML shell ───────────────────────────────────────────────────────────
    _buildWebviewHtml() {
        const webview = this._panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "webview.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, "media", "webview.css"));
        const nonce = _generateNonce();
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
        ].join("; ");
        // Only emit the override script tag if the file actually exists.
        // A missing webview.js causes the CSP to block its failed load response,
        // which can prevent the inline script from completing on some webview versions.
        const webviewJsPath = path.join(this._context.extensionPath, "media", "webview.js");
        const webviewJsTag = fs.existsSync(webviewJsPath)
            ? `<script nonce="${nonce}" src="${scriptUri}"></script>`
            : `<!-- media/webview.js not bundled, using inline fallback UI -->`;
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${PANEL_TITLE}</title>
  <link rel="stylesheet" href="${styleUri}" />
  <style>
    /* Fallback styles — overridden when media/webview.css loads */
    :root {
      --bg:       #0f1117;
      --surface:  #1a1d27;
      --border:   #2e3147;
      --accent:   #7c6af7;
      --text:     #e2e4f0;
      --muted:    #6b7280;
      --success:  #34d399;
      --error:    #f87171;
      --mono:     "JetBrains Mono", "Fira Code", ui-monospace, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 13px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #toolbar button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #toolbar button:hover { opacity: 0.85; }
    #status {
      font-size: 11px;
      color: var(--muted);
      margin-left: auto;
    }
    #step-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #step-bar input[type=range] { flex: 1; accent-color: var(--accent); }
    #step-label { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 80px; }
    #main {
      display: grid;
      grid-template-columns: 1fr 2fr;
      grid-template-rows: 1fr;
      gap: 1px;
      background: var(--border);
      flex: 1;
      overflow: hidden;
    }
    .pane {
      background: var(--bg);
      overflow: auto;
      padding: 10px 12px;
    }
    .pane-title {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }
    #pane-source { grid-column: 1; grid-row: 1; }
    pre#source-code {
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre;
      counter-reset: lines;
    }
    .frame { margin-bottom: 10px; }
    .frame-header {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--accent);
      font-weight: 600;
      margin-bottom: 4px;
    }
    .local-row {
      display: grid;
      grid-template-columns: 120px 80px 1fr;
      gap: 4px;
      font-family: var(--mono);
      font-size: 11px;
      padding: 2px 0;
      border-bottom: 1px solid var(--border);
    }
    .local-name  { color: var(--text); font-weight: 600; }
    .local-type  { color: var(--muted); font-size: 10px; }
    .local-value { color: var(--success); word-break: break-all; }

    /* Local variable block (replaces flat row for complex values) */
    .local-block { margin-bottom: 8px; }
    .local-header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3px; }
    .local-value-wrap { padding-left: 4px; }

    /* Array rendering */
    .arr-wrap { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
    .arr-cell {
      display: flex; flex-direction: column; align-items: center;
      border: 1px solid var(--border); border-radius: 3px;
      background: var(--surface); min-width: 32px;
    }
    .arr-idx { font-size: 9px; color: var(--muted); padding: 1px 4px; border-bottom: 1px solid var(--border); width: 100%; text-align: center; }
    .arr-val { font-family: var(--mono); font-size: 11px; padding: 3px 6px; color: var(--success); }

    /* Uninitialized / garbage values */
    .val-uninit {
      font-family: var(--mono); font-size: 11px;
      color: #888; background: repeating-linear-gradient(
        45deg, rgba(255,255,255,0.03), rgba(255,255,255,0.03) 2px,
        transparent 2px, transparent 6px
      );
      padding: 1px 5px; border-radius: 2px; border: 1px dashed #555;
      cursor: help;
    }

    /* Value types */
    .val-prim   { font-family: var(--mono); font-size: 11px; color: var(--success); }
    .val-string { font-family: var(--mono); font-size: 11px; color: #f6c90e; }
    .val-null   { font-family: var(--mono); font-size: 11px; color: var(--error); font-weight: 600; }
    .val-ptr    { font-family: var(--mono); font-size: 11px; color: var(--accent); }
    .val-muted  { font-family: var(--mono); font-size: 11px; color: var(--muted); }

    /* Heap reference badge — replaces inline node data for heap pointers in locals */
    .val-heap-ref {
      font-family: var(--mono); font-size: 10px;
      color: var(--accent);
      background: rgba(124,106,247,0.15);
      border: 1px solid rgba(124,106,247,0.45);
      border-radius: 3px; padding: 1px 6px;
      cursor: pointer; user-select: none;
    }
    .val-heap-ref::before { content: "heap "; color: var(--muted); font-size: 9px; }
    .val-heap-ref:hover { background: rgba(124,106,247,0.3); }

    /* Struct rendering */
    .struct-wrap { display: flex; flex-direction: column; gap: 2px; border-left: 2px solid var(--border); padding-left: 8px; }
    .struct-row  { display: flex; gap: 6px; font-family: var(--mono); font-size: 11px; }
    .struct-field { color: var(--muted); min-width: 60px; }
    .struct-val   { color: var(--success); }

    /* Linked list rendering */
    .ll-wrap  { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 2px; }
    .ll-node  {
      border: 1px solid var(--accent); border-radius: 4px;
      background: rgba(124,106,247,0.08); padding: 4px 8px;
      font-family: var(--mono); font-size: 11px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .ll-field { display: flex; gap: 6px; }
    .ll-arrow { color: var(--accent); font-size: 14px; font-weight: bold; align-self: center; }

    /* Heap typed value */
    .heap-typed { padding: 4px 0; }
    .heap-block {
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--surface);
    }
    .heap-header { font-family: var(--mono); font-size: 11px; color: var(--accent); margin-bottom: 4px; }
    /* Heap block type label */
    .hb-type {
      font-family: var(--mono); font-size: 10px; font-weight: 700;
      color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em;
      padding: 4px 8px; border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
    }
    /* Field rows inside a heap struct block */
    .hb-fields { display: flex; flex-direction: column; }
    .hb-row {
      display: flex; align-items: center;
      padding: 4px 8px; gap: 10px;
      border-bottom: 1px solid var(--border);
      font-family: var(--mono); font-size: 11px;
    }
    .hb-row:last-child { border-bottom: none; }
    .hb-field { color: var(--muted); min-width: 60px; flex-shrink: 0; }
    .hb-val   { color: var(--success); }
    .hex-cell.nonzero { background: rgba(124,106,247,0.25); color: var(--accent); }
    #error-banner {
      display: none;
      background: rgba(248,113,113,0.12);
      border: 1px solid var(--error);
      color: var(--error);
      padding: 8px 12px;
      font-size: 12px;
      font-family: var(--mono);
      white-space: pre-wrap;
      flex-shrink: 0;
    }
    #error-banner.visible { display: block; }
    #source-code { padding: 0; margin: 0; overflow: auto; height: 100%; }
    .source-line { display: flex; font-family: monospace; font-size: 12px; line-height: 1.6; padding: 0 8px; }
    .source-line:hover { background: rgba(255,255,255,0.05); }
    .active-line { background: rgba(255,215,0,0.18) !important; border-left: 3px solid #ffd700; }
    /* PT-style dual highlights */
    .line-prev { background: rgba(144,238,144,0.12) !important; border-left: 3px solid #4caf50; }
    .line-next { background: rgba(255,80,80,0.15)   !important; border-left: 3px solid #f44336; }
    .line-arrow { width: 14px; flex-shrink: 0; font-size: 9px; display: flex; align-items: center; }
    .line-num { color: var(--muted); min-width: 36px; user-select: none; text-align: right; padding-right: 12px; }
    .line-text { white-space: pre; flex: 1; }

    #output-box {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 6px 8px;
      white-space: pre-wrap;
      word-break: break-all;
      min-height: 52px;
      max-height: 120px;
      overflow-y: auto;
      flex-shrink: 0;
      margin-bottom: 8px;
    }
    #output-box:empty::before {
      content: "(no output yet)";
      color: var(--muted);
    }
    /* Stack+heap sub-layout inside the right two columns */
    #right-panes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: auto 1fr;
      gap: 1px;
      background: var(--border);
      overflow: hidden;
    }
    #print-output-pane {
      grid-column: 1 / 3;
      grid-row: 1;
      background: var(--bg);
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #pane-stack-inner { grid-column: 1; grid-row: 2; background: var(--bg); overflow: auto; padding: 10px 12px; }
    #pane-heap-inner  { grid-column: 2; grid-row: 2; background: var(--bg); overflow: auto; padding: 10px 12px; }
  </style>
</head>
<body>

  <div id="toolbar">
    <button id="btn-rerun">↺ Re-run</button>
    <button id="btn-prev">◀ Prev</button>
    <button id="btn-next">Next ▶</button>
    <span id="status">Initialising…</span>
  </div>

  <div id="step-bar">
    <input type="range" id="step-slider" min="0" max="0" value="0" />
    <span id="step-label">Step 0 / 0</span>
  </div>

  <div id="error-banner" role="alert"></div>

  <!-- Fixed SVG arrow overlay — sits above everything, pointer-events:none -->
  <svg id="arrow-overlay" xmlns="http://www.w3.org/2000/svg"
       style="position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999;overflow:visible">
    <defs>
      <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="#7c6af7" opacity="0.85"/>
      </marker>
    </defs>
  </svg>

  <div id="main">
    <!-- Left column: source code -->
    <div class="pane" id="pane-source">
      <div class="pane-title">Source</div>
      <pre id="source-code"><span style="color:var(--muted)">Waiting for trace…</span></pre>
    </div>

    <!-- Right two columns: print output on top, then stack | heap below -->
    <div id="right-panes">
      <!-- Print output — spans both right columns -->
      <div id="print-output-pane">
        <div class="pane-title">Print Output</div>
        <div id="output-box"></div>
      </div>

      <!-- Stack (middle column) -->
      <div id="pane-stack-inner">
        <div class="pane-title">Call Stack &amp; Locals</div>
        <div id="stack-content"></div>
      </div>

      <!-- Heap (right column) -->
      <div id="pane-heap-inner">
        <div class="pane-title">Heap Allocations</div>
        <div id="heap-content"></div>
      </div>
    </div>
  </div>

  <!-- Inline bootstrap + fallback UI logic (nonce-gated) -->
  <script nonce="${nonce}">
  (function () {
    "use strict";

    // ── VS Code Webview API bridge ────────────────────────────────────────
    const vscode = acquireVsCodeApi();

    // ── State ─────────────────────────────────────────────────────────────
    let trace       = null;   // TraceFile
    let currentStep = 0;
    let sourceLines = [];     // string[] for the active file

    // ── DOM refs ──────────────────────────────────────────────────────────
    const statusEl  = document.getElementById("status");
    const slider    = document.getElementById("step-slider");
    const stepLabel = document.getElementById("step-label");
    const sourceEl  = document.getElementById("source-code");
    const stackEl   = document.getElementById("stack-content");
    const heapEl    = document.getElementById("heap-content");
    const outputEl  = document.getElementById("output-box");
    const errBanner = document.getElementById("error-banner");
    const btnRerun  = document.getElementById("btn-rerun");
    const btnPrev   = document.getElementById("btn-prev");
    const btnNext   = document.getElementById("btn-next");

    // ── Host → Webview messages ───────────────────────────────────────────
    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.command) {
        case "LOAD_TRACE":
          loadTrace(msg.data, msg.source, msg.filename);
          break;
        case "ERROR":
          showError(msg.message);
          break;
        case "STATUS":
          setStatus(msg.text);
          break;
        case "MEMORY_REGION":
          // Future: overlay a hex-diff panel
          break;
      }
    });

    // ── Webview → Host helpers ────────────────────────────────────────────
    function post(msg) { vscode.postMessage(msg); }

    // ── Toolbar bindings ──────────────────────────────────────────────────
    btnRerun.addEventListener("click", () => post({ command: "RERUN" }));
    btnPrev.addEventListener("click",  () => goToStep(currentStep - 1));
    btnNext.addEventListener("click",  () => goToStep(currentStep + 1));
    slider.addEventListener("input",   () => goToStep(Number(slider.value)));

    // Keyboard arrow navigation
    document.addEventListener("keydown", (e) => {
      if (!trace) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown")  goToStep(currentStep + 1);
      if (e.key === "ArrowLeft"  || e.key === "ArrowUp")    goToStep(currentStep - 1);
    });

    // ── Core render functions ─────────────────────────────────────────────

    function loadTrace(data, source, filename) {
      trace = data;
      currentStep = 0;
      sourceLines = source ? source.split("\\n") : [];

      const total = (trace.timeline || []).length;
      slider.max   = Math.max(0, total - 1);
      slider.value = 0;
      setStatus(\`Loaded \${total} steps — \${filename || ""}\`);
      hideError();
      renderStep(0);
    }

    function goToStep(n) {
      if (!trace) return;
      const total = trace.timeline.length;
      n = Math.max(0, Math.min(total - 1, n));
      currentStep = n;
      slider.value = n;
      renderStep(n);
      post({ command: "JUMP_TO_STEP", step: n });
    }

    function renderStep(n) {
      if (!trace || !trace.timeline[n]) return;
      const step     = trace.timeline[n];
      const nextStep = trace.timeline[n + 1];
      const total    = trace.timeline.length;

      stepLabel.textContent = \`Step \${n + 1} / \${total}  ·  \${step.event || ""}\`;
      if (step.file) {
        const short = step.file.split("/").pop();
        setStatus(\`\${short}:\${step.line}  (step \${n + 1}/\${total})\`);
      }

      const justLine = step.line || 0;
      const nextLine = nextStep ? (nextStep.line || 0) : 0;
      renderSource(justLine, nextLine);
      renderStack(step.stack || []);
      renderHeap(step.heap  || []);
      // Use nullish coalescing so an empty string "" (no output yet at this
      // step) is passed through as-is rather than falling back to a stale
      // top-level trace.stdout that doesn't exist in the JSON schema.
      renderOutput(step.stdout ?? trace.stdout ?? "");
      requestAnimationFrame(drawArrows);
    }

    function renderSource(justLine, nextLine) {
      if (!sourceLines.length) {
        sourceEl.innerHTML = "<span style='color:var(--muted)'>No source available.</span>";
        return;
      }
      sourceEl.innerHTML = sourceLines.map((line, i) => {
        const ln     = i + 1;
        const isJust = ln === justLine;
        const isNext = ln === nextLine && nextLine !== justLine;
        const cls    = isJust ? " line-prev" : isNext ? " line-next" : "";
        const arrow  = isJust
          ? \`<span class="line-arrow" style="color:#4caf50">▶</span>\`
          : isNext
            ? \`<span class="line-arrow" style="color:#f44336">▶</span>\`
            : \`<span class="line-arrow"></span>\`;
        return \`<div class="source-line\${cls}">\${arrow}<span class="line-num">\${ln}</span><span class="line-text">\${esc(line) || " "}</span></div>\`;
      }).join("");
      const focus = sourceEl.querySelector(".line-prev") || sourceEl.querySelector(".line-next");
      if (focus) focus.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    function renderOutput(text) {
      if (!outputEl) return;
      // Use explicit null/undefined check — an empty string "" is valid
      // (program printed nothing yet) and should not fall through to a
      // stale fallback.  Only skip rendering when the value is genuinely absent.
      if (text == null) {
        outputEl.textContent = "";
        return;
      }
      outputEl.textContent = text;
      // Auto-scroll to bottom so latest output is visible
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    // ── Arrow state — must be declared before renderStack uses it ─────────
    let _ptrLinks = [];
    const _memContainer = document.getElementById("pane-heap-inner") || document.getElementById("pane-stack-inner");

    function drawArrows() {
      const svg = document.getElementById("arrow-overlay");
      if (!svg) return;
      while (svg.children.length > 1) svg.removeChild(svg.lastChild);
      // Use viewport-relative coords since SVG is position:fixed
      for (const { fromId, toAddr } of _ptrLinks) {
        const fromEl = document.getElementById(fromId);
        const toEl   = document.getElementById(\`heap-\${toAddr}\`);
        if (!fromEl || !toEl) continue;
        const fr = fromEl.getBoundingClientRect();
        const tr = toEl.getBoundingClientRect();
        const x1 = fr.right;
        const y1 = (fr.top + fr.bottom) / 2;
        const x2 = tr.left;
        const y2 = (tr.top  + tr.bottom) / 2;
        const cp = Math.max(30, Math.abs(x2 - x1) * 0.45);
        const d  = \`M\${x1},\${y1} C\${x1+cp},\${y1} \${x2-cp},\${y2} \${x2},\${y2}\`;
        const p  = document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d", d); p.setAttribute("fill","none");
        p.setAttribute("stroke","#7c6af7"); p.setAttribute("stroke-width","1.5");
        p.setAttribute("stroke-opacity","0.85");
        p.setAttribute("marker-end","url(#arrowhead)");
        svg.appendChild(p);
      }
    }
    window.addEventListener("resize", drawArrows);
    window.addEventListener("scroll", drawArrows, true);

    function renderStack(frames) {
      _ptrLinks = [];
      if (!frames.length) { stackEl.innerHTML = "<span style='color:var(--muted)'>No frames</span>"; return; }
      stackEl.innerHTML = frames.map(frame => {
        const localsHtml = (frame.locals || []).map(loc => {
          const fromId   = \`ptr-\${esc(String(frame.depth))}-\${esc(loc.name)}\`;
          const heapAddr = resolveHeapAddr(loc.value);
          if (heapAddr) _ptrLinks.push({ fromId, toAddr: heapAddr });
          const valHtml  = heapAddr
            ? \`<span id="\${fromId}" style="display:inline-flex;align-items:center;line-height:1"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent)"></span></span>\`
            : \`<div id="\${fromId}">\${renderValue(loc.value)}</div>\`;
          return \`<div class="local-block">
            <div class="local-header">
              <span class="local-name">\${esc(loc.name)}</span>
              <span class="local-type">\${esc(loc.type)}</span>
            </div>
            <div class="local-value-wrap">\${valHtml}</div>
          </div>\`;
        }).join("");
        return \`<div class="frame">
          <div class="frame-header">#\${frame.depth} \${esc(frame.function || "?")}  <span style="color:var(--muted)">\${esc(frame.file || "")}:\${frame.line || ""}</span></div>
          \${localsHtml || "<span style='color:var(--muted);font-size:11px'>no locals</span>"}
        </div>\`;
      }).join("");
    }

    function resolveHeapAddr(v) {
      if (!v || typeof v !== "object") return null;
      if (v.kind === "pointer"  && v.address && v.value !== "NULL" && v.address !== "0x0") return v.address;
      if (v.kind === "heap_ref" && v.address) return v.address;
      if (!v.kind && v.address  && v.address !== "0x0" && v.value !== "NULL") return v.address;
      return null;
    }

    function renderHeap(blocks) {
      // Only show blocks that have a typed value (a resolved struct/value from malloc).
      // Hex bytes, phantom blocks, and unresolved allocations are hidden — they're
      // noise. The heap panel should only show what the user explicitly malloc'd.
      const rendered = blocks.map(block => {
        if (!block.typed_value) return "";   // unresolved — skip
        const html = renderTypedHeapBlock(block.typed_value);
        if (!html) return "";                // noise — skip
        return \`<div class="heap-block" id="heap-\${esc(block.address)}">\${html}</div>\`;
      }).filter(Boolean).join("");

      heapEl.innerHTML = rendered ||
        "<span style='color:var(--muted);font-size:11px'>No heap allocations yet</span>";
    }

    // Render the contents of a heap block as a clean struct/value card.
    // Returns empty string for blocks that are just noise.
    function renderTypedHeapBlock(tv) {
      if (!tv || typeof tv !== "object") return "";

      // Struct: render as a labelled table of field → value rows (Python Tutor style)
      if (tv.kind === "struct") {
        const fields = tv.fields || {};
        const rows = Object.entries(fields).map(([name, val]) => {
          if (val && val.kind === "error" && isMemoryNoise(val.value)) return "";
          const valHtml = renderValue(val);
          if (!valHtml) return "";
          return \`<div class="hb-row">
            <span class="hb-field">\${esc(name)}</span>
            <span class="hb-val">\${valHtml}</span>
          </div>\`;
        }).filter(Boolean).join("");
        if (!rows) return "";
        const label = tv.type ? \`<div class="hb-type">\${esc(tv.type)}</div>\` : "";
        return \`\${label}<div class="hb-fields">\${rows}</div>\`;
      }

      // Primitive / pointer / other — just render the value
      const html = renderValue(tv);
      if (!html || html === \`<span class="val-muted">?</span>\`) return "";
      return \`<div class="hb-row"><span class="hb-val">\${html}</span></div>\`;
    }

    // ── Rich value renderer ────────────────────────────────────────────────
    // Renders the new tracer format (objects with a "kind" field).
    // Falls back gracefully for old-format values.

    // Returns true if a string looks like a raw memory error / address noise
    // that we want to hide from the user ("Cannot access memory at 0x...", etc.)
    function isMemoryNoise(s) {
      if (typeof s !== "string") return false;
      return /cannot access memory/i.test(s) || /^0x[0-9a-f]+$/i.test(s.trim());
    }

    function renderValue(v) {
      if (v === null || v === undefined) return \`<span class="val-null">—</span>\`;
      // Old format fallback (plain string/number)
      if (typeof v !== "object") return \`<span class="val-prim">\${esc(String(v))}</span>\`;

      switch (v.kind) {
        case "primitive": {
          if (v.uninit) return \`<span class="val-uninit" title="Uninitialized / garbage">?</span>\`;
          if (v.value === "NULL") return \`<span class="val-null">NULL</span>\`;
          return \`<span class="val-prim">\${esc(String(v.value))}</span>\`;
        }
        case "string":
          return \`<span class="val-string">\${esc(v.value)}</span>\`;
        case "pointer":
          if (v.value === "NULL") return \`<span class="val-null">NULL</span>\`;
          // Pointer dot — clicking scrolls to the target heap block if one exists
          if (v.points_to)        return \`<span class="val-ptr">→</span> \${renderValue(v.points_to)}\`;
          return \`<span class="ptr-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);vertical-align:middle"></span>\`;
        case "array":
          return renderArray(v);
        case "struct":
          return renderStruct(v);
        case "linked_list":
          return renderLinkedList(v);
        case "heap_ref": {
          // Show as a clickable dot that jumps to the heap block — no address text
          const a = esc(v.address || "");
          return \`<span class="ptr-dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);vertical-align:middle;cursor:pointer"
            onclick="(function(){var el=document.getElementById('heap-\${a}');if(el){el.scrollIntoView({behavior:'smooth',block:'nearest'});el.animate([{outline:'2px solid var(--accent)'},{outline:'2px solid transparent'}],{duration:800});}})()"
            title="Points to heap allocation"></span>\`;
        }
        case "truncated":
          return \`<span class="val-muted">(…)</span>\`;
        case "error": {
          // Suppress raw "Cannot access memory at 0x..." noise entirely
          if (isMemoryNoise(v.value)) return \`<span class="val-muted">?</span>\`;
          return \`<span class="val-muted">&lt;\${esc(v.value)}&gt;</span>\`;
        }
        case "cycle":
          return \`<span class="val-muted">↩ cycle</span>\`;
        default:
          // Old format: {value, points_to} objects
          if (v.value === "NULL")  return \`<span class="val-null">NULL</span>\`;
          if (v.points_to != null) return \`<span class="val-ptr">→</span> \${renderValue(v.points_to)}\`;
          if (Array.isArray(v.value)) return renderArray({ kind:"array", elements: v.value, length: v.value.length });
          return \`<span class="val-prim">\${esc(String(v.value ?? "?"))}</span>\`;
      }
    }

    function renderArray(v) {
      const els = v.elements || v.value || [];
      const cells = els.map((el, i) => {
        const isUninit = el && el.uninit;
        const cellVal  = isUninit
          ? \`<span class="val-uninit" title="Uninitialized">?</span>\`
          : renderValue(el);
        return \`<div class="arr-cell">
          <div class="arr-idx">\${i}</div>
          <div class="arr-val">\${cellVal}</div>
        </div>\`;
      }).join("");
      return \`<div class="arr-wrap">\${cells}</div>\`;
    }

    function renderStruct(v) {
      const fields = v.fields || {};
      const rows = Object.entries(fields).map(([name, val]) => {
        // Skip fields that are pure memory noise
        if (val && val.kind === "error" && isMemoryNoise(val.value)) return "";
        return \`<div class="struct-row">
          <span class="struct-field">\${esc(name)}</span>
          <span class="struct-val">\${renderValue(val)}</span>
        </div>\`;
      }).join("");
      return \`<div class="struct-wrap">\${rows || "<span class='val-muted'>empty</span>"}</div>\`;
    }

    function renderLinkedList(v) {
      const nodes = v.nodes || [];
      if (!nodes.length) return \`<span class="val-null">NULL</span>\`;
      const nodeHtml = nodes.map((node, i) => {
        if (node.kind === "cycle") return \`<span class="val-muted">↩ cycle</span>\`;
        if (node.kind === "error") {
          if (isMemoryNoise(node.value)) return "";
          return \`<span class="val-muted">error: \${esc(node.value)}</span>\`;
        }
        const fields = node.fields || {};
        const rows = Object.entries(fields).map(([name, fval]) => {
          // Skip the next-pointer field (shown as the arrow between nodes)
          const isNextPtr = fval && fval.kind === "pointer" && (fval.value === "->" || fval.value === "NULL");
          if (isNextPtr) return "";
          // Skip memory noise fields
          if (fval && fval.kind === "error" && isMemoryNoise(fval.value)) return "";
          return \`<div class="ll-field"><span class="struct-field">\${esc(name)}</span> <span class="struct-val">\${renderValue(fval)}</span></div>\`;
        }).join("");
        const arrow = i < nodes.length - 1 ? \`<span class="ll-arrow">→</span>\` : "";
        return \`<div class="ll-node">\${rows || "<span class='val-muted'>·</span>"}</div>\${arrow}\`;
      }).join("");
      // Check if last node has a null next ptr — show terminator
      const last = nodes[nodes.length - 1];
      const hasNull = last && last.fields && Object.values(last.fields).some(
        f => f && f.kind === "pointer" && f.value === "NULL"
      );
      return \`<div class="ll-wrap">\${nodeHtml}\${hasNull ? \`<span class="ll-arrow">→</span><span class="val-null">NULL</span>\` : ""}</div>\`;
    }

    // ── Utility ───────────────────────────────────────────────────────────

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function setStatus(text) { statusEl.textContent = text; }
    function showError(msg)  { errBanner.textContent = msg; errBanner.classList.add("visible"); }
    function hideError()     { errBanner.classList.remove("visible"); }

    // ── Signal readiness ──────────────────────────────────────────────────
    post({ command: "READY" });
  })();
  </script>

  ${webviewJsTag}
</body>
</html>`;
    }
}
exports.VisualizerPanel = VisualizerPanel;
// ── Module-level output channel ────────────────────────────────────────────
const _outputChannel = vscode.window.createOutputChannel("C Visualizer");
// ── Utilities ──────────────────────────────────────────────────────────────
function _generateNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
//# sourceMappingURL=VisualizerPanel.js.map