import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { StepData } from "./types/stepTypes";

export type StepDirection = "forward" | "backward";
export type OnStepRequestCallback = (direction: StepDirection) => void;
export type OnDisposeCallback = () => void;

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
export class WebviewProvider {
  private _panel: vscode.WebviewPanel | null = null;
  private _onStepRequest: OnStepRequestCallback | null = null;
  private _onDispose: OnDisposeCallback | null = null;
  private _onResetRequest: (() => void) | null = null;

  set onResetRequest(cb: () => void) { 
    this._onResetRequest = cb; 
  }

  /** Set the callback invoked when the webview requests a step navigation. */
  set onStepRequest(cb: OnStepRequestCallback) {
    this._onStepRequest = cb;
  }

  /** Set the callback invoked when the webview panel is closed. */
  set onDidDisposeCallback(cb: OnDisposeCallback) {
    this._onDispose = cb;
  }

  /**
   * Create and show the WebviewPanel.
   * If a panel is already open, reveal it instead of creating a new one.
   *
   * @param context  The extension context (used to resolve asset URIs).
   */
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
        retainContextWhenHidden: true,
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
      } else if (m["type"] === "requestReset") {
        this._onResetRequest?.();
      }
    });

    this._panel.onDidDispose(() => {
      this._panel = null;
      this._onDispose?.();
    });
  }

    this._panel.onDidDispose(() => {
      this._panel = null;
      this._onDispose?.();
    });
  }

  /** Send a validated step object to the webview. */
  postStep(stepData: StepData): void {
    this._post({ type: "step", payload: stepData });
  }

  /** Send an error message to the webview (shown as an error banner). */
  postError(msg: string): void {
    this._post({ type: "error", message: msg });
  }

  /** Notify the webview that GDB has finished and this is the final state. */
  postFinished(finalStep: StepData | null): void {
    this._post({ type: "finished", payload: finalStep });
  }

  /** Tell the webview to clear its current display. */
  postReset(): void {
    this._post({ type: "reset" });
  }

  /** Dispose the panel programmatically (e.g., on c-stack-viz.stop). */
  dispose(): void {
    this._panel?.dispose();
    this._panel = null;
  }

  /** True if the panel is currently open. */
  get isOpen(): boolean {
    return this._panel !== null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _post(message: object): void {
    if (!this._panel) {
      return;
    }
    this._panel.webview.postMessage(message);
  }

  /**
   * Read webview/dist/index.html and replace relative asset paths with
   * VS Code WebviewPanel URIs so the browser can load them.
   */
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
      // Fallback placeholder if the webview hasn't been built yet.
      return this._fallbackHtml();
    }

    // Replace src="/assets/..." and href="/assets/..." with webview URIs.
    html = html.replace(
      /(src|href)="(\.[^"]+)"/g,
      (_match, attr: string, assetPath: string) => {
        const assetUri = this._panel!.webview.asWebviewUri(
          vscode.Uri.joinPath(distDir, assetPath)
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
