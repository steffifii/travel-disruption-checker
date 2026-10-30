// =============================================================================
// airports.ts
// The list of U.S. airports, and the search behind the "type a city or code"
// box in the app.
//
// The data (src/data/us-airports.json) has 1,777 U.S. airports with a 3-letter
// code, coordinates and time zone. It comes from the free, MIT-licensed
// "Airports" dataset on GitHub: https://github.com/mwgg/Airports
// It's stored inside the project, so the app doesn't need to download it.
// =============================================================================

import { readFileSync } from "node:fs";

// -----------------------------------------------------------------------------
// Airport: the shape of one airport (like a Java DTO class).
// lat/lon are used to ask the weather APIs about that location.
// timezone is used to work out the exact moment of a local departure time.
// -----------------------------------------------------------------------------
export interface Airport {
  code: string; // e.g. "JFK"
  name: string; // e.g. "John F Kennedy International Airport"
  city: string; // e.g. "New York"
  state: string; // e.g. "New York"
  lat: number;
  lon: number;
  timezone: string; // e.g. "America/New_York"
}

// -----------------------------------------------------------------------------
// AIRPORTS: read the JSON file once, when the server starts.
// `import.meta.url` is this file's location, so the path works no matter
// which folder you start the server from.
// -----------------------------------------------------------------------------
export const AIRPORTS: Airport[] = JSON.parse(
  readFileSync(new URL("./data/us-airports.json", import.meta.url), "utf8")
);

// -----------------------------------------------------------------------------
// BY_CODE: a lookup table from code to airport, like a Java HashMap.
// Finding "JFK" is instant instead of checking all 1,777 airports.
// -----------------------------------------------------------------------------
const BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

// -----------------------------------------------------------------------------
// findAirport: get one airport by its code, e.g. findAirport("jfk").
// Returns undefined if there's no such code (like returning null in Java).
// -----------------------------------------------------------------------------
export function findAirport(code: string): Airport | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

// -----------------------------------------------------------------------------
// MAJOR_AIRPORTS: the busiest U.S. airports, roughly busiest first.
// The dataset has no passenger numbers, so without this list, typing "Chicago"
// could show a small airfield before O'Hare. These move to the top of the
// results, and an earlier position in the list ranks higher (ORD before MDW).
// -----------------------------------------------------------------------------
const MAJOR_AIRPORTS = [
  "ATL", "DFW", "DEN", "ORD", "LAX", "JFK", "LAS", "MCO", "MIA", "CLT", "SEA", "PHX", "EWR", "SFO", "IAH",
  "BOS", "FLL", "MSP", "LGA", "DTW", "PHL", "SLC", "BWI", "DCA", "SAN", "IAD", "TPA", "BNA", "AUS", "MDW",
  "HNL", "DAL", "PDX", "STL", "HOU", "SMF", "MSY", "RDU", "SJC", "OAK", "SNA", "MCI", "SAT", "CLE", "PIT",
  "IND", "CMH", "CVG", "ANC", "OGG",
];

// MAJOR_BONUS: code -> extra score. The busiest gets about 10.5, the last 10.
const MAJOR_BONUS = new Map(MAJOR_AIRPORTS.map((code, i) => [code, 10 + (MAJOR_AIRPORTS.length - i) / 100]));

// -----------------------------------------------------------------------------
// searchAirports: what the airport box calls as you type.
// Each airport gets a score for how well it matches the typed text:
//   100 = the code matches exactly        ("jfk"  -> JFK)
//    80 = the city starts with the text   ("chic" -> Chicago)
//    60 = the airport name starts with it ("o'ha" -> O'Hare)
//    40 = the city, name or state contains it anywhere
// Major airports get a bonus (see MAJOR_BONUS). Results are sorted best
// first, and the top 8 are returned.
// -----------------------------------------------------------------------------
export function searchAirports(query: string, limit = 8): Airport[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const matches: { airport: Airport; score: number }[] = [];

  for (const a of AIRPORTS) {
    const city = a.city.toLowerCase();
    const name = a.name.toLowerCase();
    let score = 0;

    if (a.code.toLowerCase() === q) score = 100;
    else if (city.startsWith(q)) score = 80;
    else if (name.startsWith(q)) score = 60;
    else if (city.includes(q) || name.includes(q) || a.state.toLowerCase().includes(q)) score = 40;

    if (score > 0) {
      score += MAJOR_BONUS.get(a.code) ?? 0;
      matches.push({ airport: a, score });
    }
  }

  return matches
    .sort((x, y) => y.score - x.score || x.airport.city.localeCompare(y.airport.city))
    .slice(0, limit)
    .map((m) => m.airport);
}
