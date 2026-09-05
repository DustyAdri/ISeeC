interface VscodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VscodeApi;

function createStub(): VscodeApi {
  return {
    postMessage(message: unknown) {
      console.log("[vscode stub] postMessage:", message);
    },
    getState() {
      return undefined;
    },
    setState(_state: unknown) {
      /* no-op */
    },
  };
}

export const vscodeApi: VscodeApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : createStub();