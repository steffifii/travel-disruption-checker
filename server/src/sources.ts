// =============================================================================
// sources.ts
// The three data sources the app combines. All three are official U.S.
// government services: free, and no API key needed.
//
//   1. NWS forecast     -> hour-by-hour weather forecast  (National Weather Service)
//   2. NWS alerts       -> official weather warnings      (National Weather Service)
//   3. FAA NAS status   -> ground stops, delay programs and closures happening
//                          right now (Federal Aviation Administration)
//
// Every source returns the SAME shape (SourceResult), so index.ts can combine
// them without caring which API the data came from.
//
// Each source has two parts:
//   - a "fetch" function that calls the API (needs the internet)
//   - a "score" function that turns the data into Low / Medium / High
//     (pure logic, no internet, which makes it easy to test and explain)
// =============================================================================

import { XMLParser } from "fast-xml-parser";
import type { Airport } from "./airports";

// =============================================================================
// PART 1: SHARED TYPES AND HELPERS
// =============================================================================

// -----------------------------------------------------------------------------
// Severity: the three risk levels. `type X = "a" | "b"` means X can only be
// one of these exact strings, similar to a Java enum.
// -----------------------------------------------------------------------------
export type Severity = "low" | "medium" | "high";

// -----------------------------------------------------------------------------
// Finding: one thing a source found, e.g.
// { severity: "high", text: "JFK: thunderstorms likely around departure" }
// -----------------------------------------------------------------------------
export interface Finding {
  severity: Severity;
  text: string;
}

// -----------------------------------------------------------------------------
// SourceResult: what every source returns.
//   status "ok"      -> the source answered
//   status "skipped" -> we didn't call it (e.g. the flight is too far away)
//   status "error"   -> we tried, but it failed
// `?` means optional; `| null` means the value can be null.
// -----------------------------------------------------------------------------
export interface SourceResult {
  name: string; // shown as the card title
  status: "ok" | "skipped" | "error";
  severity: Severity | null; // null when skipped or error
  findings: Finding[];
  message?: string; // why it was skipped, what went wrong, or extra context
  checkedAt: string; // when we asked, as an ISO timestamp
}

// -----------------------------------------------------------------------------
// Trip: the checked trip details that every source receives.
// departureUtc is the exact departure moment; hoursAway is how far off it is.
// -----------------------------------------------------------------------------
export interface Trip {
  origin: Airport;
  destination: Airport;
  departureUtc: Date;
  hoursAway: number;
}

// -----------------------------------------------------------------------------
// worstSeverity: the most serious level in a list ("low" if the list is empty).
// Strings can't be compared by size, so each level gets a number first.
// This is the "worst source wins" rule, used here and in index.ts.
// -----------------------------------------------------------------------------
const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export function worstSeverity(levels: Severity[]): Severity {
  let worst: Severity = "low";
  for (const level of levels) {
    if (RANK[level] > RANK[worst]) worst = level;
  }
  return worst;
}

// -----------------------------------------------------------------------------
// capAtMedium: lowers "high" to "medium". Used for "right now" data when the
// flight is hours away, because conditions can change before then.
// -----------------------------------------------------------------------------
function capAtMedium(findings: Finding[]): Finding[] {
  return findings.map((f) => (f.severity === "high" ? { ...f, severity: "medium" } : f));
}

// -----------------------------------------------------------------------------
// okResult / notOkResult: build a SourceResult, so each source doesn't repeat
// the same lines. okResult sorts the worst findings to the top and sets the
// source's level to the worst of its findings.
// -----------------------------------------------------------------------------
function okResult(name: string, findings: Finding[], message?: string): SourceResult {
  const sorted = [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return {
    name,
    status: "ok",
    severity: worstSeverity(sorted.map((f) => f.severity)),
    findings: sorted,
    message,
    checkedAt: new Date().toISOString(),
  };
}

function notOkResult(name: string, status: "skipped" | "error", message: string): SourceResult {
  return { name, status, severity: null, findings: [], message, checkedAt: new Date().toISOString() };
}

// -----------------------------------------------------------------------------
// errorMessage: turns any error into a short, readable sentence.
// "fetch failed" is Node's message when it can't reach a website at all.
// "TimeoutError" means the API took longer than our time limit.
// -----------------------------------------------------------------------------
function errorMessage(err: unknown, apiName: string): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `${apiName} took too long to respond.`;
    if (err.message === "fetch failed") return `Could not reach ${apiName} (network error).`;
    return err.message;
  }
  return `Unknown error from ${apiName}.`;
}

