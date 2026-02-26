process.env.NODE_ENV = "production";
process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

try {
  require("./.next/standalone/server.js");
} catch (err) {
  console.error("Failed to start standalone Next server", err);
  process.exit(1);
}
