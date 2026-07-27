// One-off CLI to grant/revoke admin dashboard access (see src/analytics.js,
// GET /api/admin/stats, admin.html). Run against the same database the
// live server uses:
//
//   node scripts/make-admin.js you@example.com
//   node scripts/make-admin.js you@example.com --revoke
//
// Respects PAPERPOKER_DB_PATH the same way server.js does, so this can
// target a production database file without editing this script.
import path from "path";
import { fileURLToPath } from "url";
import { openDb } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!email) {
  console.error("Usage: node scripts/make-admin.js <email> [--revoke]");
  process.exit(1);
}

const dbPath = process.env.PAPERPOKER_DB_PATH || path.join(__dirname, "..", "data", "paperpoker.sqlite");
const db = openDb(dbPath);

const user = db.prepare("SELECT id, email, is_admin FROM users WHERE email = ? COLLATE NOCASE").get(email);
if (!user) {
  console.error(`No account found for ${email} in ${dbPath}`);
  process.exit(1);
}

db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(revoke ? 0 : 1, user.id);
console.log(`${revoke ? "Revoked" : "Granted"} admin access for ${user.email} (id ${user.id}) in ${dbPath}`);
