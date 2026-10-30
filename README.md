# Trip Disruption Checker

Enter a U.S. flight route and a departure date and time (for example New York JFK → San Francisco SFO, tomorrow at 9:00am). The app checks three official U.S. government sources and rates the risk of disruption as **Low**, **Medium** or **High**, with the reasons.

| Source | What it tells us | Used when the flight is |
|---|---|---|
| **NWS hourly forecast** (National Weather Service) | The weather at the departure airport around take-off, and at the arrival airport around the estimated landing time | Within about 6 days |
| **NWS alerts** (National Weather Service) | Official weather warnings in force at either airport at departure time | Within 72 hours |
| **FAA airport status** (Federal Aviation Administration) | Ground stops, ground delay programs, delays and closures happening right now | Within 24 hours |

All three are **free and need no API key**.

---

## How to run it

You need **Node.js 20 or newer** (https://nodejs.org). Check with `node -v`.

### 1. Start the backend (terminal 1)

```bash
cd server
npm install
copy .env.example .env      # Windows. On Mac/Linux: cp .env.example .env
```

Open `server/.env` and put your email in `NWS_USER_AGENT`. The National Weather Service asks apps to identify themselves. Then:

```bash
npm run dev
```

Wait for `API server running at http://localhost:3001`. **Leave this terminal open.**

### 2. Start the frontend (terminal 2)

Open a second terminal (the **+** in VS Code's terminal panel):

```bash
cd client
npm install
npm run dev
```

Wait for `Local: http://localhost:5173/`, then open **http://localhost:5173** in your browser.

### 3. Run the tests (optional)

In the `server` folder: `npm test`. All 21 tests should pass.

### 4. Check the sources yourself

Open these in your browser to see the raw data:

- NWS forecast grid for JFK: https://api.weather.gov/points/40.6398,-73.7789 (the `forecastHourly` link inside gives the hourly forecast)
- NWS alerts at JFK: https://api.weather.gov/alerts/active?point=40.6398,-73.7789
- FAA status for all U.S. airports: https://nasstatus.faa.gov/api/airport-status-information

---

## How it works

```
Browser: React app (port 5173)
   │   POST /api/assess   { origin: "JFK", destination: "SFO", date, time }
   ▼
Vite forwards /api requests ──►  Express backend (port 3001)
                                   1. Check the input
                                   2. Local departure time → exact UTC moment → hours away
                                   3. Ask all three sources at the same time
                                        ├─ NWS hourly forecast
                                        ├─ NWS alerts
                                        └─ FAA airport status
                                   4. Overall risk = the worst level from any source that answered
```

- Every source returns the **same shape** (name, status, risk level, findings, message), so they can be combined the same way.
- Every source **handles its own errors**. If one service is down, you still get a result from the others, with a note saying it's incomplete.
- The **backend** calls the services, not the browser. This avoids browser security (CORS) problems, and keeps all the logic in one place.

### The files

```
server/                     Backend: Node.js + Express + TypeScript
  src/index.ts              Starts the server; API routes; combines the sources
  src/sources.ts            The three sources and their scoring rules
  src/airports.ts           U.S. airport list and the search behind the airport box
  src/time.ts               Date, time and time-zone helpers
  src/data/us-airports.json 1,777 U.S. airports with codes, coordinates and time zones
  test/sources.test.ts      Automated tests
  .env.example              Template for your settings

client/                     Frontend: React + TypeScript + Bootstrap (run with Vite)
  src/main.tsx              Starts React and loads Bootstrap
  src/App.tsx               The page: trip form and results
  src/AirportPicker.tsx     The "type a city or code" airport box
  vite.config.ts            Forwards /api requests to the backend
```

**Libraries used:** Express (web server), dotenv (reads `.env`), fast-xml-parser (reads the FAA's XML), React, Bootstrap, Vite, TypeScript and tsx.

### Java comparison

| Here | In Java |
|---|---|
| Node.js | The JVM: it runs the code |
| Express | A lightweight Spring Boot: web routes and JSON |
| `package.json` + `npm install` | `pom.xml` + `mvn install` |
| `app.post("/api/assess", ...)` | `@PostMapping("/api/assess")` |
| `interface` | A DTO class |
| `Promise.all([...])` | `CompletableFuture.allOf(...)` |
| `.env` | `application.properties` |
| `Map` / `Set` | `HashMap` / `HashSet` |
| `node:test` + `assert` | JUnit + Assertions |

---

## Scoring rules

**NWS forecast:** every hour from 1 hour before to 2 hours after departure, and the same around the estimated arrival. Based on the NWS's own forecast wording.
- Blizzard, freezing rain or drizzle, sleet, ice, heavy snow → **high**
- Thunderstorms → **high** if precipitation is 50%+ likely, otherwise **medium**
- Snow, fog, heavy rain → **medium**
- Wind 35+ mph → **high**; 25+ mph → **medium**

**NWS alerts:** only those in force at departure time.
- Extreme or Severe → **high**; Moderate → **medium**; others → **low**
- Beach, sea and air-quality alerts → always **low** (they rarely affect flights)

**FAA airport status:** at either airport.
- Ground stop → **high**
- Airport closed → **high**. A partial closure that only affects private or special aircraft (for example "closed to non-scheduled transient aircraft") → **low**.
- Ground delay program: average 60+ minutes → **high**, otherwise **medium**
- Arrival/departure delays: up to 60+ minutes → **high**, otherwise **medium**
- If departure is more than 6 hours away, **high** is lowered to **medium**, because this is the status right now and it can change

**Overall:** the worst level from any source that answered ("worst source wins").

---

## Decisions and assumptions

- **U.S. only, using official U.S. government sources.** The brief asks for U.S. routes, and the NWS and FAA are the authoritative sources for U.S. weather and airport operations. They're free, need no API keys, and have no monthly limits.
- **Date and time, not just date.** "Tomorrow" could mean 13 or 47 hours away. The time lets the app check the weather at the hour that matters, and decide which sources apply.
- **The time is local to the departure airport**, like a boarding pass, and converted to UTC on the server. Daylight saving time is handled.
- **The arrival time is estimated** from the straight-line distance at about 500 mph, plus 30 minutes. It's rough, but enough to choose which hours of forecast to check at the destination.
- **Rule-based scoring.** Every rating can be traced to a specific rule, and the same input always gives the same result.
- **Worst source wins.** One serious problem from any source is enough to warn the traveller. It's cautious, and easy to explain.
- **No fake data.** If a source can't answer, it says so instead of showing made-up results.
- **Being polite to free services:** NWS forecast locations are remembered, the FAA feed is cached for 2 minutes, and failed NWS requests are retried once.

## What I'd change before real users

- Let users enter a **flight number**, using a flight-schedule API, to get the real departure and arrival times.
- **Tune the thresholds** against historical delay data, instead of using sensible starting values.
- Check the weather **along the route**, not just at the two airports.
- **Reliability:** a shared cache, retries with backoff for every source, and logging and monitoring for failures.
- **Security:** HTTPS, rate limiting and input limits.
- **Testing:** end-to-end tests of the UI, and accessibility testing.
- Rank airports by **real passenger numbers** instead of a hand-written list of major airports.

## Credits

- Weather forecast and alerts: [National Weather Service API](https://www.weather.gov/documentation/services-web-api)
- Airport status: [FAA National Airspace System Status](https://nasstatus.faa.gov)
- Airport data: [mwgg/Airports](https://github.com/mwgg/Airports) (MIT licence)
