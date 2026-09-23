import * as cp from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import { StepMessage } from "./types/stepTypes";
import { isValidStepMessage } from "./schemas/stepSchema";

export type OnStepCallback = (step: StepMessage) => void;

export class GdbManager extends EventEmitter {
  private _proc: cp.ChildProcess | null = null;
  private _killTimer: NodeJS.Timeout | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _onStep: OnStepCallback;

  constructor(
    private readonly binaryPath: string,
    private readonly tracerPath: string,
    onStep: OnStepCallback,
    outputChannel: vscode.OutputChannel
  ) {
    super();
    this._onStep = onStep;
    this._outputChannel = outputChannel;
  }

  start(): void {
    if (this._proc) {
      throw new Error("GdbManager.start() called while already running");
    }

    const normalizedTracerPath = this.tracerPath.replace(/\\/g, "/");

    const args = [
      "-batch",
      "-ex", `source ${normalizedTracerPath}`,
      // "run_traced" (defined by the tracer script) redirects the
      // inferior's stdout to a temp file instead of plain "run" — GDB
      // doesn't reliably share the debuggee's stdout with our own pipe on
      // Windows when GDB itself has no real console.
      "-ex", "run_traced",
      this.binaryPath,
    ];

    this._outputChannel.appendLine(`[c-stack-viz] Spawning GDB with args: ${JSON.stringify(args)}`);

    this._proc = cp.spawn("gdb", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stderr?.on("data", (chunk: Buffer) => {
      this._outputChannel.appendLine(`[gdb stderr] ${chunk.toString().trimEnd()}`);
    });

    const rl = readline.createInterface({
      input: this._proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this._outputChannel.appendLine(
          `[c-stack-viz] Skipping non-JSON line from GDB: ${trimmed}`
        );
        return;
      }

      if (!isValidStepMessage(parsed)) {
        this._outputChannel.appendLine(
          `[c-stack-viz] Skipping invalid StepData (missing required fields): ${trimmed}`
        );
        return;
      }

      this._onStep(parsed);
    });

    this._proc.on("close", (code, signal) => {
      this._proc = null;
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }

      if (code !== 0 && code !== null) {
        this.emit("error", { code, signal });
      }
    });

    this._proc.on("error", (err) => {
      this._outputChannel.appendLine(
        `[c-stack-viz] GDB process error: ${err.message}`
      );
      this.emit("error", { code: null, signal: null });
    });
  }

  sendControl(cmd: "next" | "step" | "continue" | "quit"): void {
    if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) {
      this._outputChannel.appendLine(
        `[c-stack-viz] sendControl("${cmd}") ignored — GDB is not running`
      );
      return;
    }

    this._proc.stdin.write(cmd + "\n", (err) => {
      if (err) {
        this._outputChannel.appendLine(
          `[c-stack-viz] Failed to write "${cmd}" to GDB stdin: ${err.message}`
        );
      }
    });
  }

  dispose(): void {
    if (!this._proc) {
      return;
    }

    const proc = this._proc;
    this._proc = null;

    try {
      proc.stdin?.end();
    } catch {
      // best-effort
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }

    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      try {
        proc.kill("SIGKILL");
      } catch {
        // best-effort
      }
      if (proc.pid) {
        cp.exec(`taskkill /F /T /PID ${proc.pid}`, () => {});
      }
    }, 1000);
  }

  get isRunning(): boolean {
    return this._proc !== null;
  }
}