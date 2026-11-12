# Trip Disruption Checker

A prototype that gives an Operations team **one place** to check whether a U.S. trip could be disrupted, the **evidence** behind each risk, and **what action to take**.

Enter a route and the flight's departure and arrival times from the booking (for example *New York JFK → San Francisco SFO, tomorrow, departing 9:00am and arriving 12:30pm*). The app checks official U.S. government sources and returns:

- an overall risk: **Low**, **Medium** or **High**
- the evidence from each source, with the rule that triggered it
- a recommended action
- when each source was checked, and which sources couldn't be checked and why

---

## 1. The problem

Employees travel frequently across the U.S. To know whether a trip might be disrupted today, someone has to check weather forecasts, weather warnings and airport status, each on a different website, and then decide what it means for this particular trip.

I broke the problem into three questions:

1. **What could disrupt a U.S. flight?** Mainly weather at either end (storms, snow, ice, fog, strong wind), and problems at the airports themselves (ground stops, delay programs, closures).
2. **Where is the most reliable, freely available data for each?** The National Weather Service (NWS) for weather, and the Federal Aviation Administration (FAA) for airport operations.
3. **How do we turn that data into a decision someone can act on?** With simple rules that are clear and explainable: every rating can be traced back to a specific piece of evidence.

---

## 2. Data sources

| Source | Provider | What it tells us | Used when the flight is |
|---|---|---|---|
| Hourly forecast | NWS (`api.weather.gov`) | Weather at the departure airport around take-off, and at the arrival airport around landing | Within about 6 days |
| Active alerts | NWS (`api.weather.gov`) | Official warnings, watches and advisories in force at take-off (both airports) or at landing (arrival airport) | Within 72 hours |
| Airport status | FAA (`nasstatus.faa.gov`) | Ground stops, ground delay programs, arrival/departure delays and closures happening now | Within 24 hours |

That's **three sources from two independent providers**. All are free, official and need **no API key**.

Each source is only used when it can say something useful. A forecast for a flight two weeks away isn't available yet, and today's airport status says little about a flight next week. When a source is skipped, the app says why instead of hiding it.

---

## 3. How to run it

