// Ingress web UI + orchestrator for the ZWA-2 Factory Reset add-on.
// Serves one friendly page (big buttons, live log) and drives cli.mjs behind
// the scenes: stop Z-Wave JS -> back up -> erase -> verify + restore region ->
// optional HA device cleanup -> restart Z-Wave JS. No YAML configuration.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ZWA2_PORT) || 8099;
const BACKUP_DIR = process.env.ZWA2_BACKUP_DIR || "/share/zwa2-factory-reset/backups";
const RESULT_JSON = "/tmp/zwa2-result.json";
const TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN;

// Z-Wave JS add-on slugs that may hold the serial port.
const ZWJS_SLUGS = ["core_zwave_js", "a0d7b954_zwavejsui", "a0d7b954_zwavejs2mqtt"];

// Region values the UI may request (validated before passing to the CLI).
const ALLOWED_REGIONS = new Set([
  "keep", "default",
  "USA", "USA (Long Range)", "Europe", "Europe (Long Range)",
  "Australia/New Zealand", "Hong Kong", "India", "Israel", "Russia",
  "China", "Japan", "Korea",
]);
const safeRegion = (r) => (ALLOWED_REGIONS.has(r) ? r : "keep");

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ----------------------------------------------------------------- job state

let currentJob = null; // { type, running, ok, lines: [], clients: Set }
const listeners = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(data);
    } catch {
      /* client gone */
    }
  }
}

function log(line) {
  if (currentJob) currentJob.lines.push(line);
  console.log(`[job] ${line}`); // also to the add-on log for debugging
  broadcast({ type: "log", line });
}

function setStatus(status, message) {
  if (currentJob) {
    currentJob.status = status;
    currentJob.message = message;
  }
  broadcast({ type: "status", status, message });
}

// ------------------------------------------------------------- supervisor API

