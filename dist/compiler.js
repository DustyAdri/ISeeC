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
exports.resolveSources = resolveSources;
exports.compileFile = compileFile;
exports.clearDiagnostics = clearDiagnostics;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/** Typed error thrown when gcc exits with a non-zero code. */
class CompilationError extends Error {
    constructor(message, diagnostics) {
        super(message);
        this.diagnostics = diagnostics;
        this.name = "CompilationError";
    }
}
exports.CompilationError = CompilationError;
const MAIN_RE = /\bmain\s*\(/;
function definesMain(file) {
    try {
        return MAIN_RE.test(fs.readFileSync(file, "utf8"));
    }
    catch {
        return false;
    }
}
/**
 * Work out which .c files make up the program. The active file is always
 * included; sibling .c files in the same folder are added when they don't
 * define their own main() (so unrelated programs in one folder aren't mixed
 * in). If the active file is a helper without main(), the one sibling that
 * defines main() is used as the entry point.
 */
function resolveSources(sourcePath) {
    const dir = path.dirname(sourcePath);
    const siblings = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".c"))
        .map((f) => path.join(dir, f))
        .filter((f) => path.resolve(f).toLowerCase() !== path.resolve(sourcePath).toLowerCase());
    const helpers = siblings.filter((f) => !definesMain(f));
    if (definesMain(sourcePath)) {
        return [sourcePath, ...helpers];
    }
    const mains = siblings.filter(definesMain);
    return mains.length === 1
        ? [mains[0], sourcePath, ...helpers.filter((f) => f !== sourcePath)]
        : [sourcePath, ...helpers];
}
/**
 * Compile a program with `gcc -g`, linking the active file together with any
 * sibling .c files (see resolveSources).
 *
 * @param sourcePath  Absolute path to the active .c source file.
 * @returns           Absolute path to the compiled binary (same directory as source).
 * @throws            {CompilationError} if gcc exits with a non-zero code.
 */
async function compileFile(sourcePath) {
    const dir = path.dirname(sourcePath);
    const sources = resolveSources(sourcePath);
    const entry = sources[0];
    const base = path.basename(entry, path.extname(entry));
    const binaryPath = path.join(dir, base);
    const args = ["-g", "-o", binaryPath, ...sources];
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
            const byFile = parseGccStderr(stderr, sourcePath);
            reportDiagnostics(byFile);
            const diagnostics = [...byFile.values()].flat();
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
    const byFile = new Map();
    // Match lines of the form:
    //   /path/to/file.c:10:5: error: some message
    //   /path/to/file.c:10:5: warning: some message
    const lineRe = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
    let match;
    while ((match = lineRe.exec(stderr)) !== null) {
        const [, file, lineStr, colStr, severity, message] = match;
        // Diagnostics can come from any of the linked files. Paths in gcc's
        // output are relative to its cwd (the extension host's), so resolve
        // against the source folder when not already absolute.
        const abs = path.isAbsolute(file)
            ? file
            : path.join(path.dirname(sourcePath), file);
        const line = Math.max(0, parseInt(lineStr, 10) - 1); // convert to 0-indexed
        const col = Math.max(0, parseInt(colStr, 10) - 1);
        const range = new vscode.Range(line, col, line, col + 1);
        const sev = severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : severity === "warning"
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information;
        const list = byFile.get(abs) ?? [];
        list.push(new vscode.Diagnostic(range, message, sev));
        byFile.set(abs, list);
    }
    return byFile;
}
function reportDiagnostics(byFile) {
    for (const [file, diagnostics] of byFile) {
        _diagnosticCollection.set(vscode.Uri.file(file), diagnostics);
    }
}
/** Clear all diagnostics produced by this extension. */
function clearDiagnostics(_sourcePath) {
    _diagnosticCollection.clear();
}
