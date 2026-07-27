import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.join(__dirname, "..", "learn.js");
const code = fs.readFileSync(scriptPath, "utf8");

test("learn.js parses without syntax errors", () => {
  new Function(code);
});
