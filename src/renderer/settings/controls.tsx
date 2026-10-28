// The parts every Settings tab is built of: a section with its message, a
// hint, and the fields that save as the host leaves them.
import React, { useId, useState } from "react";

import type { Message } from "./actions";

// A short line under a field or a group, in the muted color.
export function Hint(props: { id?: string; children: React.ReactNode }) {
  return (
    <p id={props.id} className="settingsHint">
      {props.children}
    </p>
  );
}

// A text or number field that saves when the host leaves it or presses
// Enter, if it changed; with a hint under it, if it needs one.
export function TextSetting(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  type?: "text" | "password" | "number";
  hint?: string;
}) {
  const hintId = useId();
  const [draft, setDraft] = useState(props.value);
  const [value, setValue] = useState(props.value);
  // A new saved value replaces the draft, unless the host is typing one.
  if (props.value !== value) {
    setValue(props.value);
    if (draft === value) setDraft(props.value);
  }
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  const field = (
    <label className="kfLabel">
      {props.label}
      <input
        className="kfField"
        type={props.type ?? "text"}
        value={draft}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={props.hint ? hintId : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        // A masked password is replaced, not added to.
        onFocus={
          props.type === "password"
            ? (event) => event.target.select()
            : undefined
        }
      />
    </label>
  );
  if (!props.hint) return field;
  return (
    <div className="settingsField">
      {field}
      <Hint id={hintId}>{props.hint}</Hint>
    </div>
  );
}

// A checkbox that saves at once, and shows the new state while it does.
// onChange says whether it saved; if not, the box goes back.
export function Checkbox(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => Promise<boolean>;
  hint?: string;
}) {
  const hintId = useId();
  const [checked, setChecked] = useState(props.checked);
  const [saved, setSaved] = useState(props.checked);
  if (props.checked !== saved) {
    setSaved(props.checked);
    setChecked(props.checked);
  }
  return (
    <div className="settingsField">
      <label className="kfCheckbox">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={props.hint ? hintId : undefined}
          onChange={(event) => {
            setChecked(event.target.checked);
            void props.onChange(event.target.checked).then((ok) => {
              if (!ok) setChecked(props.checked);
            });
          }}
        />
        {props.label}
      </label>
      {props.hint ? (
        <p id={hintId} className="settingsHint settingsCheckboxHint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsSection(props: {
  title: string;
  message?: Message | null;
  children: React.ReactNode;
}) {
  const { message } = props;
  return (
    <section className="settingsSection" aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
      {message ? (
        <div className={`settingsMessage ${message.tone ?? ""}`} role="status">
          <p>{message.text}</p>
          {message.list && message.list.length > 0 ? (
            <ul>
              {message.list.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
