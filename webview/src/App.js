import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback } from "react";
import { useVscodeMessage } from "./hooks/useVscodeMessage";
import { Controls } from "./components/Controls";
import { StackPanel } from "./components/StackPanel";
import { HeapPanel } from "./components/HeapPanel";
import { PointerArrowLayer } from "./components/PointerArrowLayer";
export default function App() {
    var _a, _b, _c;
    const [currentStep, setCurrentStep] = useState(null);
    const [totalSteps, setTotalSteps] = useState(0);
    const [finished, setFinished] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);
    const handleStep = useCallback((step) => {
        setCurrentStep(step);
        setTotalSteps((prev) => Math.max(prev, step.step));
        setErrorMessage(null);
    }, []);
    const handleError = useCallback((message) => {
        setErrorMessage(message);
    }, []);
    const handleFinished = useCallback((finalStep) => {
        if (finalStep) {
            setCurrentStep(finalStep);
            setTotalSteps((prev) => Math.max(prev, finalStep.step));
        }
        setFinished(true);
    }, []);
    const handleReset = useCallback(() => {
        setCurrentStep(null);
        setTotalSteps(0);
        setFinished(false);
        setErrorMessage(null);
    }, []);
    useVscodeMessage({
        onStep: handleStep,
        onError: handleError,
        onFinished: handleFinished,
        onReset: handleReset,
    });
    const step = (_a = currentStep === null || currentStep === void 0 ? void 0 : currentStep.step) !== null && _a !== void 0 ? _a : 0;
    const stackFrames = (_b = currentStep === null || currentStep === void 0 ? void 0 : currentStep.stack_frames) !== null && _b !== void 0 ? _b : [];
    const heapBlocks = (_c = currentStep === null || currentStep === void 0 ? void 0 : currentStep.heap_blocks) !== null && _c !== void 0 ? _c : [];
    return (_jsxs("div", { className: "app", children: [_jsx(Controls, { step: step, totalSteps: totalSteps, finished: finished }), errorMessage && (_jsx("div", { className: "error-banner", role: "alert", children: errorMessage })), _jsxs("div", { className: "main-area", children: [_jsx(StackPanel, { frames: stackFrames }), _jsx(HeapPanel, { blocks: heapBlocks }), _jsx(PointerArrowLayer, { stackFrames: stackFrames, heapBlocks: heapBlocks })] })] }));
}
