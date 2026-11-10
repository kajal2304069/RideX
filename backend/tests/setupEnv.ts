// Runs before each test file's modules load. Keeps retry tests fast: BullMQ's
// exponential backoff would otherwise wait 1s, 2s, 4s... between attempts.
process.env.NOTIFICATION_BACKOFF_MS = "50";

// Surge is off for the general suite so existing fare assertions are stable; surge tests call the service/rules directly.
process.env.SURGE_ENABLED = "false";
