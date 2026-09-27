import "dotenv/config";
import { readFileSync } from "node:fs";
import { record } from "./recorder.js";
import type { Task } from "./types.js";

// Usage: npm run record -- path/to/task.json
const taskPath = process.argv[2] ?? "task.example.json";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("Set TYPESAFE_API_KEY (copy .env.example to .env).");
  process.exit(1);
}

const task = JSON.parse(readFileSync(taskPath, "utf8")) as Task;
console.log(`Recording task: ${task.goal}`);
record(task).catch((err) => {
  console.error(err);
  process.exit(1);
});
