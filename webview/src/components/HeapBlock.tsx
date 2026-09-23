import React from "react";
import { HeapBlock as HeapBlockData } from "../types/stepTypes";
import { shortenAddress, isNullAddress } from "../utils/pointerUtils";

interface HeapBlockProps {
  block: HeapBlockData;
  showAddresses: boolean;
}

function renderFieldValue(value: string | number, showAddresses: boolean): React.ReactNode {
  // The tracer encodes a still-garbage (not-yet-assigned) field as the
  // literal string "?" — same convention as stack variables, so it gets
  // the same warning treatment here for visual consistency.
  if (value === "?") {
    return (
      <span className="var-uninitialized">
        <span className="var-uninitialized__icon" aria-label="uninitialized">⚠</span>
        <span className="var-uninitialized__text">?</span>
      </span>
    );
  }

  if (typeof value === "string" && isNullAddress(value)) {
    return <span className="var-null">NULL</span>;
  }

  // A field pointing at another block (e.g. a linked-list node's "next")
  // is a hex address string.
  if (!showAddresses && typeof value === "string" && value.startsWith("0x")) {
    return <span className="var-pointer var-pointer--hidden" title={value}>→</span>;
  }

  return String(value);
}

export const HeapBlockCard: React.FC<HeapBlockProps> = ({ block, showAddresses }) => {
  const freed = !block.is_allocated;

  return (
    <div
      id={`heap-${block.address}`}
      className={`heap-block ${freed ? "heap-block--freed" : "heap-block--allocated"}`}
      aria-label={`Heap block at ${block.address}${freed ? " (freed)" : ""}`}
    >
      {freed && (
        <span className="heap-block__skull" aria-label="freed">
          💀
        </span>
      )}

      <div className="heap-block__header">
        {showAddresses ? (
          <span className="heap-block__addr" title={block.address}>
            {shortenAddress(block.address)}
          </span>
        ) : (
          <span className="heap-block__addr heap-block__addr--hidden" title={block.address}>
            •
          </span>
        )}
        <span className="heap-block__type">{block.type}</span>
      </div>

      {Object.keys(block.data).length > 0 && (
        <table className="heap-block__fields">
          <tbody>
            {Object.entries(block.data).map(([key, value]) => (
              <tr key={key}>
                <td className="heap-block__field-name">
                  <span className="var-name">{key}</span>
                  {block.field_types?.[key] && (
                    <span className="var-type">{block.field_types[key]}</span>
                  )}
                </td>
                <td
                  id={`heap-field-${block.address}-${key}`}
                  className="heap-block__field-value"
                >
                  {renderFieldValue(value, showAddresses)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {freed && (
        <div className="heap-block__freed-label">freed</div>
      )}
    </div>
  );
};