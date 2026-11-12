// =============================================================================
// App.tsx
// The whole page: the trip form at the top, and the result underneath.
//
// Flow when you click "Check my trip":
//   form -> POST /api/assess -> backend asks the 3 sources -> result shown here
// =============================================================================

import { useState } from "react";
import AirportPicker from "./AirportPicker";

// =============================================================================
// PART 1: TYPES
// The shapes of the JSON the backend sends back. They match the backend's
// types in server/src/airports.ts and server/src/sources.ts.
// =============================================================================

export type Severity = "low" | "medium" | "high";

export interface Airport {
  code: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  timezone: string;
}

interface Finding {
  severity: Severity;
  text: string;
}

interface SourceResult {
  name: string;
  status: "ok" | "skipped" | "error";
  severity: Severity | null;
  findings: Finding[];
  message?: string;
  checkedAt: string;
}

interface Assessment {
  origin: Airport;
  destination: Airport;
  date: string; // departure, local to the origin
  time: string;
  arrivalDate: string; // arrival, local to the destination
  arrivalTime: string;
  hoursAway: number; // hours until take-off
  flightHours: number; // hours between take-off and landing
  overall: Severity | "unknown";
  summary: string;
  sources: SourceResult[];
  notes: string[];
}

// =============================================================================
// PART 2: SMALL HELPERS
// =============================================================================

// -----------------------------------------------------------------------------
// COLOURS: risk level -> Bootstrap colour. success = green, warning = yellow,
// danger = red, secondary = grey.
// LABELS: risk level -> the words on the badges.
// -----------------------------------------------------------------------------
const COLOURS: Record<Severity | "unknown", string> = { low: "success", medium: "warning", high: "danger", unknown: "secondary" };
const LABELS: Record<Severity | "unknown", string> = { low: "Low risk", medium: "Medium risk", high: "High risk", unknown: "Unknown" };

