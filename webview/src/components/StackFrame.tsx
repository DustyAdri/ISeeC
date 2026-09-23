import React from "react";
import { StackFrame as StackFrameData, VariableData as Variable } from "../types/stepTypes";
import { isNullAddress, shortenAddress, isPointerVar } from "../utils/pointerUtils";

interface StackFrameProps {
  frame: StackFrameData;
  frameIndex: number;
  isActive: boolean;
  showAddresses: boolean;
}

function renderValue(variable: Variable, showAddresses: boolean): React.ReactNode {
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
  if (isPointerVar(variable) && isNullAddress(val)) {
    return <span className="var-null">NULL</span>;
  }

  // Non-null pointer — show shortened address, unless addresses are
  // toggled off, in which case the arrow alone (if also shown) carries
  // the relationship and this cell just hints "this is a pointer".
  if (isPointerVar(variable) && val.startsWith("0x")) {
    if (!showAddresses) {
      return <span className="var-pointer var-pointer--hidden" title={val}>→</span>;
    }
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
  showAddresses,
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
                  <span className="var-name">{variable.name}</span>
                  <span className="var-type">{variable.type_label ?? variable.type}</span>
                </td>
                <td className="stack-frame__var-value">
                  {renderValue(variable, showAddresses)}
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
