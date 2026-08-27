/**
 * extension.ts — VS Code extension host entry point
 * Registers the `cVisualizer.start` command and delegates all logic
 * to VisualizerPanel so this file stays thin and testable.
 */
import * as vscode from "vscode";
export declare function activate(context: vscode.ExtensionContext): void;
export declare function deactivate(): void;
