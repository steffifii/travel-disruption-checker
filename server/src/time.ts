// =============================================================================
// time.ts
// Helpers for dates, times and time zones.
//
// The user enters the departure date and time in the DEPARTURE airport's
// local time, like on a boarding pass. These helpers turn that into an exact
// moment (in UTC), so we can work out how many hours away the flight is.
// =============================================================================

// -----------------------------------------------------------------------------
// isValidDate: true if the text is "YYYY-MM-DD" AND a real calendar date.
// Returns only true or false.
//   1. The regex checks the format: 4 digits, dash, 2 digits, dash, 2 digits.
//   2. new Date(...) gives "Invalid Date" for impossible months like 13.
//   3. JavaScript quietly turns "2026-02-31" into March 3, so we convert the
//      date back to text and check it still matches what was typed.
// -----------------------------------------------------------------------------
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// -----------------------------------------------------------------------------
// isValidTime: true if the text is a 24-hour time from "00:00" to "23:59".
// -----------------------------------------------------------------------------
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// -----------------------------------------------------------------------------
// offsetMinutes (used only in this file): how far a time zone is from UTC at
// a given moment, in minutes. New York in winter -> -300 (5 hours behind).
// How: print the moment as a clock in that time zone, read the clock back as
// if it were UTC, and compare. Daylight saving time is handled automatically.
// -----------------------------------------------------------------------------
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);

  // Read one number (year, month, ...) from the printed clock.
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  const clockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (clockAsUtc - at.getTime()) / 60_000;
}

// -----------------------------------------------------------------------------
// localToUtc: local date + time at a time zone -> the exact moment.
// Example: localToUtc("2026-10-31", "08:00", "America/New_York")
//          -> 2026-10-31T12:00:00Z (8am in New York is noon UTC)
// -----------------------------------------------------------------------------
export function localToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  return new Date(guess.getTime() - offsetMinutes(timeZone, guess) * 60_000);
}

// -----------------------------------------------------------------------------
// hoursUntil: hours from now until a moment, rounded to 1 decimal (e.g. 26.5).
// A negative number means the moment has already passed.
// -----------------------------------------------------------------------------
export function hoursUntil(moment: Date): number {
  return Math.round(((moment.getTime() - Date.now()) / 3_600_000) * 10) / 10;
}

// -----------------------------------------------------------------------------
// flightHours: hours between take-off and landing, rounded to 1 decimal.
// Both moments are exact (UTC), so time zones are already taken care of:
// 9:00 in New York to 12:30 in San Francisco -> 6.5 hours.
// -----------------------------------------------------------------------------
export function flightHours(departure: Date, arrival: Date): number {
  return Math.round(((arrival.getTime() - departure.getTime()) / 3_600_000) * 10) / 10;
}

// -----------------------------------------------------------------------------
// checkFlightTimes: catches arrival times that can't be right.
// Returns an error message, or null when the times look fine.
//   - Arrival must be after departure. The usual mistake is entering the
//     arrival in the departure city's time instead of the destination's.
//   - The flight must take at least 15 minutes and at most 24 hours. The
//     longest U.S. trips, even with a connection, are well under a day.
// -----------------------------------------------------------------------------
export function checkFlightTimes(departure: Date, arrival: Date, destinationCity: string): string | null {
  const hours = (arrival.getTime() - departure.getTime()) / 3_600_000;
  if (hours <= 0) {
    return `The arrival time must be after the departure time. Remember to enter it in ${destinationCity} local time.`;
  }
  if (hours < 0.25) return "That flight would take less than 15 minutes. Please check the times.";
  if (hours > 24) return "That flight would take more than 24 hours. Please check the arrival date.";
  return null;
}