// -----------------------------------------------------------------------------
// tomorrow: tomorrow's date as "YYYY-MM-DD", the form's starting date.
// padStart(2, "0") turns 7 into "07".
// -----------------------------------------------------------------------------
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// -----------------------------------------------------------------------------
// howFarAway: 26.5 -> "in 26 hours", 80 -> "in 3 days".
// -----------------------------------------------------------------------------
function howFarAway(hours: number): string {
  if (hours < 1) return "in less than an hour";
  if (hours < 48) return `in ${Math.round(hours)} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

// -----------------------------------------------------------------------------
// flightLength: 6.5 -> "6 h 30 min", 5 -> "5 h".
// -----------------------------------------------------------------------------
function flightLength(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// =============================================================================
// PART 3: THE PAGE
// =============================================================================

export default function App() {
  // ---------------------------------------------------------------------------
  // State: values that make React redraw the page when they change.
  //   origin, destination      -> the airports (empty until the user picks)
  //   date, time               -> departure, local to the departure airport
  //   arrivalDate, arrivalTime -> arrival, local to the arrival airport
  //   assessment -> the latest result from the backend (null before a search)
  //   loading    -> true while waiting for the backend
  //   error      -> a message to show if something went wrong
  // ---------------------------------------------------------------------------
  const [origin, setOrigin] = useState<Airport | null>(null);
  const [destination, setDestination] = useState<Airport | null>(null);
  const [date, setDate] = useState(tomorrow());
  const [time, setTime] = useState("");
  const [arrivalDate, setArrivalDate] = useState(tomorrow());
  const [arrivalTime, setArrivalTime] = useState("");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // changeDepartureDate: when the departure date moves later, move the arrival
  // date with it, so the user doesn't accidentally land before they leave.
  // Dates are "YYYY-MM-DD" text, which compares correctly as text.
  // ---------------------------------------------------------------------------
  function changeDepartureDate(newDate: string) {
    setDate(newDate);
    if (arrivalDate < newDate) setArrivalDate(newDate);
  }

  // ---------------------------------------------------------------------------
  // checkTrip: runs when the form is submitted.
  //   1. Stop the browser's default page reload.
  //   2. Send the trip to the backend as JSON.
  //   3. Show the result, or the error message the backend sent back.
  // `finally` runs either way, like in Java.
  // ---------------------------------------------------------------------------
  async function checkTrip(e: React.FormEvent) {
    e.preventDefault();
    if (!origin || !destination) return;

    setLoading(true);
    setError(null);
    setAssessment(null);
    try {
      const res = await fetch("/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: origin.code, destination: destination.code, date, time, arrivalDate, arrivalTime }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Something went wrong. Is the backend running?");
      setAssessment(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const sameAirport = origin !== null && destination !== null && origin.code === destination.code;

  // ---------------------------------------------------------------------------
  // The layout. Bootstrap classes do the styling:
  //   row / col-md-*  -> side by side on wide screens, stacked on phones
  //   card, alert, badge, btn -> ready-made Bootstrap components
  // `{condition && <X />}` means "only show X when condition is true".
  // ---------------------------------------------------------------------------
  return (
    <main className="container py-5" style={{ maxWidth: 1000 }}>
      <header className="mb-4">
        <h1 className="h2 fw-bold">Trip Disruption Checker</h1>
        <p className="text-body-secondary mb-0">
          Enter a U.S. flight with its departure and arrival times, as on your booking, to see possible disruptions from the
          National Weather Service forecast and warnings, and FAA airport status.
        </p>
      </header>

      {/* ---------- The trip form ---------- */}
      <form className="card card-body shadow-sm" onSubmit={checkTrip}>
        <div className="row g-3 align-items-end">
          <div className="col-12 col-md">
            <AirportPicker id="origin" label="From" value={origin} onChange={setOrigin} />
          </div>
          <div className="col-12 col-md-auto text-center">
            {/* Swap button: flips From and To */}
            <button
              type="button"
              className="btn btn-outline-secondary"
              aria-label="Swap airports"
              onClick={() => {
                setOrigin(destination);
                setDestination(origin);
              }}
            >
              ⇄
            </button>
          </div>
          <div className="col-12 col-md">
            <AirportPicker id="destination" label="To" value={destination} onChange={setDestination} />
          </div>
        </div>

        {/* Departure and arrival: each in its own airport's local time */}
        <div className="row g-3 mt-0">
          <div className="col-12 col-md-6">
            <div className="row g-2">
              <div className="col-6">
                <label htmlFor="date" className="form-label fw-semibold">Departure date</label>
                <input id="date" type="date" className="form-control" value={date} onChange={(e) => changeDepartureDate(e.target.value)} required />
              </div>
              <div className="col-6">
                <label htmlFor="time" className="form-label fw-semibold">Departure time</label>
                <input id="time" type="time" className="form-control" value={time} onChange={(e) => setTime(e.target.value)} required />
              </div>
            </div>
            <p className="form-text mb-0">Local time at {origin ? origin.city : "the departure airport"}.</p>
          </div>
          <div className="col-12 col-md-6">
            <div className="row g-2">
              <div className="col-6">
                <label htmlFor="arrivalDate" className="form-label fw-semibold">Arrival date</label>
                <input id="arrivalDate" type="date" className="form-control" value={arrivalDate} min={date} onChange={(e) => setArrivalDate(e.target.value)} required />
              </div>
              <div className="col-6">
                <label htmlFor="arrivalTime" className="form-label fw-semibold">Arrival time</label>
                <input id="arrivalTime" type="time" className="form-control" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} required />
              </div>
            </div>
            <p className="form-text mb-0">Local time at {destination ? destination.city : "the arrival airport"}, as on your booking.</p>
          </div>
        </div>

        <button type="submit" className="btn btn-primary mt-3" disabled={loading || !origin || !destination || sameAirport || !time || !arrivalTime}>
          {loading ? "Checking sources…" : "Check my trip"}
        </button>
        {sameAirport && <div className="form-text text-danger">Pick two different airports.</div>}
      </form>

      {/* ---------- Error message ---------- */}
      {error && <div className="alert alert-danger mt-4">{error}</div>}

      {/* ---------- The result ---------- */}
      {assessment && (
        <section className="mt-4">
          {/* Overall banner, coloured by the overall risk */}
          <div className={`alert alert-${COLOURS[assessment.overall]} shadow-sm`}>
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
              <h2 className="h4 mb-0">
                {assessment.origin.city} ({assessment.origin.code}) → {assessment.destination.city} ({assessment.destination.code})
              </h2>
              <span className={`badge fs-6 text-bg-${COLOURS[assessment.overall]}`}>{LABELS[assessment.overall]}</span>
            </div>
            <p className="mb-0 mt-2">
              Departs <strong>{assessment.date} at {assessment.time}</strong> {assessment.origin.city} time ({howFarAway(assessment.hoursAway)}),
              arrives <strong>{assessment.arrivalDate} at {assessment.arrivalTime}</strong> {assessment.destination.city} time.
              Flight time: {flightLength(assessment.flightHours)}.
            </p>
            <p className="mb-0 mt-2 fw-semibold">
              {assessment.summary}
            </p>
          </div>

          {/* Notes, e.g. "Couldn't reach ..." */}
          {assessment.notes.map((note) => (
            <div key={note} className="alert alert-light border small">{note}</div>
          ))}

          {/* One card per source: 3 across on wide screens, stacked on phones */}
          <div className="row g-3">
            {assessment.sources.map((source) => (
              <div key={source.name} className="col-12 col-lg-4">
                <div className="card h-100">
                  <div className="card-header d-flex justify-content-between align-items-center gap-2">
                    <span className="fw-semibold">{source.name}</span>
                    {source.status === "ok" && (
                      <span className={`badge text-bg-${COLOURS[source.severity ?? "unknown"]}`}>{LABELS[source.severity ?? "unknown"]}</span>
                    )}
                    {source.status === "skipped" && <span className="badge text-bg-secondary">Not checked</span>}
                    {source.status === "error" && <span className="badge text-bg-dark">Unavailable</span>}
                  </div>
                  <div className="card-body">
                    {source.findings.length > 0 && (
                      <ul className="list-unstyled mb-2">
                        {source.findings.map((f) => (
                          <li key={f.text} className="mb-2">
                            <span className={`badge rounded-pill text-bg-${COLOURS[f.severity]} me-2`}>{f.severity}</span>
                            {f.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {source.message && <p className="text-body-secondary small mb-0">{source.message}</p>}
                  </div>
                  <div className="card-footer text-body-secondary small">
                    Checked at {new Date(source.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="text-body-secondary small mt-5">
        Data: National Weather Service (weather.gov) and FAA (nasstatus.faa.gov). Airport list: mwgg/Airports. This is a prototype;
        always confirm with your airline.
      </footer>
    </main>
  );
}
