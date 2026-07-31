// One-off build script: assembles the CrazyGames-specific client bundle
// from this repo's real, unmodified source files. Never edits the source
// index.html on disk - only an in-memory copy gets the CrazyGames-specific
// transformations, which are then written to a separate build/ directory.
// The original files (and the standalone Railway deployment that serves
// them directly via express.static) are untouched by running this.
//
// Usage: node scripts/build-crazygames-bundle.js <backend-base-url>
//   e.g. node scripts/build-crazygames-bundle.js https://paperpoker.up.railway.app
//
// Output: build-crazygames/ (a folder, not a zip - zip it yourself at
// actual submission time, e.g. `Compress-Archive` on Windows or `zip -r`,
// once you've verified the folder's contents work as expected).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "build-crazygames");

const backendBaseUrl = process.argv[2];
if (!backendBaseUrl) {
  console.error("Usage: node scripts/build-crazygames-bundle.js <backend-base-url>");
  console.error("  e.g. node scripts/build-crazygames-bundle.js https://paperpoker.up.railway.app");
  process.exit(1);
}
if (!/^https:\/\/[^/]+$/.test(backendBaseUrl)) {
  console.error(`Expected an https:// origin with no trailing slash/path, got: ${backendBaseUrl}`);
  process.exit(1);
}

// Only the files an actual browser session needs - explicitly NOT server.js,
// src/*, test/*, admin.html, data/, node_modules/, package*.json, scripts/*,
// play.js (a terminal/CLI tool, unrelated to the browser client),
// checkJS.cjs (a dev syntax-check utility).
const CLIENT_FILES = [
  "index.html",
  "styles.css",
  "range-trainer.js",
  "learn.js",
  "rank-badges.js",
  "bot-mascots.js",
  "tension-music.js",
  "terms.html",
  "privacy.html",
];
const CLIENT_DIRS = ["assets"];

// CrazyGames SDK CDN URL - this exact URL (including the v2 in the
// filename - NOT a typo, this is genuinely their current documented
// version) is copied verbatim from https://docs.crazygames.com/sdk/html5-v2/intro/.
// An earlier version of this script used a "v3" URL found via a search
// result rather than their own docs - it happened to load and self-report
// a real version number when tested directly, so the bug went unnoticed in
// local testing, but CrazyGames' own upload scanner didn't recognize it and
// reported "SDK not currently detected." Always get this from their actual
// docs page, not a search snippet, if it ever needs to change again.
const CRAZYGAMES_SDK_SCRIPT_URL = "https://sdk.crazygames.com/crazygames-sdk-v2.js";

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildIndexHtml() {
  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const $ = cheerio.load(source, { decodeEntities: false });

  // Remove every entry point into the Multiplayer/room feature - the
  // CrazyGames build is bot-only by explicit decision (the standalone
  // Railway site keeps the real thing).
  //
  // The nav tab + its page are safe to fully REMOVE: the tab/page-switching
  // logic in index.html is generic (loops over whatever .site-tab/.site-page
  // elements exist, matched by data-page/id) with no direct getElementById
  // reference to either, confirmed by reading the source.
  $('.site-tab[data-page="multiplayer"]').remove();
  $("#page-multiplayer").remove();

  // #play-friends-panel (the "Create or Join a Room" button) is instead
  // HIDDEN via CSS, not removed - room.js-adjacent code does
  // document.getElementById('btn-open-room').addEventListener(...) at
  // script-load time (unconditionally, not inside a guard), so actually
  // removing this element from the DOM would throw on page load and break
  // the rest of the inline script. display:none makes it exactly as
  // inaccessible to a player (invisible, unclickable, not in the layout)
  // without touching any JS. #room-modal and #room-lobby-overlay need no
  // treatment at all - both already default to class="hidden" in the
  // source and are only ever un-hidden by code paths that start at
  // btn-open-room, which is now permanently hidden.
  $("#play-friends-panel").css("display", "none");

  // API_BASE is committed as '' (a no-op for the standalone site's own
  // same-origin requests) - only this build's copy gets it replaced with
  // the real backend origin, since this bundle is hosted on CrazyGames' own
  // CDN and every /api/... + socket.io call needs to reach the real server.
  const beforeApiBase = $.html();
  const afterApiBase = beforeApiBase.replace(
    "const API_BASE = '';",
    `const API_BASE = ${JSON.stringify(backendBaseUrl)};`
  );
  if (afterApiBase === beforeApiBase) {
    throw new Error("Could not find \"const API_BASE = '';\" in index.html - did the source change?");
  }
  const $final = cheerio.load(afterApiBase, { decodeEntities: false });

  // The SDK script tag itself is ONLY ever added here, never committed to
  // the source file - see index.html's own cgGameplayStart/Stop comment for
  // why the call sites are safe to keep in source unconditionally.
  $final("head").append(`<script src="${CRAZYGAMES_SDK_SCRIPT_URL}"></script>\n`);

  return $final.html();
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const file of CLIENT_FILES) {
    if (file === "index.html") continue; // built specially below
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) {
      console.warn(`Skipping ${file} - not found (expected if this is optional, e.g. terms/privacy pages)`);
      continue;
    }
    fs.copyFileSync(src, path.join(OUT_DIR, file));
  }
  for (const dir of CLIENT_DIRS) {
    copyRecursive(path.join(ROOT, dir), path.join(OUT_DIR, dir));
  }

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), buildIndexHtml());

  console.log(`Built CrazyGames bundle -> ${OUT_DIR}`);
  console.log(`Backend base URL: ${backendBaseUrl}`);
  console.log(`Next: verify it (see the plan's Verification section), then zip the folder's CONTENTS (not the folder itself) for upload.`);
}

main();
