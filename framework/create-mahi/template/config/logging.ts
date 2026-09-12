import { storage_path, type LogConfig } from "@mahiframework/core";

export function loggingConfig(): LogConfig {
  return {
    default: "stack",
    channels: {
      console: { driver: "console" },
      single: { driver: "single", path: storage_path("logs/mahi.log") },
      daily: { driver: "daily", path: storage_path("logs/mahi.log"), maxFiles: 14 },
      array: { driver: "array" },
      null: { driver: "null" },
      stack: { driver: "stack", channels: ["console", "single"] },
    },
    emergency: { path: storage_path("logs/mahi.log") },
  };
}
