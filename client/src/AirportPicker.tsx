// =============================================================================
// AirportPicker.tsx
// The "type a city or code" box. As you type, it asks the backend for
// matching airports and shows them in a list underneath. Click one, or use
// the arrow keys and Enter.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import type { Airport } from "./App";

// -----------------------------------------------------------------------------
// Props: what the parent (App) passes in. Like constructor parameters in Java.
//   value    -> the airport currently chosen (or null)
//   onChange -> the function to call when the user picks a different airport
// -----------------------------------------------------------------------------
interface Props {
  id: string;
  label: string;
  value: Airport | null;
  onChange: (airport: Airport) => void;
}

// -----------------------------------------------------------------------------
// describe: how a chosen airport appears in the box, e.g. "New York (JFK)".
// -----------------------------------------------------------------------------
function describe(a: Airport): string {
  return `${a.city} (${a.code})`;
}

export default function AirportPicker({ id, label, value, onChange }: Props) {
  // ---------------------------------------------------------------------------
  // State: values that make React redraw the box when they change.
  //   text        -> what's typed in the box
  //   results     -> the airports in the suggestion list
  //   open        -> whether the list is showing
  //   highlighted -> which suggestion the arrow keys are on
  // useRef holds a link to the box's outer <div>, to detect clicks outside it.
  // ---------------------------------------------------------------------------
  const [text, setText] = useState(value ? describe(value) : "");
  const [results, setResults] = useState<Airport[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // When the chosen airport changes from outside (e.g. the swap button),
  // show the new one in the box.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setText(value ? describe(value) : "");
  }, [value]);

  // ---------------------------------------------------------------------------
  // Search as the user types. We wait 200 ms after the last key press before
  // asking the backend ("debouncing"), instead of sending a request per key.
  // The returned function cancels the timer if they type again in time.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!open || text.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/airports/search?q=${encodeURIComponent(text)}`);
        setResults(res.ok ? await res.json() : []);
        setHighlighted(0);
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [text, open]);

  // ---------------------------------------------------------------------------
  // Close the list when the user clicks anywhere else on the page, and put
  // the chosen airport back in the box.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setText(value ? describe(value) : "");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [value]);

  // ---------------------------------------------------------------------------
  // choose: the user picked an airport.
  // ---------------------------------------------------------------------------
  function choose(a: Airport) {
    onChange(a);
    setText(describe(a));
    setOpen(false);
  }

  // ---------------------------------------------------------------------------
  // Keyboard: up/down arrows move through the list, Enter picks, Escape closes.
  // ---------------------------------------------------------------------------
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault(); // don't submit the form
      choose(results[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // ---------------------------------------------------------------------------
  // What's drawn: a label, the text box, and the suggestion list (a Bootstrap
  // "list-group") placed just under the box while it's open.
  // ---------------------------------------------------------------------------
  return (
    <div className="position-relative" ref={boxRef}>
      <label htmlFor={id} className="form-label fw-semibold">{label}</label>
      <input
        id={id}
        className="form-control"
        placeholder="Type a city or airport code"
        autoComplete="off"
        value={text}
        onFocus={(e) => {
          e.target.select(); // highlight the text, so typing replaces it
          setOpen(true);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={`${id}-list`}
      />

      {open && results.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="list-group position-absolute w-100 shadow mt-1"
          style={{ zIndex: 10, maxHeight: 320, overflowY: "auto" }}
        >
          {results.map((a, i) => (
            <li
              key={a.code}
              role="option"
              aria-selected={i === highlighted}
              className={`list-group-item list-group-item-action ${i === highlighted ? "active" : ""}`}
              style={{ cursor: "pointer" }}
              // onMouseDown runs before the box loses focus, so the click isn't lost
              onMouseDown={(e) => {
                e.preventDefault();
                choose(a);
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              <div className="fw-semibold">{a.city} ({a.code})</div>
              <div className="small opacity-75">{a.name}{a.state ? ` · ${a.state}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
