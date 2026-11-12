// =============================================================================
// test/sources.test.ts
// Automated tests for the scoring rules, dates and airport search.
// Run with:  npm test   (inside the server folder)
//
// Uses Node's built-in test runner, similar to JUnit:
// each test(...) is like a @Test method, and assert is like Assertions.
// These tests never call the real APIs; they use sample data.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minutes, scoreAlerts, scoreFaa, scoreForecast, windMph, worstSeverity,
  type FaaEvent, type ForecastHour,
} from "../src/sources";
import { checkFlightTimes, flightHours, isValidDate, isValidTime, localToUtc } from "../src/time";
import { findAirport, searchAirports } from "../src/airports";

// -----------------------------------------------------------------------------
// Helper that builds one sample forecast hour. `...overrides` replaces just
// the fields a test cares about.
// -----------------------------------------------------------------------------
function hour(overrides: Partial<ForecastHour> = {}): ForecastHour {
  return {
    startTime: "2026-10-31T09:00:00-04:00",
    temperature: 60,
    windSpeed: "10 mph",
    shortForecast: "Mostly Sunny",
    probabilityOfPrecipitation: { value: 0 },
    ...overrides,
  };
}

// ----- Combining ---------------------------------------------------------------
test("worst source wins", () => {
  assert.equal(worstSeverity(["low", "high", "medium"]), "high");
  assert.equal(worstSeverity(["low", "medium"]), "medium");
  assert.equal(worstSeverity([]), "low");
});

// ----- NWS forecast -----------------------------------------------------------
test("wind text is read correctly", () => {
  assert.equal(windMph("10 mph"), 10);
  assert.equal(windMph("10 to 15 mph"), 15);
  assert.equal(windMph(""), 0);
});

