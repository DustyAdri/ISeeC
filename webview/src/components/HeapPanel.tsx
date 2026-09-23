import React from "react";
import { useXarrow } from "react-xarrows";
import { HeapBlock } from "../types/stepTypes";
import { HeapBlockCard } from "./HeapBlock";
import { NullSentinel } from "./NullSentinel";

interface HeapPanelProps {
  blocks: HeapBlock[];
  showAddresses: boolean;
}

export const HeapPanel: React.FC<HeapPanelProps> = ({ blocks, showAddresses }) => {
  // See the matching comment in StackPanel — this panel scrolls
  // independently too, and arrows need to be told when that happens.
  const updateXarrow = useXarrow();

  return (
    <div className="panel heap-panel" onScroll={updateXarrow}>
      <h2 className="panel__title">Heap</h2>
      <div className="heap-panel__blocks">
        {blocks.length === 0 && (
          <p className="panel__empty">No allocations yet</p>
        )}
        {blocks.map((block) => (
          <HeapBlockCard key={block.address} block={block} showAddresses={showAddresses} />
        ))}
      </div>
      <NullSentinel />
    </div>
  );
};