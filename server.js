process.env.NODE_ENV = "production";
process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

async function bootServer() {
  try {
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(__dirname);
  } catch (err) {
    console.warn("Could not load .env files via @next/env", err);
  }

  try {
    await import("./.next/standalone/server.js");
  } catch (err) {
    console.error("Failed to start standalone Next server", err);
    process.exit(1);
  }
}

void bootServer();
