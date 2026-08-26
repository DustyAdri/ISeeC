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
import * as path from "path";
import * as fs from "fs";
import * as crypto from 'crypto';

import { execFile, spawn, ExecException } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

/** Structured result from running a shell command */
interface ShellResult {
  stdout: string;
  stderr: string;
}

/** Messages the Webview may send to the extension host */
type WebviewToHostMessage =
  | { command: "READY" }
  | { command: "RERUN" }
  | { command: "JUMP_TO_STEP"; step: number }
  | { command: "INSPECT_MEMORY"; address: string; byteCount: number }
  | { command: "LOG"; level: "info" | "warn" | "error"; text: string };

/** Messages the extension host sends to the Webview */
type HostToWebviewMessage =
  | { command: "LOAD_TRACE"; data: TraceFile; source: string; filename: string }
  | { command: "MEMORY_REGION"; address: string; bytes: number[] }
  | { command: "ERROR"; message: string }
  | { command: "STATUS"; text: string };

/** Minimal shape of the trace.json root object */
interface TraceFile {
  version: number;
  total_steps: number;
  timeline: unknown[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const VIEW_TYPE      = "cExecutionVisualizer";
const PANEL_TITLE    = "C Execution Visualizer";
/** tracer.py must live next to the extension or be bundled under /media */
const TRACER_SCRIPT  = "tracer.py";
const TRACE_OUTPUT   = "trace.json";
/** Milliseconds before we consider a GDB run hung */
const GDB_TIMEOUT_MS = 120_000;

// ── VisualizerPanel ────────────────────────────────────────────────────────

export class VisualizerPanel {
  // Singleton — only one panel at a time.
  private static _instance: VisualizerPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _currentFileUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _isRunning   = false;
  private _traceLoaded = false;
  private _lastTrace: { data: TraceFile; source: string; filename: string } | undefined;

  // ── Factory ──────────────────────────────────────────────────────────────

  static async createOrShow(
    context: vscode.ExtensionContext,
    fileUri: vscode.Uri
  ): Promise<void> {
    const column =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (VisualizerPanel._instance) {
      // Reuse existing panel but retarget to the new file.
      VisualizerPanel._instance._currentFileUri = fileUri;
      VisualizerPanel._instance._panel.reveal(column);
      await VisualizerPanel._instance._runTrace();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          // Allow the Webview to load assets from the extension's /media folder.
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      }
    );

    VisualizerPanel._instance = new VisualizerPanel(context, panel, fileUri);
  }

  static async rerun(context: vscode.ExtensionContext): Promise<void> {
    if (VisualizerPanel._instance) {
      await VisualizerPanel._instance._runTrace();
    }
  }

  static dispose(): void {
    VisualizerPanel._instance?.disposePanel();
    _outputChannel.dispose();
  }

  // ── Constructor ──────────────────────────────────────────────────────────

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    fileUri: vscode.Uri
  ) {
    this._context        = context;
    this._panel          = panel;
    this._currentFileUri = fileUri;

    // Set the initial HTML shell (spinner shown until trace arrives).
    this._panel.webview.html = this._buildWebviewHtml();

    // Listen for panel disposal (user closed the tab).
    this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);

