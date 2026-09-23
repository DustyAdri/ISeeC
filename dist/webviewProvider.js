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
class WebviewProvider {
    constructor() {
        this._panel = null;
        this._onStepRequest = null;
        this._onDispose = null;
        this._onResetRequest = null;
        this._onReady = null;
    }
    /**
     * Called whenever the webview (re)loads and is ready for messages. The
     * panel isn't kept alive while hidden (see show()), so this fires again
     * every time it's brought back, and the extension must re-send the step
     * on screen.
     */
    set onReady(cb) {
        this._onReady = cb;
    }
    set onResetRequest(cb) {
        this._onResetRequest = cb;
    }
    set onStepRequest(cb) {
        this._onStepRequest = cb;
    }
    set onDidDisposeCallback(cb) {
        this._onDispose = cb;
    }
    show(context) {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        this._panel = vscode.window.createWebviewPanel("c-stack-viz", "C Stack Visualizer", vscode.ViewColumn.Beside, {
            enableScripts: true,
            // Not retained: a hidden panel's page is unloaded to free its
            // memory, and rebuilt from the "ready" handshake when shown again.
            retainContextWhenHidden: false,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "webview", "dist"),
            ],
        });
        this._panel.webview.html = this._buildHtml(context);
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
            else if (m["type"] === "ready") {
                this._onReady?.();
            }
            else if (m["type"] === "requestReset") {
                this._onResetRequest?.();
            }
        });
        this._panel.onDidDispose(() => {
            this._panel = null;
            this._onDispose?.();
        });
    }
    postStep(stepData, totalSteps) {
        this._post({ type: "step", payload: stepData, totalSteps });
    }
    postError(msg) {
        this._post({ type: "error", message: msg });
    }
    postFinished(finalStep, totalSteps) {
        this._post({ type: "finished", payload: finalStep, totalSteps });
    }
    postReset() {
        this._post({ type: "reset" });
    }
    postPreloadProgress(stepsTraced) {
        this._post({ type: "preloadProgress", stepsTraced });
    }
    dispose() {
        this._panel?.dispose();
        this._panel = null;
    }
    get isOpen() {
        return this._panel !== null;
    }
    _post(message) {
        if (!this._panel) {
            return;
        }
        this._panel.webview.postMessage(message);
    }
    _buildHtml(context) {
        const distDir = vscode.Uri.joinPath(context.extensionUri, "webview", "dist");
        const indexPath = path.join(distDir.fsPath, "index.html");
        let html;
        try {
            html = fs.readFileSync(indexPath, "utf-8");
        }
        catch {
            return this._fallbackHtml();
        }
        html = html.replace(/(src|href)="(?!https?:|data:|vscode-webview:)([^"]+)"/g, (_match, attr, assetPath) => {
            const relativePath = assetPath.replace(/^\.?\//, "");
            const assetUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, relativePath));
            return `${attr}="${assetUri}"`;
        });
        return html;
    }
    _fallbackHtml() {
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
}
exports.WebviewProvider = WebviewProvider;
