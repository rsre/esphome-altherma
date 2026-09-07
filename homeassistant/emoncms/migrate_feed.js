#!/usr/bin/env node
/**
 * Emoncms feed-to-feed migration script.
 *
 * Usage:
 *   node migrate_feed.js
 *   node migrate_feed.js --source 1 --target 43
 *   node migrate_feed.js --base-url https://192.168.1.76:7443 --apikey <KEY> --source 1 --target 43
 */

"use strict";

const readline = require("node:readline");
const process  = require("node:process");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ---------------------------------------------------------------------------
// Config (defaults, overridable by CLI)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  baseUrl: "https://YOUR_EMONCMS_SERVER_HERE:PORT",
  apikey:  "YOUR_API_KEY_HERE",
};

const MAX_DATAPOINTS = 8928;

// ---------------------------------------------------------------------------
// CLI arg helpers
// ---------------------------------------------------------------------------
function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BASE_URL = (getArg("--base-url") || DEFAULTS.baseUrl).replace(/\/$/, "");
const APIKEY   = getArg("--apikey") || DEFAULTS.apikey;
const ARG_SRC  = getArg("--source");
const ARG_TGT  = getArg("--target");
const ARG_YES  = process.argv.includes("--yes");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function apiGet(path, params = {}) {
  const url = new URL(BASE_URL + path);
  url.searchParams.set("apikey", APIKEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} for GET ${path}`);
  const body = await res.json();

  if (body && body.success === false) {
    throw new Error(`API error (GET ${path}): ${body.message || JSON.stringify(body)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Feed list
// ---------------------------------------------------------------------------
async function getFeedList() {
  return apiGet("/feed/list.json");
}

async function getFeedMeta(id) {
  const meta = await apiGet("/feed/getmeta.json", { id });
  // Emoncms returns data even for wrong ids — validate
  if (Number(meta.id) !== Number(id)) {
    throw new Error(`Feed meta id mismatch: requested ${id}, got ${meta.id}`);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
function fmtSize(bytes) {
  if (!bytes || bytes === "") return "   ? K";
  const kb = Math.round(Number(bytes) / 1000);
  return String(kb).padStart(6) + " K";
}

function fmtTime(unixSec) {
  if (!unixSec) return "                   ";
  return new Date(Number(unixSec) * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function printFeedList(feeds) {
  const byTag = {};
  for (const f of feeds) {
    const tag = (f.tag || "(no tag)").trim();
    if (!byTag[tag]) byTag[tag] = [];
    byTag[tag].push(f);
  }

  const hdr = "ID".padEnd(5) + " " + "Size".padEnd(9) + " " + "Last update".padEnd(21) + " Name";
  for (const [tag, list] of Object.entries(byTag)) {
    console.log(`\n${tag}:`);
    console.log(hdr);
    for (const f of list) {
      const row = [
        String(f.id).padEnd(5),
        fmtSize(f.size).padEnd(9),
        fmtTime(f.time).padEnd(21),
        f.name,
      ].join(" ");
      console.log(row);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptFeedId(rl, label) {
  while (true) {
    const ans = (await ask(rl, `Enter ${label} feed ID: `)).trim();
    const n = Number(ans);
    if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
    console.log("  Invalid ID, please enter a positive integer.");
  }
}

async function promptConfirm(rl, message) {
  const ans = (await ask(rl, `${message} [y/N]: `)).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------
function renderProgress(done, total, width = 40) {
  const pct = Math.min(done / total, 1);
  const filled = Math.round(pct * width);
  const bar  = "█".repeat(filled) + "░".repeat(width - filled);
  const perc = (pct * 100).toFixed(1).padStart(5) + "%";
  process.stdout.write(`\r  [${bar}] ${perc} `);
}

function clearProgressLine() {
  process.stdout.write("\r" + " ".repeat(60) + "\r");
}

// ---------------------------------------------------------------------------
// Migration core
// ---------------------------------------------------------------------------

// /feed/post.json silently drops historical data outside the feed's live window.
// /feed/insert.json with batch body data=[[ts,val],...] stores arbitrary timestamps.
// Proven to work: migrate.js CSV test confirmed historical points are stored and readable.
async function insertBatch(feedId, points) {
  // points: array of [tsSec, value]
  const url = new URL(BASE_URL + "/feed/insert.json");
  url.searchParams.set("apikey", APIKEY);
  url.searchParams.set("id", String(feedId));

  const res = await fetch(url.toString(), {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body:    new URLSearchParams({ data: JSON.stringify(points) }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for /feed/insert.json`);
  const body = await res.json();

  // Emoncms echoes back the last inserted value (numeric) on success, or true
  const ok = typeof body === "number" || body === true || body?.success === true;
  if (!ok) throw new Error(`Batch insert failed: ${JSON.stringify(body)}`);
  return points.length;
}

async function migrate(srcMeta, tgtMeta) {
  const interval  = Number(tgtMeta.interval);   // seconds
  const timeSlice = interval * MAX_DATAPOINTS;  // seconds
  const srcStart  = Number(srcMeta.start_time);
  const srcEnd    = Number(srcMeta.end_time);
  const totalSec  = srcEnd - srcStart;

  let cursor       = srcStart;
  let totalInserted = 0;

  while (cursor < srcEnd) {
    const chunkEnd = Math.min(cursor + timeSlice, srcEnd);

    console.log(`\n  Get data  - from: ${fmtTime(cursor)} - to: ${fmtTime(chunkEnd)}`);

    // Fetch data (timestamps in milliseconds)
    const raw = await apiGet("/feed/data.json", {
      id:       srcMeta.id,
      start:    cursor * 1000,
      end:      chunkEnd * 1000,
      interval: interval,
    });

    if (!Array.isArray(raw) || raw.length === 0) {
      console.log("  No data in chunk, skipping.");
      cursor = chunkEnd;
      renderProgress(cursor - srcStart, totalSec);
      continue;
    }

    // Filter nulls; convert ms → s; align to target interval boundary
    const seen = new Set();
    const points = [];
    for (const [tsMs, v] of raw) {
      if (v === null || v === undefined) continue;
      const aligned = Math.round(tsMs / 1000 / interval) * interval;
      if (seen.has(aligned)) continue; // keep first value per slot
      seen.add(aligned);
      points.push([aligned, v]);
    }

    if (points.length === 0) {
      console.log("  All points null, skipping.");
      cursor = chunkEnd;
      renderProgress(cursor - srcStart, totalSec);
      continue;
    }

    console.log(`  Insert data - ${points.length} points to feed ${tgtMeta.id}`);
    await insertBatch(tgtMeta.id, points);
    totalInserted += points.length;

    cursor = chunkEnd;
    renderProgress(cursor - srcStart, totalSec);
  }

  clearProgressLine();
  return totalInserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nEmoncms Feed Migration`);
  console.log(`  Server: ${BASE_URL}\n`);

  // 1. Show feed list
  const feeds = await getFeedList();
  printFeedList(feeds);

  const rl = createRl();

  try {
    // 2. Select source and target
    let srcId = ARG_SRC ? Number(ARG_SRC) : await promptFeedId(rl, "source");
    let tgtId = ARG_TGT ? Number(ARG_TGT) : await promptFeedId(rl, "target");

    if (!Number.isFinite(srcId) || srcId <= 0) throw new Error("Invalid source feed ID");
    if (!Number.isFinite(tgtId) || tgtId <= 0) throw new Error("Invalid target feed ID");
    if (srcId === tgtId) throw new Error("Source and target must be different feeds");

    // 3. Load metadata
    console.log(`\nLoading metadata for source feed ${srcId}...`);
    const srcMeta = await getFeedMeta(srcId);
    console.log(`  start: ${fmtTime(srcMeta.start_time)}`);
    console.log(`  end:   ${fmtTime(srcMeta.end_time)}`);
    console.log(`  npoints: ${srcMeta.npoints}, interval: ${Number(srcMeta.interval).toFixed(1)}s`);

    console.log(`\nLoading metadata for target feed ${tgtId}...`);
    const tgtMeta = await getFeedMeta(tgtId);
    console.log(`  interval: ${tgtMeta.interval}s`);
    if (tgtMeta.npoints) {
      console.log(`  existing points: ${tgtMeta.npoints}`);
    }

    // Confirm
    console.log(`\nReady to migrate:`);
    console.log(`  Source ${srcId}: ${srcMeta.npoints} points`);
    console.log(`  Target ${tgtId}: interval ${tgtMeta.interval}s`);
    console.log(`  Range: ${fmtTime(srcMeta.start_time)} → ${fmtTime(srcMeta.end_time)}`);

    let confirmed;
    if (ARG_YES) {
      console.log("\n--yes flag set, skipping confirmation.");
      confirmed = true;
    } else {
      confirmed = await promptConfirm(rl, "\nProceed with migration?");
    }
    if (!confirmed) {
      console.log("Aborted.");
      process.exit(1);
    }

    // 4. Migrate
    console.log("\nStarting migration...");
    const posted = await migrate(srcMeta, tgtMeta);

    console.log(`\nDone! Total points inserted: ${posted}`);

  } finally {
    if (!rl.closed) rl.close();
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
