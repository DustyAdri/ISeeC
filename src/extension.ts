/**
 * extension.ts — VS Code extension host entry point
 * Registers the `cVisualizer.start` command and delegates all logic
 * to VisualizerPanel so this file stays thin and testable.
 */

import * as vscode from "vscode";
import { VisualizerPanel } from "./VisualizerPanel";

export function activate(context: vscode.ExtensionContext): void {
  // ── Command: launch the visualizer for the active .c file ──────────────
  const startCmd = vscode.commands.registerCommand(
    "cVisualizer.start",
    async (uri?: vscode.Uri) => {
      // Resolve target file: prefer explicit URI (context-menu invocation),
      // then fall back to the currently active editor.
      const fileUri =
        uri ??
        (vscode.window.activeTextEditor?.document.languageId === "c"
          ? vscode.window.activeTextEditor.document.uri
          : undefined);

      if (!fileUri) {
        vscode.window.showErrorMessage(
          "C Visualizer: Open a .c file in the editor first."
        );
        return;
      }

      if (!fileUri.fsPath.endsWith(".c")) {
        vscode.window.showErrorMessage(
          "C Visualizer: The active file must be a C source file (.c)."
        );
        return;
      }

      await VisualizerPanel.createOrShow(context, fileUri);
    }
  );

  // ── Command: re-run trace for the same file (callable from Webview) ────
  const rerunCmd = vscode.commands.registerCommand(
    "cVisualizer.rerun",
    async () => {
      await VisualizerPanel.rerun(context);
    }
  );

  context.subscriptions.push(startCmd, rerunCmd);
}

export function deactivate(): void {
  VisualizerPanel.dispose();
}
