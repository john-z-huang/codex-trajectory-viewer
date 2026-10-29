import { useId, useLayoutEffect, useRef, useState } from "react";
import { filterLeaves } from "../lib/conversation-types.js";

function TypeOption({ option, id, hiddenTypes, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);
  const leaves = filterLeaves([option]);
  const visibleCount = leaves.filter(({ value }) => !hiddenTypes.has(value)).length;
  const checked = visibleCount === leaves.length;
  const mixed = visibleCount > 0 && !checked;

  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);

  function toggleType() {
    const next = new Set(hiddenTypes);
    for (const { value } of leaves) {
      if (checked) next.add(value);
      else next.delete(value);
    }
    onChange(next);
  }

  const inputId = `${id}-${option.value}`;
  return (
    <div className="conversation-type-node">
      <div className="conversation-type-row">
        <label htmlFor={inputId}>
          <input ref={inputRef} id={inputId} type="checkbox" checked={checked} aria-checked={mixed ? "mixed" : checked} onChange={toggleType} />
          {option.label}
        </label>
        {option.children && (
          <button type="button" className="conversation-type-expand" aria-label={`${expanded ? "收起" : "展开"}${option.label}子类别`} aria-expanded={expanded} aria-controls={`${inputId}-children`} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "▾" : "▸"}
          </button>
        )}
      </div>
      {option.children && (
        <div id={`${inputId}-children`} className="conversation-type-children" hidden={!expanded}>
          {option.children.map((child) => <TypeOption key={child.value} option={child} id={id} hiddenTypes={hiddenTypes} onChange={onChange} />)}
        </div>
      )}
    </div>
  );
}

export function ConversationTypeFilter({ options, hiddenTypes, onChange, visibleCount, totalCount, note }) {
  const id = useId();
  const leaves = filterLeaves(options);
  return (
    <fieldset className="conversation-type-filter">
      <legend>显示对话类型</legend>
      <div className="conversation-type-options">
        {options.map((option) => <TypeOption key={option.value} option={option} id={id} hiddenTypes={hiddenTypes} onChange={onChange} />)}
      </div>
      <div className="conversation-type-actions">
        <button type="button" onClick={() => onChange(new Set())} disabled={!hiddenTypes.size}>显示全部</button>
        <button type="button" onClick={() => onChange(new Set(leaves.map(({ value }) => value)))} disabled={leaves.every(({ value }) => hiddenTypes.has(value))}>隐藏全部</button>
      </div>
      <p className="conversation-type-status">本页显示 {visibleCount} / {totalCount} 条 · {note}</p>
    </fieldset>
  );
}
