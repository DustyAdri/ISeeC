import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { StepData } from "./types/stepTypes";

export type StepDirection = "forward" | "backward";
export type OnStepRequestCallback = (direction: StepDirection) => void;
export type OnDisposeCallback = () => void;

export class WebviewProvider {
  private _panel: vscode.WebviewPanel | null = null;
  private _onStepRequest: OnStepRequestCallback | null = null;
  private _onDispose: OnDisposeCallback | null = null;
  private _onResetRequest: (() => void) | null = null;
  private _onReady: (() => void) | null = null;

  /**
   * Called whenever the webview (re)loads and is ready for messages. The
   * panel isn't kept alive while hidden (see show()), so this fires again
   * every time it's brought back, and the extension must re-send the step
   * on screen.
   */
  set onReady(cb: () => void) {
    this._onReady = cb;
  }

  set onResetRequest(cb: () => void) {
    this._onResetRequest = cb;
  }

  set onStepRequest(cb: OnStepRequestCallback) {
    this._onStepRequest = cb;
  }

  set onDidDisposeCallback(cb: OnDisposeCallback) {
    this._onDispose = cb;
  }

  show(context: vscode.ExtensionContext): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      "c-stack-viz",
      "C Stack Visualizer",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Not retained: a hidden panel's page is unloaded to free its
        // memory, and rebuilt from the "ready" handshake when shown again.
        retainContextWhenHidden: false,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview", "dist"),
        ],
      }
    );

    this._panel.webview.html = this._buildHtml(context);

    this._panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;

      if (m["type"] === "requestStep") {
        const direction = m["direction"];
        if (direction === "forward" || direction === "backward") {
          this._onStepRequest?.(direction);
        }
      } else if (m["type"] === "ready") {
        this._onReady?.();
      } else if (m["type"] === "requestReset") {
        this._onResetRequest?.();
      }
    });

    this._panel.onDidDispose(() => {
      this._panel = null;
      this._onDispose?.();
    });
  }

  postStep(stepData: StepData, totalSteps: number): void {
    this._post({ type: "step", payload: stepData, totalSteps });
  }

  postError(msg: string): void {
    this._post({ type: "error", message: msg });
  }

  postFinished(finalStep: StepData | null, totalSteps: number): void {
    this._post({ type: "finished", payload: finalStep, totalSteps });
  }

  postReset(): void {
    this._post({ type: "reset" });
  }

  postPreloadProgress(stepsTraced: number): void {
    this._post({ type: "preloadProgress", stepsTraced });
  }

  dispose(): void {
    this._panel?.dispose();
    this._panel = null;
  }

  get isOpen(): boolean {
    return this._panel !== null;
  }

  private _post(message: object): void {
    if (!this._panel) {
      return;
    }
    this._panel.webview.postMessage(message);
  }

  private _buildHtml(context: vscode.ExtensionContext): string {
    const distDir = vscode.Uri.joinPath(
      context.extensionUri,
      "webview",
      "dist"
    );
    const indexPath = path.join(distDir.fsPath, "index.html");

    let html: string;
    try {
      html = fs.readFileSync(indexPath, "utf-8");
    } catch {
      return this._fallbackHtml();
    }

    html = html.replace(
      /(src|href)="(?!https?:|data:|vscode-webview:)([^"]+)"/g,
      (_match, attr: string, assetPath: string) => {
        const relativePath = assetPath.replace(/^\.?\//, "");
        const assetUri = this._panel!.webview.asWebviewUri(
          vscode.Uri.joinPath(distDir, relativePath)
        );
        return `${attr}="${assetUri}"`;
      }
    );

    return html;
  }

  private _fallbackHtml(): string {
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