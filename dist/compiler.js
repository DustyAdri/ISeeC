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
exports.CompilationError = void 0;
exports.compileFile = compileFile;
exports.clearDiagnostics = clearDiagnostics;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
/** Typed error thrown when gcc exits with a non-zero code. */
class CompilationError extends Error {
    constructor(message, diagnostics) {
        super(message);
        this.diagnostics = diagnostics;
        this.name = "CompilationError";
    }
}
exports.CompilationError = CompilationError;
/**
 * Compile a C source file with `gcc -g`.
 *
 * @param sourcePath  Absolute path to the .c source file.
 * @returns           Absolute path to the compiled binary (same directory as source).
 * @throws            {CompilationError} if gcc exits with a non-zero code.
 */
async function compileFile(sourcePath) {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const binaryPath = path.join(dir, base);
    const args = ["-g", "-o", binaryPath, sourcePath];
    return new Promise((resolve, reject) => {
        const proc = cp.spawn("gcc", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve(binaryPath);
                return;
            }
            // Parse gcc stderr into VS Code Diagnostics.
            // gcc error lines look like:
            //   <file>:<line>:<col>: error: <message>
            //   <file>:<line>:<col>: warning: <message>
            const diagnostics = parseGccStderr(stderr, sourcePath);
            reportDiagnostics(sourcePath, diagnostics);
            reject(new CompilationError(`gcc exited with code ${code}:\n${stderr}`, diagnostics));
        });
        proc.on("error", (err) => {
            reject(new CompilationError(`Failed to spawn gcc: ${err.message}`, []));
        });
    });
}
// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
const _diagnosticCollection = vscode.languages.createDiagnosticCollection("c-stack-viz");
function parseGccStderr(stderr, sourcePath) {
    const diagnostics = [];
    // Match lines of the form:
    //   /path/to/file.c:10:5: error: some message
    //   /path/to/file.c:10:5: warning: some message
    const lineRe = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
    let match;
    while ((match = lineRe.exec(stderr)) !== null) {
        const [, file, lineStr, colStr, severity, message] = match;
        // Only attach diagnostics for the file we compiled.
        if (!file.endsWith(path.basename(sourcePath)) && file !== sourcePath) {
            continue;
        }
        const line = Math.max(0, parseInt(lineStr, 10) - 1); // convert to 0-indexed
        const col = Math.max(0, parseInt(colStr, 10) - 1);
        const range = new vscode.Range(line, col, line, col + 1);
        const sev = severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : severity === "warning"
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information;
        diagnostics.push(new vscode.Diagnostic(range, message, sev));
    }
    return diagnostics;
}
function reportDiagnostics(sourcePath, diagnostics) {
    const uri = vscode.Uri.file(sourcePath);
    _diagnosticCollection.set(uri, diagnostics);
}
/** Clear all diagnostics produced by this extension. */
function clearDiagnostics(sourcePath) {
    const uri = vscode.Uri.file(sourcePath);
    _diagnosticCollection.delete(uri);
}
