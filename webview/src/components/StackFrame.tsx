import React from "react";
import { StackFrame as StackFrameData, VariableData as Variable } from "../types/stepTypes";
import { isNullAddress, shortenAddress, isPointerType } from "../utils/pointerUtils";

interface StackFrameProps {
  frame: StackFrameData;
  frameIndex: number;
  isActive: boolean;
}

function renderValue(variable: Variable): React.ReactNode {
  if (variable.uninitialized) {
    return (
      <span className="var-uninitialized">
        <span className="var-uninitialized__icon" aria-label="uninitialized">⚠</span>
        <span className="var-uninitialized__text">?</span>
      </span>
    );
  }

  const val = variable.value;

  // Null pointer — value is "0x0" or target_address resolves to null
  if (isPointerType(variable.type) && isNullAddress(val)) {
    return <span className="var-null">null</span>;
  }

  // Non-null pointer — show shortened address
  if (isPointerType(variable.type) && val.startsWith("0x")) {
    return (
      <span className="var-pointer" title={val}>
        {shortenAddress(val)}
      </span>
    );
  }

  // Scalar
  return <span className="var-scalar">{val}</span>;
}

export const StackFrameComponent: React.FC<StackFrameProps> = ({
  frame,
  frameIndex,
  isActive,
}) => {
  return (
    <div
      className={`stack-frame ${isActive ? "stack-frame--active" : "stack-frame--inactive"}`}
    >
      <div className="stack-frame__header">
        {isActive && <span className="stack-frame__indicator" aria-hidden="true">▶</span>}
        <span className="stack-frame__name">{frame.name}</span>
        {isActive && <span className="stack-frame__badge">active</span>}
      </div>

      {frame.variables.length > 0 ? (
        <table className="stack-frame__vars">
          <tbody>
            {frame.variables.map((variable) => (
              <tr key={variable.name} className="stack-frame__var-row">
                <td
                  id={`var-${frameIndex}-${variable.name}`}
                  className="stack-frame__var-name"
                >
                  {variable.name}
                </td>
                <td className="stack-frame__var-value">
                  {renderValue(variable)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="stack-frame__empty">no local variables</p>
      )}
    </div>
  );
};
