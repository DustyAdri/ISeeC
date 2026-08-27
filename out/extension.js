"use strict";
/**
 * extension.ts — VS Code extension host entry point
 * Registers the `cVisualizer.start` command and delegates all logic
 * to VisualizerPanel so this file stays thin and testable.
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const VisualizerPanel_1 = require("./VisualizerPanel");
function activate(context) {
    // ── Command: launch the visualizer for the active .c file ──────────────
    const startCmd = vscode.commands.registerCommand("cVisualizer.start", async (uri) => {
        // Resolve target file: prefer explicit URI (context-menu invocation),
        // then fall back to the currently active editor.
        const fileUri = uri ??
            (vscode.window.activeTextEditor?.document.languageId === "c"
                ? vscode.window.activeTextEditor.document.uri
                : undefined);
        if (!fileUri) {
            vscode.window.showErrorMessage("C Visualizer: Open a .c file in the editor first.");
            return;
        }
        if (!fileUri.fsPath.endsWith(".c")) {
            vscode.window.showErrorMessage("C Visualizer: The active file must be a C source file (.c).");
            return;
        }
        await VisualizerPanel_1.VisualizerPanel.createOrShow(context, fileUri);
    });
    // ── Command: re-run trace for the same file (callable from Webview) ────
    const rerunCmd = vscode.commands.registerCommand("cVisualizer.rerun", async () => {
        await VisualizerPanel_1.VisualizerPanel.rerun(context);
    });
    context.subscriptions.push(startCmd, rerunCmd);
}
function deactivate() {
    VisualizerPanel_1.VisualizerPanel.dispose();
}
//# sourceMappingURL=extension.js.map