    // Handle messages from the Webview.
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewToHostMessage) => this._handleWebviewMessage(msg),
      null,
      this._disposables
    );

    // Kick off the first trace immediately.
    this._runTrace();
  }

  // ── Public teardown ──────────────────────────────────────────────────────

  disposePanel(): void {
    VisualizerPanel._instance = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  // ── Core pipeline ────────────────────────────────────────────────────────

  /**
   * Full pipeline: compile → GDB trace → read JSON → post to Webview.
   * All errors surface as VS Code error notifications + Webview error banners.
   */
  private async _runTrace(): Promise<void> {
    if (this._isRunning) {
      this._postMessage({ command: "STATUS", text: "Trace already running…" });
      return;
    }
    this._isRunning = true;
    this._traceLoaded = false;
    try {
    const filePath   = this._currentFileUri.fsPath;
    const dir        = path.dirname(filePath);

    const ext       = process.platform === 'win32' ? '.exe' : '.out';
    const outDir    = this._context.globalStorageUri.fsPath;
    fs.mkdirSync(outDir, { recursive: true });
    const outBinary = path.join(outDir, `cvis_program${ext}`);
    const traceFile = path.join(outDir, `cvis_trace.json`);

    // Delete stale files so Windows doesn't lock the exe between runs.
    try { if (fs.existsSync(outBinary)) { fs.unlinkSync(outBinary); } } catch (_) {}
    try { if (fs.existsSync(traceFile)) { fs.unlinkSync(traceFile); } } catch (_) {}
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
    } catch (err) {
      const msg = `Compilation failed:\n${(err as Error).message}`;
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
    } catch (err) {
      const e = err as ExecException & { stdout?: string; stderr?: string };
      gdbOut.stdout = e.stdout ?? "";
      gdbOut.stderr = e.stderr ?? (err as Error).message;
    }
    _outputChannel.appendLine(`[GDB stdout]\n${gdbOut.stdout}`);
    _outputChannel.appendLine(`[GDB stderr]\n${gdbOut.stderr}`);

    // ── Step 3: Read trace.json ──────────────────────────────────────────
    _outputChannel.appendLine(`[cVisualizer] Checking for trace at: ${traceFile}`);
    _outputChannel.appendLine(`[cVisualizer] File exists: ${fs.existsSync(traceFile)}`);

    let traceData: TraceFile;
    try {
      traceData = this._readTrace(traceFile);
    } catch (err) {
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
    } catch (_) {}

    // Cache the trace so READY can replay it without re-running GDB.
    this._lastTrace  = { data: traceData, source: sourceText, filename: path.basename(filePath) };
    this._traceLoaded = true;

    this._postMessage({
      command: "LOAD_TRACE",
      data: traceData,
      source: sourceText,
      filename: path.basename(filePath),
    });
    } finally {
      this._isRunning = false;
    }
  }

  // ── Step implementations ─────────────────────────────────────────────────

  private async _compile(src: string, out: string): Promise<ShellResult> {
    const cfg    = vscode.workspace.getConfiguration("cVisualizer");
    const cc     = cfg.get<string>("compiler", "gcc");
    const flags  = cfg.get<string>("compilerFlags", "-g -O0 -Wall");

    const flagArgs = flags.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((flag) =>
      flag.replace(/^"|"$/g, "")
    ) ?? [];
    const args = [...flagArgs, src, "-o", out];

    _outputChannel.appendLine(`[gcc] spawn: ${cc} ${JSON.stringify(args)}`);

    try {
      const r = await execFileAsync(cc, args, { timeout: 30_000 });
      _outputChannel.appendLine(`[gcc] exit ok, checking: ${out}`);
      return r;
    } catch (err) {
      const e = err as ExecException & ShellResult;
      throw new Error(e.stderr || e.message);
    }
  }

  private async _runGdb(
    tracerPath: string,
    binary: string,
    cwd: string,
    traceFile: string
  ): Promise<ShellResult> {
    const cfg    = vscode.workspace.getConfiguration("cVisualizer");
    const gdbBin = cfg.get<string>("gdbPath", "gdb");

    // GDB (MinGW/MSYS2) requires forward slashes even on Windows.
    const tracerFwd = tracerPath.replace(/\\/g, '/');
    const binaryFwd = binary.replace(/\\/g, '/');
    const traceFwd  = traceFile.replace(/\\/g, '/');

    const env = {
      ...process.env,
      CVIS_TRACE_OUT: traceFwd,
      CVIS_MAX_STEPS: String(cfg.get<number>("maxSteps", 5000)),
    };

    _outputChannel.appendLine(`[GDB] tracer : ${tracerFwd}`);
    _outputChannel.appendLine(`[GDB] binary : ${binaryFwd}`);
    _outputChannel.appendLine(`[GDB] trace  : ${traceFwd}`);

    return new Promise<ShellResult>((resolve) => {
      const args = ["-batch", "--command", tracerFwd, binaryFwd];
      _outputChannel.appendLine(`[GDB] spawn  : ${gdbBin} ${JSON.stringify(args)}`);

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({ stdout, stderr });
      };
      const proc = spawn(gdbBin, args, { cwd, env });

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", (err: Error) => {
        stderr += `\nspawn error: ${err.message}`;
        finish();
      });
      proc.on("close", finish);

      timeoutHandle = setTimeout(() => {
        stderr += "\n[cVisualizer] GDB timed out after 120s -- the traced program is likely waiting on input (scanf) or stuck in an infinite loop";
        try { proc.kill(); } catch (_) {}
        finish();
      }, GDB_TIMEOUT_MS);
    });
  }

  private _readTrace(tracePath: string): TraceFile {
    if (!fs.existsSync(tracePath)) {
      throw new Error(`trace.json not found at ${tracePath}`);
    }
    const raw = fs.readFileSync(tracePath, "utf-8");
    try {
      return JSON.parse(raw) as TraceFile;
    } catch {
      throw new Error("trace.json exists but contains invalid JSON.");
    }
  }

  /**
   * Resolve tracer.py: look beside the active .c file first, then
   * fall back to the copy bundled with the extension under /media.
   */
  private _resolveTracerPath(cFileDir: string): string {
    const candidates = [
      path.join(cFileDir, TRACER_SCRIPT),
      path.join(this._context.extensionPath, "media", TRACER_SCRIPT),
      path.join(this._context.extensionPath, TRACER_SCRIPT),
    ];

    _outputChannel.appendLine(`[tracer] extensionPath = ${this._context.extensionPath}`);
    for (const p of candidates) {
      _outputChannel.appendLine(`[tracer] checking: ${p} → exists=${fs.existsSync(p)}`);
      if (fs.existsSync(p)) { return p; }
    }

    throw new Error(
      `tracer.py not found. Checked:\n${candidates.join("\n")}`
    );
  }

  // ── Messaging helpers ─────────────────────────────────────────────────────

  private _postMessage(msg: HostToWebviewMessage): void {
    this._panel.webview.postMessage(msg).then(undefined, (err) =>
      console.error("[cVisualizer] postMessage failed:", err)
    );
  }

  private _showError(message: string): void {
    vscode.window.showErrorMessage(`C Visualizer: ${message}`);
    this._postMessage({ command: "ERROR", message });
  }

  // ── Inbound message handler ───────────────────────────────────────────────

  private _handleWebviewMessage(msg: WebviewToHostMessage): void {
    switch (msg.command) {
      case "READY":
        if (this._traceLoaded && this._lastTrace) {
          // Webview just (re)loaded — push the cached trace, no GDB rerun needed.
          this._postMessage({
            command: "LOAD_TRACE",
            data: this._lastTrace.data,
            source: this._lastTrace.source,
            filename: this._lastTrace.filename,
          });
        } else if (!this._isRunning) {
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

  private _syncEditorToStep(step: number): void {
    void step;
  }

  private _stubReadMemory(_address: string, byteCount: number): number[] {
    return new Array<number>(byteCount).fill(0);
  }

  // ── HTML shell ───────────────────────────────────────────────────────────

  private _buildWebviewHtml(): string {
    const webview = this._panel.webview;

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "media", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "media", "webview.css")
    );

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
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
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
    #pane-source { grid-column: 1; grid-row: 1 / 3; }
    pre#source-code {
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre;
      counter-reset: lines;
    }
    #pane-stack { grid-column: 2; grid-row: 1; }
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
    #pane-heap { grid-column: 2; grid-row: 2; }
    .heap-block { margin-bottom: 10px; }
    .heap-header { font-family: var(--mono); font-size: 11px; color: var(--accent); margin-bottom: 4px; }
    .hex-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      font-family: var(--mono);
      font-size: 10px;
    }
    .hex-cell {
      width: 22px;
      text-align: center;
      padding: 1px 0;
      border-radius: 2px;
      background: var(--surface);
      color: var(--text);
    }
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
    .line-num { color: var(--muted); min-width: 36px; user-select: none; text-align: right; padding-right: 12px; }
    .line-text { white-space: pre; flex: 1; }
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

  <div id="main">
    <div class="pane" id="pane-source">
      <div class="pane-title">Source</div>
      <pre id="source-code"><span style="color:var(--muted)">Waiting for trace…</span></pre>
    </div>
    <div class="pane" id="pane-stack">
      <div class="pane-title">Call Stack &amp; Locals</div>
      <div id="stack-content"></div>
    </div>
    <div class="pane" id="pane-heap">
      <div class="pane-title">Heap Allocations</div>
      <div id="heap-content"></div>
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
      const step = trace.timeline[n];
      const total = trace.timeline.length;

      stepLabel.textContent = \`Step \${n + 1} / \${total}  ·  \${step.event || ""}\`;

      if (step.file) {
        const short = step.file.split("/").pop();
        setStatus(\`\${short}:\${step.line}  (step \${n + 1}/\${total})\`);
      }

      renderSource(step.line || 0);
      renderStack(step.stack || []);
      renderHeap(step.heap  || []);
    }

    function renderSource(currentLine) {
      if (!sourceLines.length) {
        sourceEl.innerHTML = "<span style='color:var(--muted)'>No source available.</span>";
        return;
      }
      const html = sourceLines.map((line, i) => {
        const lineNum = i + 1;
        const isActive = lineNum === currentLine;
        return \`<div class="source-line\${isActive ? " active-line" : ""}" id="src-\${lineNum}">\` +
               \`<span class="line-num">\${lineNum}</span>\` +
               \`<span class="line-text">\${esc(line) || " "}</span>\` +
               \`</div>\`;
      }).join("");
      sourceEl.innerHTML = html;
      const el = document.getElementById(\`src-\${currentLine}\`);
      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }

    function renderStack(frames) {
      if (!frames.length) { stackEl.innerHTML = "<span style='color:var(--muted)'>No frames</span>"; return; }
      stackEl.innerHTML = frames.map(frame => {
        const localsHtml = (frame.locals || []).map(loc => {
          return \`<div class="local-block">
            <div class="local-header">
              <span class="local-name">\${esc(loc.name)}</span>
              <span class="local-type">\${esc(loc.type)}</span>
            </div>
            <div class="local-value-wrap">\${renderValue(loc.value)}</div>
          </div>\`;
        }).join("");
        return \`<div class="frame">
          <div class="frame-header">#\${frame.depth} \${esc(frame.function || "?")}  <span style="color:var(--muted)">\${esc(frame.file || "")}:\${frame.line || ""}</span></div>
          \${localsHtml || "<span style='color:var(--muted);font-size:11px'>no locals</span>"}
        </div>\`;
      }).join("");
    }

    function renderHeap(blocks) {
      if (!blocks.length) { heapEl.innerHTML = "<span style='color:var(--muted)'>No heap allocations</span>"; return; }
      heapEl.innerHTML = blocks.map(block => {
        const truncated = block.truncated ? \` <span style="color:var(--muted)">(truncated)</span>\` : "";
        const header = \`<div class="heap-header">\${esc(block.address)} <span style="color:var(--muted)">\${block.size} bytes</span>\${truncated}</div>\`;
        // If tracer resolved a typed value (struct, linked list etc), show that
        if (block.typed_value) {
          return \`<div class="heap-block">\${header}<div class="heap-typed">\${renderValue(block.typed_value)}</div></div>\`;
        }
        // Otherwise fall back to hex bytes
        const hexCells = (block.bytes || []).slice(0, 128).map(b => {
          const hex = b.toString(16).padStart(2, "0");
          return \`<span class="hex-cell\${b !== 0 ? " nonzero" : ""}">\${hex}</span>\`;
        }).join("");
        return \`<div class="heap-block">\${header}<div class="hex-grid">\${hexCells}</div></div>\`;
      }).join("");
    }

    // ── Rich value renderer ────────────────────────────────────────────────
    // Renders the new tracer format (objects with a "kind" field).
    // Falls back gracefully for old-format values.

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
          if (v.points_to)        return \`<span class="val-ptr">→</span> \${renderValue(v.points_to)}\`;
          return \`<span class="val-ptr">\${esc(v.address || "?")}</span>\`;
        case "array":
          return renderArray(v);
        case "struct":
          return renderStruct(v);
        case "linked_list":
          return renderLinkedList(v);
        case "truncated":
          return \`<span class="val-muted">&lt;max depth&gt;</span>\`;
        case "error":
          return \`<span class="val-muted">&lt;\${esc(v.value)}&gt;</span>\`;
        case "cycle":
          return \`<span class="val-muted">↩ cycle @ \${esc(v.address)}</span>\`;
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
      const rows = Object.entries(fields).map(([name, val]) =>
        \`<div class="struct-row">
          <span class="struct-field">\${esc(name)}</span>
          <span class="struct-val">\${renderValue(val)}</span>
        </div>\`
      ).join("");
      return \`<div class="struct-wrap">\${rows || "<span class='val-muted'>empty</span>"}</div>\`;
    }

    function renderLinkedList(v) {
      const nodes = v.nodes || [];
      if (!nodes.length) return \`<span class="val-null">NULL</span>\`;
      const nodeHtml = nodes.map((node, i) => {
        if (node.kind === "cycle") return \`<span class="val-muted">↩ cycle</span>\`;
        if (node.kind === "error") return \`<span class="val-muted">error: \${esc(node.value)}</span>\`;
        const fields = node.fields || {};
        const rows = Object.entries(fields).map(([name, fval]) => {
          // Skip the next-pointer field in the node box (it's shown as the arrow)
          const isNextPtr = fval && fval.kind === "pointer" && (fval.value === "->" || fval.value === "NULL");
          if (isNextPtr) return "";
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

// ── Module-level output channel ────────────────────────────────────────────

const _outputChannel = vscode.window.createOutputChannel("C Visualizer");

// ── Utilities ──────────────────────────────────────────────────────────────

function _generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}
