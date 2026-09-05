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
exports.WebviewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * WebviewProvider owns the VS Code WebviewPanel.
 * It serves the built React app and bridges postMessage in both directions.
 *
 * Webview → Extension messages:
 *   { type: "requestStep", direction: "forward" | "backward" }
 *
 * Extension → Webview messages:
 *   { type: "step",     payload: StepData }
 *   { type: "error",    message: string }
 *   { type: "finished", payload: StepData | null }
 *   { type: "reset" }
 */
class WebviewProvider {
    constructor() {
        this._panel = null;
        this._onStepRequest = null;
        this._onDispose = null;
        this._onResetRequest = null;
    }
    set onResetRequest(cb) {
        this._onResetRequest = cb;
    }
    /** Set the callback invoked when the webview requests a step navigation. */
    set onStepRequest(cb) {
        this._onStepRequest = cb;
    }
    /** Set the callback invoked when the webview panel is closed. */
    set onDidDisposeCallback(cb) {
        this._onDispose = cb;
    }
    /**
     * Create and show the WebviewPanel.
     * If a panel is already open, reveal it instead of creating a new one.
     *
     * @param context  The extension context (used to resolve asset URIs).
     */
    show(context) {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        this._panel = vscode.window.createWebviewPanel("c-stack-viz", "C Stack Visualizer", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "webview", "dist"),
            ],
        });
        this._panel.webview.html = this._buildHtml(context);
        // Add property
        // In onDidReceiveMessage, replace the current guard:
        this._panel.webview.onDidReceiveMessage((msg) => {
            if (typeof msg !== "object" || msg === null)
                return;
            const m = msg;
            if (m["type"] === "requestStep") {
                const direction = m["direction"];
                if (direction === "forward" || direction === "backward") {
                    this._onStepRequest?.(direction);
                }
            }
            else if (m["type"] === "requestReset") {
                this._onResetRequest?.();
            }
        });
        const direction = msg["direction"];
        if (direction === "forward" || direction === "backward") {
            this._onStepRequest?.(direction);
        }
    }
    ;
}
exports.WebviewProvider = WebviewProvider;
this._panel.onDidDispose(() => {
    this._panel = null;
    this._onDispose?.();
});
/** Send a validated step object to the webview. */
postStep(stepData, stepTypes_1.StepData);
void {
    this: ._post({ type: "step", payload: stepData })
};
/** Send an error message to the webview (shown as an error banner). */
postError(msg, string);
void {
    this: ._post({ type: "error", message: msg })
};
/** Notify the webview that GDB has finished and this is the final state. */
postFinished(finalStep, stepTypes_1.StepData | null);
void {
    this: ._post({ type: "finished", payload: finalStep })
};
/** Tell the webview to clear its current display. */
postReset();
void {
    this: ._post({ type: "reset" })
};
/** Dispose the panel programmatically (e.g., on c-stack-viz.stop). */
dispose();
void {
    this: ._panel?.dispose(),
    this: ._panel = null
};
/** True if the panel is currently open. */
get;
isOpen();
boolean;
{
    return this._panel !== null;
}
_post(message, object);
void {
    : ._panel
};
{
    return;
}
this._panel.webview.postMessage(message);
_buildHtml(context, vscode.ExtensionContext);
string;
{
    const distDir = vscode.Uri.joinPath(context.extensionUri, "webview", "dist");
    const indexPath = path.join(distDir.fsPath, "index.html");
    let html;
    try {
        html = fs.readFileSync(indexPath, "utf-8");
    }
    catch {
        // Fallback placeholder if the webview hasn't been built yet.
        return this._fallbackHtml();
    }
    // Replace src="/assets/..." and href="/assets/..." with webview URIs.
    html = html.replace(/(src|href)="(\.[^"]+)"/g, (_match, attr, assetPath) => {
        const assetUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, assetPath));
        return `${attr}="${assetUri}"`;
    });
    return html;
}
_fallbackHtml();
string;
{
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>C Stack Visualizer</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; color: #ccc; background: #1e1e1e; }
    h2 { color: #f44; }
  </style>
</head>
<body>
  <h2>Webview not built</h2>
  <p>Run <code>cd webview && npm run build</code> to build the React app first.</p>
</body>
</html>`;
}
