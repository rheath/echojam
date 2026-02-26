process.env.NODE_ENV = "production";
process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

try {
  const { loadEnvConfig } = require("@next/env");
  loadEnvConfig(__dirname);
} catch (err) {
  console.warn("Could not load .env files via @next/env", err);
}

try {
  require("./.next/standalone/server.js");
} catch (err) {
  console.error("Failed to start standalone Next server", err);
  process.exit(1);
}
