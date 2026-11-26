// Shared sample files for the time-viewer tests (not a test file itself: npm test only runs *.test.mjs).
export const TIMECLOCK = [
  "i 2026-11-23 09:00:00 work:code  Fix bug",
  "o 2026-11-23 11:30:00",
  "i 2026-11-23 22:00:00 home:chores  ; late",
  "o 2026-11-24 01:00:00",
  "i 2026-11-24 14:00:00 work:mail",
  "o 2026-11-24 14:45:00",
  "i 2026-11-25 08:00:00 work:code",
  "",
].join("\n");

export const TIMEDOT = [
  "2026-11-23 Mon",
  "work:code  ....",
  "home:read  ccec  ; evening",
  "work:mail  1.5",
  "",
  "2026-11-24",
  "work:code  2h",
  "",
].join("\n");

export const NOW = { date: "2026-11-25", time: "10:00:00", secondsOfDay: 36000, wall: Date.UTC(2026, 10, 25, 10) / 1000 };
