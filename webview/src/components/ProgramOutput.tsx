import React from "react";

interface ProgramOutputProps {
  text: string;
}

export const ProgramOutput: React.FC<ProgramOutputProps> = ({ text }) => {
  return (
    <div className="program-output">
      <h2 className="panel__title">Program Output</h2>
      {text ? (
        <pre className="program-output__text">{text}</pre>
      ) : (
        <p className="panel__empty">No output yet</p>
      )}
    </div>
  );
};
