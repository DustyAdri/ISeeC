import React from 'react';

export const NullSentinel: React.FC = () => (
  <div id="heap-null" className="heap-block null-sentinel">
    <span style={{ color: '#EF5350', fontWeight: 'bold' }}>NULL</span>
  </div>
);