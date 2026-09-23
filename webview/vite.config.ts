import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Webview HTML is loaded via a vscode-webview:// URI, not from a server root,
// so asset references must be relative — otherwise the extension host's
// asWebviewUri() rewriting (see webviewProvider.ts) can't resolve them.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
