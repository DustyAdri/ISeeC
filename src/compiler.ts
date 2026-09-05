import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

/** Typed error thrown when gcc exits with a non-zero code. */
export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: vscode.Diagnostic[]
  ) {
    super(message);
    this.name = "CompilationError";
  }
}

/**
 * Compile a C source file with `gcc -g`.
 *
 * @param sourcePath  Absolute path to the .c source file.
 * @returns           Absolute path to the compiled binary (same directory as source).
 * @throws            {CompilationError} if gcc exits with a non-zero code.
 */
export async function compileFile(sourcePath: string): Promise<string> {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const binaryPath = path.join(dir, base);

  const args = ["-g", "-o", binaryPath, sourcePath];

  return new Promise<string>((resolve, reject) => {
    const proc = cp.spawn("gcc", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
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

      reject(
        new CompilationError(
          `gcc exited with code ${code}:\n${stderr}`,
          diagnostics
        )
      );
    });

    proc.on("error", (err) => {
      reject(
        new CompilationError(
          `Failed to spawn gcc: ${err.message}`,
          []
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const _diagnosticCollection =
  vscode.languages.createDiagnosticCollection("c-stack-viz");

function parseGccStderr(
  stderr: string,
  sourcePath: string
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  // Match lines of the form:
  //   /path/to/file.c:10:5: error: some message
  //   /path/to/file.c:10:5: warning: some message
  const lineRe =
    /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(stderr)) !== null) {
    const [, file, lineStr, colStr, severity, message] = match;

    // Only attach diagnostics for the file we compiled.
    if (!file.endsWith(path.basename(sourcePath)) && file !== sourcePath) {
      continue;
    }

    const line = Math.max(0, parseInt(lineStr, 10) - 1); // convert to 0-indexed
    const col = Math.max(0, parseInt(colStr, 10) - 1);
    const range = new vscode.Range(line, col, line, col + 1);

    const sev =
      severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : severity === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;

    diagnostics.push(new vscode.Diagnostic(range, message, sev));
  }

  return diagnostics;
}

function reportDiagnostics(
  sourcePath: string,
  diagnostics: vscode.Diagnostic[]
): void {
  const uri = vscode.Uri.file(sourcePath);
  _diagnosticCollection.set(uri, diagnostics);
}

/** Clear all diagnostics produced by this extension. */
export function clearDiagnostics(sourcePath: string): void {
  const uri = vscode.Uri.file(sourcePath);
  _diagnosticCollection.delete(uri);
}
