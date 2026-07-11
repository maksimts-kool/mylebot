import { randomUUID } from "node:crypto";

const baseUrl = process.env.SIMULATOR_BASE_URL ?? "http://127.0.0.1:3000";
const secret = process.env.ROBLOX_INGESTION_SECRET;
if (!secret) throw new Error("ROBLOX_INGESTION_SECRET is required");
const universeId = process.env.ROBLOX_UNIVERSE_ID ?? "0";
const placeId = (process.env.ROBLOX_ALLOWED_PLACE_IDS ?? "0").split(",")[0]!;
const rankNumber = Number(process.env.SIMULATOR_RANK ?? process.env.ROBLOX_MIN_RANK ?? 1);
const userId = process.env.SIMULATOR_USER_ID ?? "1";
const username = process.env.SIMULATOR_USERNAME ?? "SessionSimulator";
const jobId = `simulator-${randomUUID()}`;
const base = Date.now() - 240_000;

type Kind = "JOIN" | "HEARTBEAT" | "LEAVE" | "SHUTDOWN";
function event(kind: Kind, offsetSeconds: number, active: boolean, job = jobId) {
  return {
    eventId: randomUUID(), kind, occurredAt: new Date(base + offsetSeconds * 1000).toISOString(),
    universeId, placeId, jobId: job,
    player: { userId, username, rankNumber, rankName: "Simulator", active },
  };
}

const scenarios = [
  { name: "join and activity", events: [event("JOIN", 0, true), event("HEARTBEAT", 30, true)] },
  { name: "inactivity", events: [event("HEARTBEAT", 60, false), event("HEARTBEAT", 90, false)] },
  { name: "reconnect into a different server", events: [event("LEAVE", 120, false), event("JOIN", 150, true, `${jobId}-reconnected`)] },
  { name: "activity after reconnect", events: [event("HEARTBEAT", 180, true, `${jobId}-reconnected`)] },
  { name: "server shutdown", events: [event("SHUTDOWN", 210, false, `${jobId}-reconnected`)] },
];

for (const scenario of scenarios) {
  const response = await fetch(`${baseUrl}/v1/roblox/presence/batch`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ events: scenario.events }),
  });
  console.log(scenario.name, response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
}
console.log("Simulation submitted. The final session ends after the configured reconnect grace period.");

