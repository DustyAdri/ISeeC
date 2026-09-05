import React from "react";
import { HeapBlock as HeapBlockData } from "../types/stepTypes";
import { shortenAddress } from "../utils/pointerUtils";

interface HeapBlockProps {
  block: HeapBlockData;
}

export const HeapBlockCard: React.FC<HeapBlockProps> = ({ block }) => {
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
        <span className="heap-block__addr" title={block.address}>
          {shortenAddress(block.address)}
        </span>
        <span className="heap-block__type">{block.type}</span>
      </div>

      {Object.keys(block.data).length > 0 && (
        <table className="heap-block__fields">
          <tbody>
            {Object.entries(block.data).map(([key, value]) => (
              <tr key={key}>
                <td className="heap-block__field-name">{key}</td>
                <td className="heap-block__field-value">{String(value)}</td>
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