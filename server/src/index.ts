// =============================================================================
// index.ts
// The backend's starting point. It starts the Express web server, defines the
// three API routes the React app calls, and combines the three sources into
// one answer.
//
// Java comparison: this is like a Spring Boot @RestController plus main().
// Node.js runs the code (like the JVM); Express handles the web parts.
// =============================================================================

// Load the settings from server/.env into process.env (like application.properties).
// This line must come first, before anything reads process.env.
import "dotenv/config";
import express from "express";
import { findAirport, searchAirports } from "./airports";
import { getAlerts, getFaaStatus, getForecast, worstSeverity, type Severity, type Trip } from "./sources";
import { hoursUntil, isValidDate, isValidTime, localToUtc } from "./time";

// -----------------------------------------------------------------------------
// Create the web app, and let it read JSON sent by the browser.
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// GET /api/airports/search?q=chic
// Used by the airport box as you type. Returns up to 8 matching airports.
// req.query holds the part of the URL after the "?".
// -----------------------------------------------------------------------------
app.get("/api/airports/search", (req, res) => {
  const text = typeof req.query.q === "string" ? req.query.q : "";
  res.json(searchAirports(text));
});

// -----------------------------------------------------------------------------
// GET /api/airports/JFK
// Returns one airport. Used to fill in the starting airports on the form.
// ":code" is a path variable, like @PathVariable in Spring.
// -----------------------------------------------------------------------------
app.get("/api/airports/:code", (req, res) => {
  const airport = findAirport(req.params.code);
  if (!airport) return res.status(404).json({ error: `Unknown airport code: ${req.params.code}` });
  res.json(airport);
});

// -----------------------------------------------------------------------------
// SUMMARIES: the sentence shown for each overall risk level.
// -----------------------------------------------------------------------------
const SUMMARIES: Record<Severity, string> = {
  low: "Low risk: no significant disruptions found.",
  medium: "Medium risk: some conditions could cause delays. Keep an eye on your flight status.",
  high: "High risk: serious disruptions are likely. Check with your airline and consider a backup plan.",
};

// -----------------------------------------------------------------------------
// POST /api/assess
// Body: { origin: "JFK", destination: "SFO", date: "2026-10-31", time: "09:00" }
// The date and time are local to the DEPARTURE airport, like a boarding pass.
//
// Steps:
//   1. Check the input. Anything wrong -> 400 with a clear message.
//   2. Turn the local departure time into an exact moment; refuse past times.
//   3. Ask all three sources at the same time.
//   4. Combine: the overall risk is the WORST level from any source that
//      answered ("worst source wins"). Skipped or failed sources don't count,
//      but we add a note so the user knows the result is incomplete.
// -----------------------------------------------------------------------------
app.post("/api/assess", async (req, res) => {
  const { origin, destination, date, time } = req.body ?? {};

  // Step 1: check the input
  const from = typeof origin === "string" ? findAirport(origin) : undefined;
  const to = typeof destination === "string" ? findAirport(destination) : undefined;
  if (!from || !to) return res.status(400).json({ error: "Please choose a departure and an arrival airport from the list." });
  if (from.code === to.code) return res.status(400).json({ error: "The departure and arrival airports must be different." });
  if (typeof date !== "string" || !isValidDate(date)) return res.status(400).json({ error: "Please enter a valid date." });
  if (typeof time !== "string" || !isValidTime(time)) return res.status(400).json({ error: "Please enter a valid time." });

  // Step 2: exact departure moment and hours away
  const departureUtc = localToUtc(date, time, from.timezone);
  const hoursAway = hoursUntil(departureUtc);
  if (hoursAway < 0) {
    return res.status(400).json({ error: `That departure time has already passed in ${from.city}.` });
  }

  const trip: Trip = { origin: from, destination: to, departureUtc, hoursAway };

  // Step 3: all three sources at once. Promise.all waits for all of them,
  // like CompletableFuture.allOf in Java. Each source handles its own errors,
  // so one failing API can't break the whole answer.
  const sources = await Promise.all([getForecast(trip), getAlerts(trip), getFaaStatus(trip)]);

  // Step 4: combine
  const answered = sources.filter((s) => s.status === "ok" && s.severity !== null);
  const failed = sources.filter((s) => s.status === "error");

  const notes: string[] = [];
  if (failed.length > 0) notes.push(`Couldn't reach ${failed.map((s) => s.name).join(" or ")}, so this result is incomplete.`);
  if (hoursAway > 168) notes.push("Your flight is more than a week away. Check again a few days before you travel.");

  const overall = answered.length > 0 ? worstSeverity(answered.map((s) => s.severity as Severity)) : null;

  res.json({
    origin: from,
    destination: to,
    date,
    time,
    hoursAway,
    overall: overall ?? "unknown",
    summary: overall ? SUMMARIES[overall] : "Not enough data to assess this trip.",
    sources,
    notes,
  });
});

// -----------------------------------------------------------------------------
// Start the server. If PORT isn't set in .env, use 3001.
// No API keys are needed: all three sources are free U.S. government services.
// -----------------------------------------------------------------------------
const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`API server running at http://localhost:${port}`);
  if (!process.env.NWS_USER_AGENT) {
    console.log("Tip: set NWS_USER_AGENT in server/.env with your app name and email, as the National Weather Service asks.");
  }
});