// =============================================================================
// PART 2: NATIONAL WEATHER SERVICE (NWS) - shared setup
// Docs: https://www.weather.gov/documentation/services-web-api
// The NWS asks every app to send a "User-Agent" header saying who it is,
// ideally with a contact email. Set NWS_USER_AGENT in server/.env.
// =============================================================================

// -----------------------------------------------------------------------------
// nwsGet: fetches a URL from the NWS and returns the JSON.
// The NWS sometimes returns a temporary error (5xx), so we try once more
// after half a second before giving up.
// -----------------------------------------------------------------------------
async function nwsGet(url: string): Promise<any> {
  const headers = {
    "User-Agent": process.env.NWS_USER_AGENT || "TripDisruptionChecker (prototype)",
    Accept: "application/geo+json",
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 500)); // wait 0.5 s
      continue;
    }
    throw new Error(`National Weather Service: HTTP ${res.status}`);
  }
}

// =============================================================================
// PART 3: NWS HOURLY FORECAST
// Getting a forecast takes two steps:
//   1. /points/{lat},{lon} tells us which forecast "grid" covers the airport,
//      and gives the URL of its hourly forecast.
//   2. That URL returns a list of 1-hour periods, about 6 days ahead.
// We check the departure airport from 1 hour before to 2 hours after take-off,
// and the arrival airport around the ESTIMATED landing time.
// =============================================================================

const FORECAST_NAME = "Weather forecast (NWS)";
const HOUR_MS = 3_600_000;

// -----------------------------------------------------------------------------
// ForecastHour: the fields we use from each hourly period.
// -----------------------------------------------------------------------------
export interface ForecastHour {
  startTime: string; // e.g. "2026-10-31T09:00:00-04:00"
  temperature: number; // °F
  windSpeed: string; // text, e.g. "10 mph" or "10 to 15 mph"
  shortForecast: string; // e.g. "Chance Showers And Thunderstorms"
  probabilityOfPrecipitation?: { value: number | null }; // chance of rain/snow, %
}

