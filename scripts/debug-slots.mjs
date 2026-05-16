import "dotenv/config";
import { fromZonedTime } from "date-fns-tz";

const tz = "America/Los_Angeles";
const date = "2026-05-18";

console.log("Test 1 - T00:00:00:", fromZonedTime(`${date}T00:00:00`, tz));
console.log("Test 2 - T24:00:00:", fromZonedTime(`${date}T24:00:00`, tz));
console.log("Test 3 - T09:00:00:", fromZonedTime(`${date}T09:00:00`, tz));
console.log("Test 4 - T17:00:00:", fromZonedTime(`${date}T17:00:00`, tz));

const start = fromZonedTime(`${date}T00:00:00`, tz);
const end = fromZonedTime(`${date}T24:00:00`, tz);
console.log("Viewer day start valid?", !isNaN(start.getTime()));
console.log("Viewer day end valid?", !isNaN(end.getTime()));
console.log("Viewer day:", { start, end });