async function sv(method, apiPath, body) {
  const res = await fetch(`http://supervisor${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

let stoppedSlugs = [];

async function ensurePortFree() {
  stoppedSlugs = [];
  if (!TOKEN) {
    log("⚠ No Supervisor token available — cannot manage Z-Wave JS automatically.");
    return;
  }
  // Probe each known Z-Wave JS slug directly (no /addons list dependency).
  for (const slug of ZWJS_SLUGS) {
    const info = await sv("GET", `/addons/${slug}/info`);
    if (!info.ok) {
      // 404 just means "not installed"; surface anything else so port-lock
      // failures are diagnosable instead of silently skipped.
      if (info.status !== 404) log(`(could not query ${slug}: HTTP ${info.status})`);
      continue;
    }
    const state = info.json?.data?.state;
    if (state === "started") {
      log(`Stopping ${slug} to free the adapter (it will be restarted afterwards)...`);
      const r = await sv("POST", `/addons/${slug}/stop`);
      if (r.ok) {
        stoppedSlugs.push(slug);
        await new Promise((res) => setTimeout(res, 3000));
      } else {
        throw new Error(`Could not stop ${slug} (HTTP ${r.status} ${r.text?.slice(0, 160) || ""}). Stop it manually and try again.`);
      }
    }
  }
  if (stoppedSlugs.length === 0) {
    log("(No running Z-Wave JS add-on was found to stop — assuming the adapter is free.)");
  }
}

async function restartStopped() {
  for (const slug of stoppedSlugs) {
    log(`Restarting ${slug}...`);
    await sv("POST", `/addons/${slug}/start`).catch(() => {});
  }
  stoppedSlugs = [];
}

// Remove ONLY the HA integration entry that owned the wiped network.
async function cleanupHaDevices(oldHomeIdDecimal, oldHomeIdHex) {
  if (!oldHomeIdDecimal) {
    log("Old Home ID unknown — skipping Home Assistant device cleanup.");
    return;
  }
  log(`Looking for the Home Assistant entry of the old network (${oldHomeIdHex})...`);
  const template = `{% set ns = namespace(entries=[]) %}
{% for e in integration_entities('zwave_js') %}
{% set d = device_id(e) %}
{% if d %}
{% set ids = device_attr(d, 'identifiers') | string %}
{% if "'${oldHomeIdDecimal}-" in ids %}
{% set ns.entries = ns.entries + [config_entry_id(e)] %}
{% endif %}
{% endif %}
{% endfor %}
{{ ns.entries | unique | list | to_json }}`;
  const r = await sv("POST", "/core/api/template", { template });
  if (!r.ok) {
    log("Could not query Home Assistant for old-network devices — clean up manually under Settings → Devices & Services → Z-Wave.");
    return;
  }
  let entries = [];
  try {
    entries = JSON.parse(r.text);
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    log("No Home Assistant entry references the old network — nothing to clean up.");
    return;
  }
  if (entries.length > 1) {
    log(`Found ${entries.length} entries referencing the old network — ambiguous, so nothing was removed. Clean up manually if needed.`);
    return;
  }
  const del = await sv("DELETE", `/core/api/config/config_entries/entry/${entries[0]}`);
  if (del.ok) log("Removed the old network's devices from Home Assistant.");
  else log("Could not remove the old entry automatically — remove it under Settings → Devices & Services → Z-Wave.");
}

// ------------------------------------------------------------------- cli runner

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, "cli.mjs"), ...args], {
      // Phrase the CLI's "undo" hint for this web UI instead of a node command.
      env: { ...process.env, ZWA2_RESTORE_HINT: 'use the "Restore a backup" section below' },
    });
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim() !== "") log(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      log(`Failed to launch the tool: ${e.message}`);
      resolve(1);
    });
  });
}

function readResult() {
  try {
    const r = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8"));
    fs.unlinkSync(RESULT_JSON);
    return r;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- jobs

async function jobCheck(region) {
  await ensurePortFree();
  try {
    try {
      fs.unlinkSync(RESULT_JSON);
    } catch {}
    const rc = await runCli(["--info", "--yes", "--region", region, "--backup-dir", BACKUP_DIR, "--result-json", RESULT_JSON]);
    const info = readResult();
    if (rc === 0 && info) {
      setStatus("done", `Adapter Home ID ${info.homeId}, ${info.deviceCount} paired device(s), region ${info.regionName}.`);
    } else if (rc === 0) {
      setStatus("done", "Check complete.");
    } else {
      setStatus("error", "Could not read the adapter. Is a ZWA-2 plugged in?");
    }
  } finally {
    await restartStopped();
  }
}

async function jobWipe(cleanup, region) {
  await ensurePortFree();
  try {
    try {
      fs.unlinkSync(RESULT_JSON);
    } catch {}
    const rc = await runCli(["--yes", "--region", region, "--backup-dir", BACKUP_DIR, "--result-json", RESULT_JSON]);
    const result = readResult();

    if (rc !== 0 && rc !== 3) {
      setStatus("error", "The wipe did not complete. See the log above.");
      return;
    }

    if (cleanup && result?.oldHomeIdDecimal) {
      log("");
      await cleanupHaDevices(result.oldHomeIdDecimal, result.oldHomeId);
    }

    if (rc === 3) {
      // The wipe erased the NVM, but the adapter's USB re-enumerated on restart
      // and the host briefly reclaims the port — so verifying / restoring the
      // region in this same run can't win that race. Guide the user to the
      // Check button, which runs later on a settled port. (Z-Wave JS also
      // re-applies its own region when it restarts, so this is often moot.)
      log("");
      log("The wipe is done and confirmed. To double-check the new (empty) network");
      log('and restore your RF region, click "Check adapter" above in ~30 seconds.');
      setStatus("done", 'Factory reset complete. Click "Check adapter" shortly to verify and restore your region.');
    } else {
      setStatus("done", "Factory reset complete. Your ZWA-2 is wiped and ready for a fresh network.");
    }
  } finally {
    await restartStopped();
  }
}

/** Only allow restoring a *.bin file that actually lives in BACKUP_DIR. */
function validateBackupPath(file) {
  if (typeof file !== "string" || !file) return null;
  const resolved = path.resolve(file);
  const root = path.resolve(BACKUP_DIR) + path.sep;
  if (!resolved.startsWith(root)) return null;
  if (!resolved.endsWith(".bin")) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

async function jobRestore(file) {
  const safe = validateBackupPath(file);
  if (!safe) {
    setStatus("error", "Invalid or unknown backup file — pick one from the list.");
    return;
  }
  file = safe;
  await ensurePortFree();
  try {
    const rc = await runCli(["--restore", file, "--yes", "--backup-dir", BACKUP_DIR]);
    if (rc === 0) setStatus("done", "Backup restored. Your previous network is back.");
    else setStatus("error", "Restore did not complete. See the log above.");
  } finally {
    await restartStopped();
  }
}

async function startJob(type, run) {
  console.log(`[server] startJob(${type}) requested`);
  if (currentJob?.running) return false;
  currentJob = { type, running: true, lines: [], status: "running", message: "" };
  broadcast({ type: "start", job: type });
  try {
    await run();
  } catch (e) {
    setStatus("error", e.message);
  } finally {
    currentJob.running = false;
    broadcast({ type: "end", job: type, status: currentJob.status });
  }
  return true;
}

// --------------------------------------------------------------- backups list

function listBackups() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(full + ".json", "utf8"));
        } catch {}
        return {
          file: full,
          name: f,
          homeId: meta.homeId ?? null,
          devices: meta.nodeCount != null ? Math.max(0, meta.nodeCount - 1) : null,
          region: meta.regionName ?? null,
          createdAt: meta.createdAt ?? null,
          mtime: fs.statSync(full).mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------- http

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  // Ingress strips its prefix before proxying, so paths arrive normalized.
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p !== "/api/events") console.log(`[http] ${req.method} ${req.url} -> ${p}`);

  if (p === "/" && req.method === "GET") {
    return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(DIR, "www", "index.html")));
  }

  if (p === "/api/backups" && req.method === "GET") {
    return send(res, 200, "application/json", JSON.stringify(listBackups()));
  }

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // Replay the current job so a late-opening page still sees progress.
    if (currentJob) {
      res.write(`data: ${JSON.stringify({ type: "start", job: currentJob.type })}\n\n`);
      for (const line of currentJob.lines) res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "status", status: currentJob.status, message: currentJob.message })}\n\n`);
      if (!currentJob.running) res.write(`data: ${JSON.stringify({ type: "end", job: currentJob.type, status: currentJob.status })}\n\n`);
    }
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }

  if (p === "/api/check" && req.method === "POST") {
    const bodyC = await readBody(req);
    const started = await startJob("check", () => jobCheck(safeRegion(bodyC.region)));
    return send(res, started ? 202 : 409, "application/json", JSON.stringify({ started }));
  }

  if (p === "/api/wipe" && req.method === "POST") {
    const body = await readBody(req);
    const started = await startJob("wipe", () => jobWipe(!!body.cleanup, safeRegion(body.region)));
    return send(res, started ? 202 : 409, "application/json", JSON.stringify({ started }));
  }

  if (p === "/api/restore" && req.method === "POST") {
    const body = await readBody(req);
    const started = await startJob("restore", () => jobRestore(body.file));
    return send(res, started ? 202 : 409, "application/json", JSON.stringify({ started }));
  }

  send(res, 404, "text/plain", "Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ZWA-2 Factory Reset UI listening on ${PORT}`);
});
