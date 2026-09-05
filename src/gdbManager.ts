import * as cp from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import { StepData } from "./types/stepTypes";
import { isValidStepData } from "./schemas/stepSchema";

/** Callback invoked for each validated step received from GDB stdout. */
export type OnStepCallback = (step: StepData) => void;

/**
 * GdbManager owns the GDB child process and handles all I/O with it.
 *
 * Events:
 *   "error"   emitted when GDB exits with a non-zero code.
 *             Payload: { code: number | null, signal: string | null }
 */
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

  /**
   * Spawn GDB with the tracer script.
   * Reads stdout line-by-line; each line is parsed as JSON and validated
   * before being forwarded to the onStep callback.
   */
  start(): void {
    if (this._proc) {
      throw new Error("GdbManager.start() called while already running");
    }

    const args = [
      "-batch",
      "-ex", `source ${this.tracerPath}`,
      "-ex", "run",
      this.binaryPath,
    ];

    this._proc = cp.spawn("gdb", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stderr?.on("data", (chunk: Buffer) => {
      this._outputChannel.appendLine(`[gdb stderr] ${chunk.toString().trimEnd()}`);
    });

    // Line-by-line stdout parsing.
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

      if (!isValidStepData(parsed)) {
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

  /**
   * Write a control command to GDB stdin.
   * Valid values: "next" | "step" | "continue" | "quit"
   */
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

  /**
   * Kill the GDB process.
   * Sends SIGTERM first, then SIGKILL after 2 seconds if still alive.
   */
  dispose(): void {
    if (!this._proc) {
      return;
    }

    const proc = this._proc;
    this._proc = null;

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead.
    }

    this._killTimer = setTimeout(() => {
      this._killTimer = null;
      try {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      } catch {
        // Best-effort.
      }
    }, 2000);
  }

  /** True if the GDB process is currently running. */
  get isRunning(): boolean {
    return this._proc !== null;
  }
}