You need **Node.js 20 or newer** (https://nodejs.org). Check with `node -v`.

**Terminal 1: backend**

```bash
cd server
npm install
copy .env.example .env      # Windows. On Mac/Linux: cp .env.example .env
npm run dev
```

In `server/.env`, put a contact email in `NWS_USER_AGENT`; the National Weather Service asks every app to identify itself. Wait for `API server running at http://localhost:3001`, and leave the terminal open.

**Terminal 2: frontend**

```bash
cd client
npm install
npm run dev
```

Open **http://localhost:5173**. Type a city or airport code in **From** and **To** (for example New York → San Francisco, the brief's example), then enter the departure and arrival dates and times from the booking, each in its own airport's local time.

**Tests**

```bash
cd server
npm test
```

There are 24 automated tests covering the scoring rules, date and time-zone handling, departure and arrival time checks, and airport search.

---

## 4. How it works

```
Browser: React app (port 5173)
   │   POST /api/assess   { origin: "JFK", destination: "SFO",
   │                        date: "2026-10-31", time: "09:00",               (New York time)
   │                        arrivalDate: "2026-10-31", arrivalTime: "12:30" } (San Francisco time)
   ▼
Express backend (port 3001)
   1. Validate the input (real airports, different airports, valid date and time)
   2. Convert both local times to exact UTC moments, using each airport's time zone; work out the hours
      until departure; check the arrival is after departure and the flight takes 15 minutes to 24 hours
   3. Ask all three sources at the same time
        ├─ NWS hourly forecast
        ├─ NWS active alerts
        └─ FAA airport status
   4. Score each source, then combine: overall risk = the worst level from any source that answered
   ▼
Result: overall risk, recommended action, one card of evidence per source
```

**Design choices in the code:**

- **One common shape for every source.** Each returns a name, status (`ok`, `skipped` or `error`), risk level, findings and a message. Combining them doesn't depend on which API the data came from, and adding a fourth source means adding one function.
- **Each source handles its own errors.** If one service is down, the others still give a result, and the page says the result is incomplete.
- **Fetching and scoring are separate.** Each source has a function that calls the API, and a separate scoring function that is pure logic with no network calls. The scoring is what decides the risk, so it's the part covered by tests.
- **The backend calls the external services, not the browser.** This avoids browser cross-origin (CORS) restrictions and keeps all the logic in one place.

### Files

```
server/                       Backend: Node.js + Express + TypeScript
  src/index.ts                Server, API routes, input validation, combining the sources
  src/sources.ts              The three sources and their scoring rules
  src/airports.ts             U.S. airport list and the airport search
  src/time.ts                 Date, time and time-zone helpers
  src/data/us-airports.json   1,777 U.S. airports with codes, coordinates and time zones
  test/sources.test.ts        Automated tests

client/                       Frontend: React + TypeScript + Bootstrap (run with Vite)
  src/App.tsx                 The page: trip form and results
  src/AirportPicker.tsx       Type-to-search airport box
  src/main.tsx                Starts React and loads Bootstrap
  vite.config.ts              Forwards /api requests to the backend
```

**Our backend's API routes:**

| Route | Purpose |
|---|---|
| `GET /api/airports/search?q=chic` | Airport search as you type |
| `POST /api/assess` | Assess a trip |

---

## 5. Scoring rules

**NWS forecast:** every hour from 1 hour before to 2 hours after take-off at the departure airport, and the same around landing at the arrival airport.

| Condition | Risk |
|---|---|
| Blizzard, freezing rain or drizzle, sleet, ice, heavy snow | High |
| Thunderstorms with 50%+ chance of precipitation | High |
| Thunderstorms with a lower chance | Medium |
| Snow, fog, heavy rain | Medium |
| Wind 35+ mph | High |
| Wind 25+ mph | Medium |

**NWS alerts:** only those in force at take-off (at either airport) or at landing (at the arrival airport). Bad weather at the destination can hold a flight on the ground before it leaves, or meet it when it lands.

| Condition | Risk |
|---|---|
| Severity "Extreme" or "Severe" | High |
| Severity "Moderate" | Medium |
| Anything else | Low |
| Beach, marine or air-quality alerts (rarely affect flights) | Always low |

**FAA airport status:** at either airport.

| Condition | Risk |
|---|---|
| Ground stop | High |
| Airport closed | High |
| Partial closure that only affects private or special aircraft | Low |
| Ground delay program averaging 60+ minutes | High, otherwise Medium |
| Arrival/departure delays of up to 60+ minutes | High, otherwise Medium |
| Flight more than 6 hours away | High is lowered to Medium, because this is the status right now |

**Overall risk and action:**

| Overall | Recommended action |
|---|---|
| Low | No significant disruptions found. |
| Medium | Some conditions could cause delays. Keep an eye on the flight status. |
| High | Serious disruptions are likely. Check with the airline and consider a backup plan. |

The overall risk is the **worst level from any source that answered**. One serious problem is enough to warn the traveller, and the evidence shows which source raised it.

---

## 6. Decisions and trade-offs

| Decision | Why | Alternatives I considered |
|---|---|---|
| **Official U.S. sources (NWS, FAA)** | The brief is about U.S. travel; these are the authoritative sources, free, with no keys or monthly limits | **Open-Meteo:** free and worldwide, but not the official U.S. source. **WeatherAPI.com:** needs a key, and alerts are "limited" on the free plan. **AviationStack:** flight-level data, but only 100 requests a month, and no future flights on the free plan. |
| **Rule-based scoring, not an AI model** | Every rating is explainable, testable and gives the same result every time. For an Operations team, being able to see why matters more than a clever answer. | Asking an AI model to judge the risk. It could catch things like strikes in the news, but its answers can't be traced or tested, and they may change from one run to the next. |
| **Date and time, not just date** | "Tomorrow" could mean 13 or 47 hours away. The time lets us check the weather at the hours that matter, and decide which sources are relevant. | Date only: simpler, but it can only judge the whole day. |
| **Arrival time required** | The traveller knows their real landing time from the booking, so the app can check the arrival airport at the right moment. | Estimating it from distance (my first version): one field less, but it ignores schedules and connections. |
| **Worst source wins** | Cautious and easy to explain. | A points system: more nuanced, but needs tuning data I don't have. |
| **No fake or sample data** | If a source can't answer, the app says so. A prototype shouldn't show data that looks real but isn't. | Showing sample data when a source is unavailable. |
| **Type-to-search airports** | Covers all 1,777 U.S. airports, with the busiest listed first. | A fixed dropdown of about 40 major airports. |
| **Few, well-commented files** | Easy to read and review. | One file per concern: tidier at scale, but more to navigate in a prototype. |

## 7. Assumptions

- Trips are **flights between U.S. airports**.
- The traveller **knows both times** from the booking. The departure time is local to the departure airport, and the arrival time is local to the arrival airport, as on a booking. Each has its own date, for overnight flights. Time zones and daylight saving time are handled.
- A real flight takes **between 15 minutes and 24 hours**; anything else is treated as a typing mistake.
- **Weather at the two airports** matters most. Weather along the route isn't checked.
- **FAA status is "right now"**, so it's a strong signal for flights in the next few hours, and only a hint for later ones.

## 8. Limitations

- The NWS hourly forecast only goes about **6 days ahead**.
- There's **no flight-specific data**: the app doesn't know about a particular flight's delay or cancellation, or about airline issues such as crew shortages, strikes or IT outages.
- The thresholds are **sensible starting values**, not tuned against historical delay data.
- The airport ranking uses a **hand-written list of the busiest airports**, because the dataset has no passenger numbers.

---

## 9. How I used AI

I used **Claude** (Anthropic's AI assistant) as a development partner throughout:

- **Planning:** breaking down the brief, and comparing possible data sources, including their free-tier limits, coverage and trade-offs.
- **Decisions:** Claude laid out options and trade-offs, and **I made the calls**: U.S.-only official sources, date and time input, "worst source wins", no fake data, type-to-search airports, U.S. units and a small number of files.
- **Code:** Claude generated the code and comments to match those decisions, in a stack I chose (React, TypeScript, Express, Bootstrap).
- **Checking:** the scoring rules and time checks are covered by 24 automated tests. The FAA parsing was tested against the real FAA feed format, and the full app was run end to end in a browser.

**Where I didn't use AI:** the app itself doesn't use AI to judge risk. That was a deliberate choice, for the reasons in section 6.

**What I watched for:** AI-generated code can invent API endpoints or field names. Each source can be checked directly in a browser:

- NWS forecast grid for JFK: https://api.weather.gov/points/40.6398,-73.7789
- NWS alerts at JFK: https://api.weather.gov/alerts/active?point=40.6398,-73.7789
- FAA status: https://nasstatus.faa.gov/api/airport-status-information

---

## 10. What I'd change before real users

**Better predictions**
- Let users enter a **flight number**, using a flight-schedule API (a paid service in production), to get real departure and arrival times and that flight's own status.
- **Tune the thresholds** against historical FAA delay data and NWS observations.
- Check **weather along the route**, and add sources for non-weather risks (airline operations, strikes, major events).

**Reliability**
- A shared cache (e.g. Redis), retries with backoff for every source, and timeouts and fallbacks.
- Logging, monitoring and alerts when a source fails, so the Operations team knows when the tool is blind.

**Security and operations**
- HTTPS, rate limiting, input limits and sign-in for employees.
- Deployment with health checks, and a production build instead of development servers.

**Product**
- Save trips and **notify travellers automatically** when the risk changes, instead of them having to check.
- A dashboard for the Operations team showing every employee's upcoming trips.
- Accessibility testing, end-to-end UI tests, and user feedback from the Operations team.

---

## Credits

- Weather forecast and alerts: [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
- Airport status: [FAA National Airspace System Status](https://nasstatus.faa.gov)
- Airport data: [mwgg/Airports](https://github.com/mwgg/Airports) (MIT licence)
- Libraries: Express, dotenv, fast-xml-parser, React, Bootstrap, Vite, TypeScript, tsx
