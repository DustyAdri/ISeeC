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
exports.GdbManager = void 0;
const cp = __importStar(require("child_process"));
const readline = __importStar(require("readline"));
const events_1 = require("events");
const stepSchema_1 = require("./schemas/stepSchema");
/**
 * GdbManager owns the GDB child process and handles all I/O with it.
 *
 * Events:
 *   "error"   emitted when GDB exits with a non-zero code.
 *             Payload: { code: number | null, signal: string | null }
 */
class GdbManager extends events_1.EventEmitter {
    constructor(binaryPath, tracerPath, onStep, outputChannel) {
        super();
        this.binaryPath = binaryPath;
        this.tracerPath = tracerPath;
        this._proc = null;
        this._killTimer = null;
        this._onStep = onStep;
        this._outputChannel = outputChannel;
    }
    /**
     * Spawn GDB with the tracer script.
     * Reads stdout line-by-line; each line is parsed as JSON and validated
     * before being forwarded to the onStep callback.
     */
    start() {
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
        this._proc.stderr?.on("data", (chunk) => {
            this._outputChannel.appendLine(`[gdb stderr] ${chunk.toString().trimEnd()}`);
        });
        // Line-by-line stdout parsing.
        const rl = readline.createInterface({
            input: this._proc.stdout,
            crlfDelay: Infinity,
        });
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                this._outputChannel.appendLine(`[c-stack-viz] Skipping non-JSON line from GDB: ${trimmed}`);
                return;
            }
            if (!(0, stepSchema_1.isValidStepData)(parsed)) {
                this._outputChannel.appendLine(`[c-stack-viz] Skipping invalid StepData (missing required fields): ${trimmed}`);
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
            this._outputChannel.appendLine(`[c-stack-viz] GDB process error: ${err.message}`);
            this.emit("error", { code: null, signal: null });
        });
    }
    /**
     * Write a control command to GDB stdin.
     * Valid values: "next" | "step" | "continue" | "quit"
     */
    sendControl(cmd) {
        if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) {
            this._outputChannel.appendLine(`[c-stack-viz] sendControl("${cmd}") ignored — GDB is not running`);
            return;
        }
        this._proc.stdin.write(cmd + "\n", (err) => {
            if (err) {
                this._outputChannel.appendLine(`[c-stack-viz] Failed to write "${cmd}" to GDB stdin: ${err.message}`);
            }
        });
    }
    /**
     * Kill the GDB process.
     * Sends SIGTERM first, then SIGKILL after 2 seconds if still alive.
     */
    dispose() {
        if (!this._proc) {
            return;
        }
        const proc = this._proc;
        this._proc = null;
        try {
            proc.kill("SIGTERM");
        }
        catch {
            // Process may already be dead.
        }
        this._killTimer = setTimeout(() => {
            this._killTimer = null;
            try {
                if (!proc.killed) {
                    proc.kill("SIGKILL");
                }
            }
            catch {
                // Best-effort.
            }
        }, 2000);
    }
    /** True if the GDB process is currently running. */
    get isRunning() {
        return this._proc !== null;
    }
}
exports.GdbManager = GdbManager;