// -----------------------------------------------------------------------------
// windMph: pulls the highest number out of the wind text.
// "10 mph" -> 10, "10 to 15 mph" -> 15.
// -----------------------------------------------------------------------------
export function windMph(text: string): number {
  const numbers = (text.match(/\d+/g) ?? []).map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

// -----------------------------------------------------------------------------
// WEATHER_WORDS: phrases in the NWS "shortForecast" text that matter for
// flying, checked in this order. The first match decides the level.
// `likelyOnly` = only count it if precipitation is 50%+ likely; at lower
// chances it's mentioned as "medium" instead of "high".
// -----------------------------------------------------------------------------
const WEATHER_WORDS: { word: string; label: string; severity: Severity; likelyOnly?: boolean }[] = [
  { word: "blizzard", label: "blizzard", severity: "high" },
  { word: "freezing rain", label: "freezing rain", severity: "high" },
  { word: "freezing drizzle", label: "freezing drizzle", severity: "high" },
  { word: "sleet", label: "sleet", severity: "high" },
  { word: "ice", label: "ice", severity: "high" },
  { word: "heavy snow", label: "heavy snow", severity: "high" },
  { word: "thunderstorm", label: "thunderstorms", severity: "high", likelyOnly: true },
  { word: "snow", label: "snow", severity: "medium" },
  { word: "fog", label: "fog", severity: "medium" },
  { word: "heavy rain", label: "heavy rain", severity: "medium" },
];

// -----------------------------------------------------------------------------
// scoreForecast: turns a few forecast hours at one airport into findings.
// Rules:
//   - blizzard, freezing rain/drizzle, sleet, ice, heavy snow  -> high
//   - thunderstorms -> high if precipitation is 50%+ likely, else medium
//   - snow, fog, heavy rain                                     -> medium
//   - sustained wind 35+ mph -> high, 25+ mph -> medium
// `when` is a label like "around departure".
// -----------------------------------------------------------------------------
export function scoreForecast(code: string, when: string, hours: ForecastHour[]): Finding[] {
  if (hours.length === 0) {
    return [{ severity: "low", text: `${code}: no hourly forecast yet ${when} (NWS forecasts about 6 days ahead)` }];
  }

  const findings: Finding[] = [];
  const alreadyMentioned = new Set<string>(); // like a Java HashSet

  for (const h of hours) {
    const text = h.shortForecast.toLowerCase();
    const chance = h.probabilityOfPrecipitation?.value ?? 0;

    const match = WEATHER_WORDS.find((w) => text.includes(w.word));
    if (match && !alreadyMentioned.has(match.label)) {
      alreadyMentioned.add(match.label);
      const severity: Severity = match.likelyOnly && chance < 50 ? "medium" : match.severity;
      findings.push({ severity, text: `${code}: ${match.label} forecast ${when} (${h.shortForecast}, ${chance}% chance of precipitation)` });
    }
  }

  const maxWind = Math.max(...hours.map((h) => windMph(h.windSpeed)));
  if (maxWind >= 35) findings.push({ severity: "high", text: `${code}: wind up to ${maxWind} mph ${when}` });
  else if (maxWind >= 25) findings.push({ severity: "medium", text: `${code}: wind up to ${maxWind} mph ${when}` });

  // Nothing worrying: still describe the weather, so the user can see it was checked.
  if (findings.length === 0) {
    const temps = hours.map((h) => h.temperature);
    findings.push({
      severity: "low",
      text: `${code}: ${hours[0].shortForecast.toLowerCase()} ${when} (${Math.min(...temps)}–${Math.max(...temps)}°F, wind up to ${maxWind} mph)`,
    });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// estimateFlightHours: a rough flight time, used to guess the landing time.
// Straight-line distance (Haversine formula, Earth radius 3,959 miles),
// at about 500 mph cruising speed, plus 30 minutes for take-off and landing.
// Example: JFK -> SFO (about 2,580 miles) -> about 5.7 hours.
// -----------------------------------------------------------------------------
export function estimateFlightHours(a: Airport, b: Airport): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const miles = 2 * 3959 * Math.asin(Math.sqrt(h));
  return miles / 500 + 0.5;
}

// -----------------------------------------------------------------------------
// forecastUrls: remembers each airport's hourly-forecast URL (step 1), so we
// only ask /points once per airport while the server is running.
// -----------------------------------------------------------------------------
const forecastUrls = new Map<string, string>();

// -----------------------------------------------------------------------------
// fetchForecastHours: gets one airport's hourly forecast and keeps only the
// hours that overlap our window (from -> to).
// -----------------------------------------------------------------------------
async function fetchForecastHours(airport: Airport, from: Date, to: Date): Promise<ForecastHour[]> {
  // Step 1: find the hourly forecast URL for this airport.
  let url = forecastUrls.get(airport.code);
  if (!url) {
    const point = await nwsGet(`https://api.weather.gov/points/${airport.lat},${airport.lon}`);
    url = point.properties.forecastHourly as string;
    forecastUrls.set(airport.code, url);
  }

  // Step 2: get the hourly periods, and keep the ones inside our window.
  // Each period lasts one hour, so it overlaps if it starts before `to`
  // and ends after `from`.
  const forecast = await nwsGet(url);
  const periods: ForecastHour[] = forecast.properties.periods ?? [];
  return periods.filter((p) => {
    const start = Date.parse(p.startTime);
    return start < to.getTime() && start + HOUR_MS > from.getTime();
  });
}

// -----------------------------------------------------------------------------
// getForecast: the main forecast function, called by index.ts.
// It never throws: problems come back as status "skipped" or "error".
// -----------------------------------------------------------------------------
export async function getForecast(trip: Trip): Promise<SourceResult> {
  if (trip.hoursAway > 156) {
    return notOkResult(FORECAST_NAME, "skipped", "The NWS hourly forecast only goes about 6 days ahead. Check again closer to your trip.");
  }

  try {
    // Work out the landing time, and a window around each moment:
    // from 1 hour before to 2 hours after.
    const flightHours = estimateFlightHours(trip.origin, trip.destination);
    const departure = trip.departureUtc;
    const arrival = new Date(departure.getTime() + flightHours * HOUR_MS);
    const before = (t: Date) => new Date(t.getTime() - HOUR_MS);
    const after = (t: Date) => new Date(t.getTime() + 2 * HOUR_MS);

    // Ask about both airports at the same time (like CompletableFuture.allOf).
    const [originHours, destinationHours] = await Promise.all([
      fetchForecastHours(trip.origin, before(departure), after(departure)),
      fetchForecastHours(trip.destination, before(arrival), after(arrival)),
    ]);

    const findings = [
      ...scoreForecast(trip.origin.code, "around departure", originHours),
      ...scoreForecast(trip.destination.code, "around arrival", destinationHours),
    ];
    return okResult(FORECAST_NAME, findings, `Estimated flight time: about ${flightHours.toFixed(1)} hours.`);
  } catch (err) {
    return notOkResult(FORECAST_NAME, "error", errorMessage(err, "the National Weather Service"));
  }
}

// =============================================================================
// PART 4: NWS ACTIVE ALERTS (official weather warnings)
// /alerts/active?point={lat},{lon} returns every warning, watch and advisory
// currently issued for that spot.
// =============================================================================

const ALERTS_NAME = "Weather warnings (NWS)";
const ALERTS_MAX_HOURS = 72; // warnings are only issued a few days ahead

// Warning types that rarely affect flights. Still shown, but always as "low".
const LOW_IMPACT_WORDS = ["rip current", "beach", "small craft", "marine", "air quality", "coastal", "surf", "hazardous seas", "gale"];

// -----------------------------------------------------------------------------
// NwsAlert: the fields we use from each alert.
// onset/ends are when the weather itself starts and stops; effective/expires
// are about the message. We prefer onset/ends and fall back to the others.
// -----------------------------------------------------------------------------
export interface NwsAlert {
  event: string; // e.g. "Winter Storm Warning"
  severity: string; // "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown"
  onset?: string | null;
  ends?: string | null;
  effective?: string | null;
  expires?: string | null;
}

// -----------------------------------------------------------------------------
// scoreAlerts: turns one airport's alerts into findings. Rules:
//   - ignore alerts not in force at the departure time
//   - Extreme or Severe -> high, Moderate -> medium, anything else -> low
//   - beach, sea and air-quality alerts -> always low
//   - skip duplicates (the same alert can be issued more than once)
// If a start or end time is missing, we assume the alert might apply:
// it's safer to show a warning than to hide one.
// -----------------------------------------------------------------------------
export function scoreAlerts(code: string, alerts: NwsAlert[], departure: Date): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const alert of alerts) {
    const startText = alert.onset ?? alert.effective;
    const endText = alert.ends ?? alert.expires;
    const starts = startText ? Date.parse(startText) : NaN;
    const ends = endText ? Date.parse(endText) : NaN;
    if (!Number.isNaN(starts) && departure.getTime() < starts) continue; // starts after we leave
    if (!Number.isNaN(ends) && departure.getTime() > ends) continue; // over before we leave

    if (seen.has(alert.event)) continue;
    seen.add(alert.event);

    let severity: Severity =
      alert.severity === "Extreme" || alert.severity === "Severe" ? "high" : alert.severity === "Moderate" ? "medium" : "low";
    if (LOW_IMPACT_WORDS.some((word) => alert.event.toLowerCase().includes(word))) severity = "low";

    findings.push({ severity, text: `${code}: ${alert.event}` });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// fetchAlerts: one airport's active alerts. Each alert's details are in
// features[i].properties, so we pull those out.
// -----------------------------------------------------------------------------
async function fetchAlerts(airport: Airport): Promise<NwsAlert[]> {
  const body = await nwsGet(`https://api.weather.gov/alerts/active?status=actual&point=${airport.lat},${airport.lon}`);
  return (body.features ?? []).map((f: { properties: NwsAlert }) => f.properties);
}

// -----------------------------------------------------------------------------
// getAlerts: the main alerts function, called by index.ts. Never throws.
// -----------------------------------------------------------------------------
export async function getAlerts(trip: Trip): Promise<SourceResult> {
  if (trip.hoursAway > ALERTS_MAX_HOURS) {
    return notOkResult(ALERTS_NAME, "skipped", `Warnings are only issued a few days ahead, so they're checked for flights within ${ALERTS_MAX_HOURS} hours.`);
  }

  try {
    const [originAlerts, destinationAlerts] = await Promise.all([fetchAlerts(trip.origin), fetchAlerts(trip.destination)]);
    const findings = [
      ...scoreAlerts(trip.origin.code, originAlerts, trip.departureUtc),
      ...scoreAlerts(trip.destination.code, destinationAlerts, trip.departureUtc),
    ];
    if (findings.length === 0) {
      return okResult(ALERTS_NAME, [{ severity: "low", text: "No weather warnings at either airport at departure time" }]);
    }
    return okResult(ALERTS_NAME, findings);
  } catch (err) {
    return notOkResult(ALERTS_NAME, "error", errorMessage(err, "the National Weather Service"));
  }
}

// =============================================================================
// PART 5: FAA NATIONAL AIRSPACE SYSTEM (NAS) STATUS
// https://nasstatus.faa.gov/api/airport-status-information
// One XML document listing every U.S. airport with a problem RIGHT NOW:
//   - Ground Stop Programs          -> flights to that airport held on the ground
//   - Ground Delay Programs         -> flights to that airport delayed on purpose
//   - General Arrival/Departure Delay Info
//   - Airport Closures
// Airports that aren't in the list have no reported problems.
// It's "right now" data, so we only use it for flights within 24 hours.
// =============================================================================

const FAA_NAME = "Airport status (FAA)";
const FAA_MAX_HOURS = 24;
const FAA_NEAR_HOURS = 6; // within 6 hours, "right now" is a strong signal
const FAA_CACHE_MS = 2 * 60_000; // the FAA updates every minute or two

// -----------------------------------------------------------------------------
// FaaEvent: one problem at one airport, simplified from the XML.
// -----------------------------------------------------------------------------
export interface FaaEvent {
  airport: string; // e.g. "SFO"
  type: string; // e.g. "Ground Stop Programs"
  reason: string; // e.g. "thunderstorms"
  details: Record<string, any>; // the rest of the fields (Avg, Max, End_Time...)
}

// -----------------------------------------------------------------------------
// minutes: turns the FAA's delay text into a number of minutes.
// "45 minutes" -> 45, "1 hour and 12 minutes" -> 72, "2 hours" -> 120.
// -----------------------------------------------------------------------------
export function minutes(text: unknown): number {
  if (typeof text !== "string") return 0;
  const hours = Number(text.match(/(\d+)\s*hour/)?.[1] ?? 0);
  const mins = Number(text.match(/(\d+)\s*minute/)?.[1] ?? 0);
  return hours * 60 + mins;
}

// -----------------------------------------------------------------------------
// PARTIAL_CLOSURE_WORDS: many "closures" in the FAA feed only restrict private
// or unusual aircraft, e.g. "CLSD TO NON SKED TRANSIENT GA ACFT" (closed to
// non-scheduled private planes). These don't affect airline flights.
// -----------------------------------------------------------------------------
const PARTIAL_CLOSURE_WORDS = ["NON SKED", "TRANSIENT", "GA ACFT", "WINGSPAN", "PPR"];

// -----------------------------------------------------------------------------
// scoreFaa: turns the FAA events for our two airports into findings. Rules:
//   - Ground stop                                -> high
//   - Airport closed                             -> high
//     (but a partial closure for private planes -> low)
//   - Ground delay program: average 60+ min -> high, otherwise medium
//   - Arrival/departure delays: up to 60+ min -> high, otherwise medium
// -----------------------------------------------------------------------------
export function scoreFaa(codes: string[], events: FaaEvent[]): Finding[] {
  const findings: Finding[] = [];

  for (const e of events) {
    if (!codes.includes(e.airport)) continue;
    const type = e.type.toLowerCase();
    const reason = e.reason ? ` (${e.reason})` : "";

    if (type.includes("ground stop")) {
      const until = e.details.End_Time ? `, expected to end ${e.details.End_Time}` : "";
      findings.push({ severity: "high", text: `${e.airport}: ground stop in effect${reason}${until}` });
    } else if (type.includes("closure")) {
      if (PARTIAL_CLOSURE_WORDS.some((w) => e.reason.toUpperCase().includes(w))) {
        findings.push({ severity: "low", text: `${e.airport}: partial closure for private or special aircraft only (airline flights not affected)` });
      } else {
        findings.push({ severity: "high", text: `${e.airport}: airport closed${reason}` });
      }
    } else if (type.includes("ground delay")) {
      const avg = minutes(e.details.Avg);
      findings.push({
        severity: avg >= 60 ? "high" : "medium",
        text: `${e.airport}: ground delay program${reason}, average delay ${e.details.Avg ?? "unknown"}`,
      });
    } else if (type.includes("arrival/departure")) {
      // Arrival_Departure can be one item or a list (arrivals and departures).
      const items = [e.details.Arrival_Departure].flat().filter(Boolean);
      const worst = Math.max(0, ...items.map((i: any) => minutes(i.Max)));
      const kinds = items.map((i: any) => String(i["@_Type"] ?? "").toLowerCase()).filter(Boolean).join(" and ") || "flight";
      findings.push({
        severity: worst >= 60 ? "high" : "medium",
        text: `${e.airport}: ${kinds} delays up to ${worst} min${reason}`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: "low", text: `No FAA delays, ground stops or closures reported at ${codes.join(" or ")} right now` });
  }
  return findings;
}

// -----------------------------------------------------------------------------
// findEvents: walks through the parsed XML and collects every item that has
// an <ARPT> (airport code), remembering which <Delay_type> it was under.
// Walking the whole tree means we don't depend on the exact nesting of each
// list type, which differs between delay types.
// -----------------------------------------------------------------------------
function findEvents(node: any, type: string, out: FaaEvent[]): void {
  if (Array.isArray(node)) {
    for (const child of node) findEvents(child, type, out);
    return;
  }
  if (node === null || typeof node !== "object") return;

  if (typeof node.ARPT === "string") {
    out.push({ airport: node.ARPT.trim().toUpperCase(), type, reason: String(node.Reason ?? "").trim(), details: node });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "Delay_type") {
      // Each Delay_type has a <Name>, e.g. "Ground Stop Programs".
      for (const delayType of [value].flat() as any[]) findEvents(delayType, String(delayType.Name ?? ""), out);
    } else {
      findEvents(value, type, out);
    }
  }
}

// -----------------------------------------------------------------------------
// fetchFaaEvents: downloads and parses the FAA feed, with a 2-minute cache.
// fast-xml-parser turns the XML into ordinary JavaScript objects.
// ignoreAttributes: false keeps attributes like Type="Departure"
// (they appear as "@_Type"). parseTagValue: false keeps every value as text,
// so a code like "123" isn't turned into a number.
// -----------------------------------------------------------------------------
let faaCache: { expires: number; events: FaaEvent[] } | null = null;

async function fetchFaaEvents(): Promise<FaaEvent[]> {
  if (faaCache && faaCache.expires > Date.now()) return faaCache.events;

  const res = await fetch("https://nasstatus.faa.gov/api/airport-status-information", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FAA: HTTP ${res.status}`);
  const xml = await res.text();

  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  const events: FaaEvent[] = [];
  findEvents(parsed, "", events);

  faaCache = { expires: Date.now() + FAA_CACHE_MS, events };
  return events;
}

// -----------------------------------------------------------------------------
// getFaaStatus: the main FAA function, called by index.ts. Never throws.
// -----------------------------------------------------------------------------
export async function getFaaStatus(trip: Trip): Promise<SourceResult> {
  if (trip.hoursAway > FAA_MAX_HOURS) {
    return notOkResult(FAA_NAME, "skipped", `FAA status shows what's happening right now, so it's only used for flights within ${FAA_MAX_HOURS} hours.`);
  }

  try {
    const events = await fetchFaaEvents();
    let findings = scoreFaa([trip.origin.code, trip.destination.code], events);

    let message: string | undefined;
    if (trip.hoursAway > FAA_NEAR_HOURS) {
      findings = capAtMedium(findings);
      message = "This is the status right now, so for a flight more than 6 hours away the rating is capped at medium.";
    }
    return okResult(FAA_NAME, findings, message);
  } catch (err) {
    return notOkResult(FAA_NAME, "error", errorMessage(err, "the FAA"));
  }
}