test("calm weather is low", () => {
  const result = scoreForecast("JFK", "around departure", [hour(), hour()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "low");
});

test("likely thunderstorms are high, a small chance is medium", () => {
  const likely = scoreForecast("JFK", "x", [hour({ shortForecast: "Showers And Thunderstorms Likely", probabilityOfPrecipitation: { value: 70 } })]);
  const slight = scoreForecast("JFK", "x", [hour({ shortForecast: "Slight Chance Showers And Thunderstorms", probabilityOfPrecipitation: { value: 20 } })]);
  assert.equal(likely[0].severity, "high");
  assert.equal(slight[0].severity, "medium");
});

test("freezing rain is high, fog is medium", () => {
  assert.equal(scoreForecast("DEN", "x", [hour({ shortForecast: "Freezing Rain" })])[0].severity, "high");
  assert.equal(scoreForecast("SFO", "x", [hour({ shortForecast: "Patchy Fog" })])[0].severity, "medium");
});

test("wind: 25 mph is medium, 35 mph is high", () => {
  assert.equal(scoreForecast("ORD", "x", [hour({ windSpeed: "20 to 28 mph" })])[0].severity, "medium");
  assert.equal(scoreForecast("ORD", "x", [hour({ windSpeed: "35 mph" })])[0].severity, "high");
});

test("no forecast hours yet gives a clear low finding", () => {
  const result = scoreForecast("JFK", "around arrival", []);
  assert.equal(result[0].severity, "low");
  assert.ok(result[0].text.includes("no hourly forecast yet"));
});

// ----- NWS alerts -------------------------------------------------------------
test("a severe warning in force at departure is high", () => {
  const departure = new Date("2026-10-31T12:00:00Z");
  const result = scoreAlerts("JFK", [
    { event: "Winter Storm Warning", severity: "Severe", onset: "2026-10-31T06:00:00-04:00", ends: "2026-11-01T06:00:00-04:00" },
  ], [departure]);
  assert.equal(result[0].severity, "high");
});

test("alerts that end before departure, or start after it, are ignored", () => {
  const departure = new Date("2026-10-31T12:00:00Z");
  const result = scoreAlerts("JFK", [
    { event: "Wind Advisory", severity: "Moderate", ends: "2026-10-30T20:00:00-04:00" },
    { event: "Flood Watch", severity: "Severe", onset: "2026-11-01T06:00:00-04:00" },
  ], [departure]);
  assert.equal(result.length, 0);
});

test("at the arrival airport, an alert that starts after take-off but before landing is caught", () => {
  const departure = new Date("2026-10-31T13:00:00Z"); // 9:00 New York
  const arrival = new Date("2026-10-31T19:30:00Z"); // 12:30 San Francisco
  const stormFromNoon = { event: "High Wind Warning", severity: "Severe", onset: "2026-10-31T12:00:00-07:00", ends: "2026-10-31T20:00:00-07:00" };
  assert.equal(scoreAlerts("SFO", [stormFromNoon], [departure]).length, 0); // missed if we only check take-off
  assert.equal(scoreAlerts("SFO", [stormFromNoon], [departure, arrival])[0].severity, "high"); // caught at landing
});

test("beach and sea alerts are always low, and duplicates are removed", () => {
  const result = scoreAlerts("SFO", [
    { event: "Small Craft Advisory", severity: "Severe" },
    { event: "Small Craft Advisory", severity: "Severe" },
  ], [new Date()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "low");
});

// ----- FAA status -------------------------------------------------------------
// These events match the real FAA feed format (fetched on 30 Oct 2026).
const faaEvents: FaaEvent[] = [
  { airport: "SAN", type: "Ground Delay Programs", reason: "airport volume", details: { Avg: "32 minutes", Max: "56 minutes" } },
  { airport: "LAS", type: "General Arrival/Departure Delay Info", reason: "WX:Thunderstorms", details: { Arrival_Departure: { "@_Type": "Departure", Min: "31 minutes", Max: "45 minutes" } } },
  { airport: "LAX", type: "Airport Closures", reason: "!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT", details: {} },
  { airport: "ORD", type: "Ground Stop Programs", reason: "thunderstorms", details: { End_Time: "7:45 pm CDT" } },
];

test("FAA delay text is turned into minutes", () => {
  assert.equal(minutes("45 minutes"), 45);
  assert.equal(minutes("1 hour and 12 minutes"), 72);
  assert.equal(minutes("2 hours"), 120);
});

test("a ground stop is high", () => {
  const result = scoreFaa(["ORD", "JFK"], faaEvents);
  assert.equal(result[0].severity, "high");
  assert.ok(result[0].text.includes("ground stop"));
});

test("a ground delay program averaging 32 minutes is medium", () => {
  assert.equal(scoreFaa(["SAN"], faaEvents)[0].severity, "medium");
});

test("departure delays up to 45 minutes are medium", () => {
  const result = scoreFaa(["LAS"], faaEvents);
  assert.equal(result[0].severity, "medium");
  assert.ok(result[0].text.includes("departure delays up to 45 min"));
});

test("a closure for private planes only is low", () => {
  assert.equal(scoreFaa(["LAX"], faaEvents)[0].severity, "low");
});

test("airports not in the FAA list have no problems", () => {
  const result = scoreFaa(["JFK", "SFO"], faaEvents);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "low");
});

// ----- Dates and times --------------------------------------------------------
test("impossible dates are rejected", () => {
  assert.equal(isValidDate("2026-02-31"), false);
  assert.equal(isValidDate("2026-13-01"), false);
  assert.equal(isValidDate("2028-02-29"), true); // leap year
});

test("times must be 24-hour HH:MM", () => {
  assert.equal(isValidTime("09:30"), true);
  assert.equal(isValidTime("24:00"), false);
  assert.equal(isValidTime("9:30"), false);
});

test("local time converts to UTC, including daylight saving", () => {
  assert.equal(localToUtc("2026-10-31", "08:00", "America/New_York").toISOString(), "2026-10-31T12:00:00.000Z"); // summer time
  assert.equal(localToUtc("2026-11-02", "08:00", "America/New_York").toISOString(), "2026-11-02T13:00:00.000Z"); // winter time
  assert.equal(localToUtc("2026-11-02", "08:00", "America/Los_Angeles").toISOString(), "2026-11-02T16:00:00.000Z");
});

// ----- Airports ---------------------------------------------------------------
test("airports can be found by code and searched by city", () => {
  assert.equal(findAirport("jfk")?.city, "New York");
  assert.equal(searchAirports("SFO")[0].code, "SFO");
  assert.equal(searchAirports("chicago")[0].code, "ORD");
});

// ----- Departure and arrival times --------------------------------------------
test("flight length uses each airport's own time zone", () => {
  const departure = localToUtc("2026-11-10", "09:00", "America/New_York");
  const arrival = localToUtc("2026-11-10", "12:30", "America/Los_Angeles");
  assert.equal(flightHours(departure, arrival), 6.5);
  assert.equal(checkFlightTimes(departure, arrival, "San Francisco"), null);
});

test("an overnight (red-eye) flight landing the next day is accepted", () => {
  const departure = localToUtc("2026-11-10", "22:00", "America/Los_Angeles");
  const arrival = localToUtc("2026-11-11", "06:30", "America/New_York");
  assert.equal(flightHours(departure, arrival), 5.5);
  assert.equal(checkFlightTimes(departure, arrival, "New York"), null);
});

test("impossible flight times are rejected", () => {
  const departure = localToUtc("2026-11-10", "09:00", "America/New_York");
  // 5:30 in San Francisco is 8:30 in New York: before take-off.
  assert.ok(checkFlightTimes(departure, localToUtc("2026-11-10", "05:30", "America/Los_Angeles"), "San Francisco")?.includes("San Francisco local time"));
  // Wrong arrival date: more than 24 hours.
  assert.ok(checkFlightTimes(departure, localToUtc("2026-11-12", "12:30", "America/Los_Angeles"), "San Francisco")?.includes("24 hours"));
  // Less than 15 minutes.
  assert.ok(checkFlightTimes(departure, localToUtc("2026-11-10", "06:10", "America/Los_Angeles"), "San Francisco")?.includes("15 minutes"));
});
