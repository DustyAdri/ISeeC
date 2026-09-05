import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { isNullAddress, shortenAddress, isPointerType } from "../utils/pointerUtils";
function renderValue(variable) {
    if (variable.uninitialized) {
        return (_jsxs("span", { className: "var-uninitialized", children: [_jsx("span", { className: "var-uninitialized__icon", "aria-label": "uninitialized", children: "\u26A0" }), _jsx("span", { className: "var-uninitialized__text", children: "?" })] }));
    }
    const val = variable.value;
    // Null pointer — value is "0x0" or target_address resolves to null
    if (isPointerType(variable.type) && isNullAddress(val)) {
        return _jsx("span", { className: "var-null", children: "null" });
    }
    // Non-null pointer — show shortened address
    if (isPointerType(variable.type) && val.startsWith("0x")) {
        return (_jsx("span", { className: "var-pointer", title: val, children: shortenAddress(val) }));
    }
    // Scalar
    return _jsx("span", { className: "var-scalar", children: val });
}
export const StackFrameComponent = ({ frame, frameIndex, isActive, }) => {
    return (_jsxs("div", { className: `stack-frame ${isActive ? "stack-frame--active" : "stack-frame--inactive"}`, children: [_jsxs("div", { className: "stack-frame__header", children: [isActive && _jsx("span", { className: "stack-frame__indicator", "aria-hidden": "true", children: "\u25B6" }), _jsx("span", { className: "stack-frame__name", children: frame.name }), isActive && _jsx("span", { className: "stack-frame__badge", children: "active" })] }), frame.variables.length > 0 ? (_jsx("table", { className: "stack-frame__vars", children: _jsx("tbody", { children: frame.variables.map((variable) => (_jsxs("tr", { className: "stack-frame__var-row", children: [_jsx("td", { id: `var-${frameIndex}-${variable.name}`, className: "stack-frame__var-name", children: variable.name }), _jsx("td", { className: "stack-frame__var-value", children: renderValue(variable) })] }, variable.name))) }) })) : (_jsx("p", { className: "stack-frame__empty", children: "no local variables" }))] }));
};
