var _a, _b;
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const vscodeApi = (_b = (_a = window).acquireVsCodeApi) === null || _b === void 0 ? void 0 : _b.call(_a);
export const Controls = ({ currentStep, isFinished }) => {
    const send = (direction) => vscodeApi === null || vscodeApi === void 0 ? void 0 : vscodeApi.postMessage({ type: 'requestStep', direction });
    return (_jsxs("div", { className: "controls", children: [_jsx("button", { onClick: () => send('backward'), disabled: currentStep <= 1, children: "\u25C0 Back" }), _jsxs("span", { children: ["Step ", currentStep] }), _jsx("button", { onClick: () => send('forward'), disabled: isFinished, children: "Forward \u25B6" }), _jsx("button", { onClick: () => vscodeApi === null || vscodeApi === void 0 ? void 0 : vscodeApi.postMessage({ type: 'requestReset' }), children: "Reset" })] }));
};
