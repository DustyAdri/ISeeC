import React from "react";
import { HeapBlock } from "../types/stepTypes";
import { HeapBlockCard } from "./HeapBlock";
import { NullSentinel } from "./NullSentinel";

interface HeapPanelProps {
  blocks: HeapBlock[];
}

export const HeapPanel: React.FC<HeapPanelProps> = ({ blocks }) => {
  return (
    <div className="panel heap-panel">
      <h2 className="panel__title">Heap</h2>
      <div className="heap-panel__blocks">
        {blocks.length === 0 && (
          <p className="panel__empty">No allocations yet</p>
        )}
        {blocks.map((block) => (
          <HeapBlockCard key={block.address} block={block} />
        ))}
      </div>
      <NullSentinel />
    </div>
  );
};