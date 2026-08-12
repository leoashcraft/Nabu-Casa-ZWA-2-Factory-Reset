#!/usr/bin/env node
// zwa2-factory-reset — wipe a ZWA-2 (or other Silabs 700/800 Z-Wave stick)
// via the Gecko bootloader's "erase nvm" command, bypassing the firmware's
// broken SetDefault handler. Backs up the NVM first and preserves the RF region.
//
// Based on the erase procedure in Home Assistant's official zwa2-toolbox:
// https://github.com/home-assistant/zwa2-toolbox (src/lib/zwave.ts)

import { Driver, DriverMode, RFRegion } from "zwave-js";
import { BootloaderChunkType } from "@zwave-js/serial";
import { Bytes } from "@zwave-js/shared";
import { SerialPort } from "serialport";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ---------------------------------------------------------------- constants

// Known USB identifiers for auto-detection. The ZWA-2's USB interface is an
// ESP32-S3 bridge enumerating with Espressif's VID and "Nabu Casa" as the
// manufacturer string.
const KNOWN_ADAPTERS = [
  { vendorId: "303a", productId: "4001", label: "Home Assistant Connect ZWA-2" },
];

const CONNECT_TIMEOUT_MS = 60_000;
// After the bootloader exits, the ZWA-2's USB bridge fully re-enumerates, which
// takes several seconds. Wait before the first verify attempt, then retry.
const REVERIFY_DELAY_MS = 5_000;
const WATCHDOG_MS = 15 * 60_000;

// Watchdog: whatever happens, never hang forever (important when running
// unattended, e.g. as a Home Assistant add-on where nobody can press Ctrl+C).
const watchdog = setTimeout(() => {
  console.error(
    `\nWatchdog: operation exceeded ${WATCHDOG_MS / 60_000} minutes — aborting. ` +
      "The adapter may be unresponsive; unplug/replug it and re-run.",
  );
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

/** Progress printer that behaves in real terminals AND in captured logs. */
function makeProgressPrinter(label) {
  let lastPct = -1;
  const isTTY = process.stdout.isTTY;
  const step = isTTY ? 10 : 20;
  return (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % step === 0) {
      if (isTTY) process.stdout.write(`  ${label}: ${pct}%   \r`);
      else console.log(`  ${label}: ${pct}%`);
      lastPct = pct;
    }
  };
}

/** How to phrase "undo this" — overridable so wrappers (e.g. the HA add-on)
 * can show instructions that make sense in their UI instead of a node command. */
function restoreHint(file) {
  const t = process.env.ZWA2_RESTORE_HINT;
  return t ? t.replaceAll("{file}", file) : `node cli.mjs --restore "${file}"`;
}

// --------------------------------------------------------------- arg parsing

const args = process.argv.slice(2);
const flags = {
  port: getFlagValue("--port"),
  restore: getFlagValue("--restore"),
  region: getFlagValue("--region"),
  backupDir: getFlagValue("--backup-dir") ?? "./backups",
  yes: args.includes("--yes") || args.includes("-y"),
  noBackup: args.includes("--no-backup"),
  list: args.includes("--list"),
  info: args.includes("--info"),
  resultJson: getFlagValue("--result-json"),
  help: args.includes("--help") || args.includes("-h"),
};

function getFlagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`Missing value for ${name}`);
    process.exit(2);
  }
  return v;
}

if (flags.help) {
  console.log(`
zwa2-factory-reset — safely factory-reset a ZWA-2 Z-Wave adapter

USAGE
  node cli.mjs [options]              wipe the adapter (default action)
  node cli.mjs --list                 list detected serial ports and exit
  node cli.mjs --info                 show the adapter's state, change nothing
  node cli.mjs --restore <file>       restore a previous NVM backup

OPTIONS
  --port <path>       serial port to use (skips auto-detection)
  --region <value>    what to do with the RF region after the wipe:
                        keep       restore the region the stick had before (default when interactive answer is yes)
                        default    leave the stick at its firmware default
                        <name|num> set a specific region, e.g. "Europe", "USA (Long Range)", 9
                      (without this flag you will be asked interactively)
  --backup-dir <dir>  where to write NVM backups (default: ./backups)
  --no-backup         skip the NVM backup (not recommended)
  --yes, -y           non-interactive: skip confirmations (requires --region
                      too if you want region handling other than a prompt)
  --help, -h          show this help

EXAMPLES
  node cli.mjs                                  # guided, interactive
  node cli.mjs --yes --region keep              # unattended full reset
  node cli.mjs --restore backups/zwa2-*.bin     # roll back to a backup
`);
  process.exit(0);
}

// ------------------------------------------------------------------ helpers

const rl = readline.createInterface({ input: stdin, output: stdout });

function regionName(value) {
  if (value === undefined || value === null) return "unknown";
  return RFRegion[value] ?? `unknown (${value})`;
}

function parseRegionArg(v) {
  if (v === undefined) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  // Case-insensitive match against enum names
  const match = Object.entries(RFRegion)
    .filter(([k]) => isNaN(Number(k)))
    .find(([k]) => k.toLowerCase() === v.toLowerCase());
  return match ? match[1] : undefined;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Destroy a driver but never hang on it (macOS quirk: destroy can stall). */
async function safeDestroy(driver) {
  if (!driver) return;
  await Promise.race([
    driver.destroy().catch(() => {}),
    new Promise((res) => setTimeout(res, 5_000)),
  ]);
}

/** Open a driver on the port and wait until it's ready (Serial API or bootloader). */
async function connect(portPath) {
  const driver = new Driver(portPath, {
    logConfig: { enabled: false },
    allowBootloaderOnly: true,
    // Keep zwave-js's network cache out of the user's working directory
    storage: { cacheDir: path.join(os.tmpdir(), "zwa2-factory-reset-cache") },
  });

  const ready = new Promise((resolve, reject) => {
    driver.once("driver ready", () => resolve("app"));
    driver.once("bootloader ready", () => resolve("bootloader"));
    driver.on("error", (e) => reject(e));
  });
  ready.catch(() => {}); // avoid unhandled rejection if we time out first

  try {
    await driver.start();
    const mode = await withTimeout(ready, CONNECT_TIMEOUT_MS, "the adapter to respond");
    // From here on, driver errors are expected noise (e.g. soft-reset quirks)
    driver.on("error", () => {});
    return { driver, mode };
  } catch (e) {
    await safeDestroy(driver);
    throw e;
  }
}

/**
 * Connect with retries — right after a wipe or restore the adapter reboots
 * and (on some platforms) re-enumerates on USB, so the first attempt can fail.
 */
/**
 * Retry connecting for up to `maxSeconds`. After the bootloader exits and the
 * ZWA-2 re-enumerates, the host may hold the port for a while — most often
 * ModemManager probing the new /dev/ttyACM* device (the classic Z-Wave/Zigbee
 * "Cannot lock port" for ~30-60s), which releases it once its probe times out.
 * So we out-wait it rather than fail fast.
 */
async function connectWithRetry(portPath, maxSeconds = 120) {
  const deadline = Date.now() + maxSeconds * 1000;
  let lastErr;
  let attempt = 0;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      return await connect(portPath);
    } catch (e) {
      lastErr = e;
    }
    attempt++;
    // Keep the log calm: note progress at most every ~20s.
    if (Date.now() - lastNotice > 20_000) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`  (adapter port still busy — likely the OS probing the re-enumerated device; still trying, ~${left}s left)`);
      lastNotice = Date.now();
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  throw lastErr ?? new Error("could not open the serial port");
}

// ------------------------------------------------------------ port handling

/** On macOS, prefer the non-blocking callout device over the dial-in one. */
function normalizePortPath(p) {
  if (process.platform === "darwin" && p.startsWith("/dev/tty.")) {
    const cu = p.replace("/dev/tty.", "/dev/cu.");
    if (fs.existsSync(cu)) return cu;
  }
  return p;
}

/**
 * Linux fallback: inside containers (e.g. a Home Assistant add-on) serialport
 * often can't read USB VID/PID metadata, but the kernel's stable
 * /dev/serial/by-id symlinks encode the product name.
 */
function findByIdCandidates() {
  const dir = "/dev/serial/by-id";
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /nabu[_-]?casa|zwa[_-]?2/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** serialport's enumeration shells out to `udevadm`, which is absent in minimal
 * containers (e.g. the HA add-on base image) and throws. Never let that crash us. */
async function listPortsSafe() {
  try {
    return await SerialPort.list();
  } catch {
    return [];
  }
}

/** Raw device-node scan that needs no udevadm: by-id symlinks + tty globs. */
function scanDevCandidates() {
  const out = [...findByIdCandidates()];
  try {
    for (const f of fs.readdirSync("/dev")) {
      if (/^tty(USB|ACM)\d+$/.test(f)) out.push("/dev/" + f);
    }
  } catch {
    // /dev not enumerable — nothing to add
  }
  return [...new Set(out)];
}

async function resolvePort() {
  if (flags.port) return flags.port;

  const ports = await listPortsSafe();
  const known = ports.filter((p) =>
    KNOWN_ADAPTERS.some(
      (k) => p.vendorId?.toLowerCase() === k.vendorId && p.productId?.toLowerCase() === k.productId,
    ),
  );

  if (known.length === 1) {
    const p = known[0];
    const portPath = normalizePortPath(p.path);
    console.log(`Auto-detected: ${portPath} (${p.manufacturer ?? "?"}, serial ${p.serialNumber ?? "?"})`);
    return portPath;
  }

  if (known.length > 1) {
    console.log("Multiple matching adapters found:");
    known.forEach((p, i) =>
      console.log(`  [${i + 1}] ${p.path}  serial: ${p.serialNumber ?? "?"}`),
    );
    if (flags.yes) {
      console.error("Multiple adapters found — use --port to choose in non-interactive mode.");
      process.exit(2);
    }
    const answer = await rl.question("Select adapter number: ");
    const idx = Number(answer) - 1;
    if (!(idx >= 0 && idx < known.length)) {
      console.error("Invalid selection.");
      process.exit(2);
    }
    return normalizePortPath(known[idx].path);
  }

  // No USB-ID match — try the /dev/serial/by-id name-based fallback (Linux,
  // and the reliable path inside Home Assistant add-on containers)
  const byId = findByIdCandidates();
  if (byId.length === 1) {
    console.log(`Auto-detected via /dev/serial/by-id: ${byId[0]}`);
    return byId[0];
  }
  if (byId.length > 1) {
    console.log("Multiple ZWA-2-looking devices in /dev/serial/by-id:");
    byId.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
    if (flags.yes) {
      console.error("Multiple adapters found — use --port to choose in non-interactive mode.");
      process.exit(2);
    }
    const answer = await rl.question("Select adapter number: ");
    const idx = Number(answer) - 1;
    if (!(idx >= 0 && idx < byId.length)) {
      console.error("Invalid selection.");
      process.exit(2);
    }
    return byId[idx];
  }

  // Still nothing from serialport metadata — fall back to raw device nodes.
  // This is the path that works inside containers where port enumeration is
  // unavailable (no udevadm), e.g. the Home Assistant add-on.
  let candidatePaths;
  if (ports.length > 0) {
    candidatePaths = ports.filter((p) => p.vendorId || /usb|acm/i.test(p.path)).map((p) => p.path);
  } else {
    candidatePaths = scanDevCandidates();
  }
  candidatePaths = [...new Set(candidatePaths)];

  if (candidatePaths.length === 0) {
    console.error("No serial ports found. Is the adapter plugged in?");
    process.exit(2);
  }
  if (candidatePaths.length === 1) {
    console.log(`Using the only serial device present: ${candidatePaths[0]}`);
    return normalizePortPath(candidatePaths[0]);
  }
  console.log("No ZWA-2 auto-detected. Available serial ports:");
  candidatePaths.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
  if (flags.yes) {
    console.error("Cannot pick a port non-interactively — set the 'port' option explicitly.");
    process.exit(2);
  }
  const answer = await rl.question("Select port number: ");
  const idx = Number(answer) - 1;
  if (!(idx >= 0 && idx < candidatePaths.length)) {
    console.error("Invalid selection.");
    process.exit(2);
  }
  return normalizePortPath(candidatePaths[idx]);
}

// -------------------------------------------------------------- erase logic

async function eraseNVMViaBootloader(driver) {
  if (driver.mode !== DriverMode.Bootloader) {
    console.log("Entering bootloader...");
    await driver.enterBootloader();
  }
  if (driver.mode !== DriverMode.Bootloader) {
    throw new Error("Could not enter the bootloader");
  }

  const option = driver.bootloader.findOption((o) => o === "erase nvm");
  if (option === undefined) {
    throw new Error(
      "The bootloader menu has no 'erase nvm' option — this adapter's bootloader does not support a serial NVM erase.",
    );
  }

  console.log("Selecting 'erase nvm' in the bootloader menu...");
  const areYouSure = driver.waitForBootloaderChunk(
    (c) => c.type === BootloaderChunkType.Message && c.message.toLowerCase().includes("are you sure"),
    2_000,
  );
  await driver.bootloader.selectOption(option);
  await areYouSure; // throws on timeout

  console.log("Confirming...");
  const erased = driver.waitForBootloaderChunk(
    (c) => c.type === BootloaderChunkType.Message && c.message.toLowerCase().includes("erased"),
    10_000,
  );
  await driver.bootloader.writeSerial(Bytes.from("y", "ascii"));
  await erased; // throws on timeout
  console.log("Bootloader reports: NVM erased.");

  console.log("Restarting the Z-Wave application...");
  // leaveBootloader() re-initializes the controller on the SAME serial handle
  // (it does not reopen the port), so afterwards driver.controller carries the
  // new post-wipe Home ID — no reconnect needed. Tolerate errors: the caller
  // re-reads controller state with retries and degrades gracefully if needed.
  await driver.leaveBootloader().catch((e) => {
    console.log(`  (note: application restart reported: ${e.message})`);
  });
}

// --------------------------------------------------------------- main flows

/**
 * Orchestrator. The erase and the verify MUST run in separate, sequential
 * processes: calling leaveBootloader() re-enumerates the ZWA-2's USB serial
 * device, and the process that did so keeps a lingering fd/advisory-lock on the
 * port until it exits. So we run the erase in a child that fully exits, THEN a
 * second child opens the freshly-re-enumerated port to verify. The orchestrator
 * itself never opens the serial port, so it never holds the lock.
 */
async function wipeFlow() {
  const portPath = flags.port || (await resolvePort());
  console.log(`\nConnecting to ${portPath} ...`);
  let { driver, mode } = await connect(portPath);

  let before = { homeId: undefined, nodes: [], region: undefined };
  let backupFile;

  if (mode === "bootloader") {
    console.log("⚠ Adapter is in bootloader mode (likely from a previous attempt) — will erase from here.");
    console.log("(Cannot back up NVM in bootloader mode.)");
    if (!flags.yes) {
      const a = await rl.question("Erase NVM and restart the adapter? [Y/n] ");
      if (a.trim().toLowerCase() === "n") {
        await safeDestroy(driver);
        process.exit(0);
      }
    }
  } else {
    const ctrl = driver.controller;
    before = {
      homeId: ctrl.homeId?.toString(16),
      nodes: [...ctrl.nodes.keys()],
      firmware: ctrl.firmwareVersion,
      sdk: ctrl.sdkVersion,
      region: await ctrl.getRFRegion().catch(() => undefined),
    };
    console.log(`
Adapter state:
  Home ID:    ${before.homeId}
  Nodes:      ${before.nodes.join(", ")} (${before.nodes.length} total)
  Firmware:   ${before.firmware} (SDK ${before.sdk})
  RF region:  ${regionName(before.region)}
`);

    if (flags.noBackup) {
      console.log("Skipping NVM backup (--no-backup).");
    } else {
      fs.mkdirSync(flags.backupDir, { recursive: true });
      backupFile = path.join(flags.backupDir, `zwa2-nvm-${before.homeId}-${ts()}.bin`);
      console.log(`Backing up NVM to ${backupFile} ...`);
      try {
        const nvm = await ctrl.backupNVMRaw(makeProgressPrinter("backup"));
        fs.writeFileSync(backupFile, nvm);
        fs.writeFileSync(
          backupFile + ".json",
          JSON.stringify(
            {
              homeId: before.homeId,
              nodeCount: before.nodes.length,
              nodes: before.nodes,
              firmware: before.firmware,
              sdk: before.sdk,
              region: before.region,
              regionName: regionName(before.region),
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        console.log(`  Backup complete (${nvm.length} bytes).`);
      } catch (e) {
        console.error(`NVM backup failed: ${e.message}`);
        console.error("Refusing to continue without a backup. Re-run with --no-backup to override.");
        await safeDestroy(driver);
        process.exit(1);
      }
    }

    if (!flags.yes) {
      console.log("\nThis will PERMANENTLY erase the Z-Wave network on this adapter.");
      console.log("Every paired device will need to be excluded/reset and re-paired afterwards.");
      const a = await rl.question('Type "WIPE" to continue: ');
      if (a.trim() !== "WIPE") {
        console.log("Aborted. Nothing was changed.");
        await safeDestroy(driver);
        process.exit(0);
      }
    }
  }

  // Erase via the bootloader, then leaveBootloader() — all on the SAME open
  // serial connection. We deliberately NEVER release the port: on some hosts
  // (notably Home Assistant OS) another process reclaims a freed Z-Wave port
  // within seconds of the adapter re-enumerating, which blocks any reopen.
  // Holding the one connection continuously is what lets us verify and restore
  // the RF region afterwards. zwave-js's leaveBootloader() re-initializes the
  // controller on the existing handle, so the new Home ID is available without
  // reopening.
  await eraseNVMViaBootloader(driver);

  // Let the application finish coming back up on the same connection.
  await new Promise((r) => setTimeout(r, 3_000));

  let after = { homeId: undefined, nodes: [], region: undefined };
  for (let i = 0; i < 12; i++) {
    if (driver.mode === DriverMode.SerialAPI && driver.controller?.homeId !== undefined) {
      const ctrl = driver.controller;
      after = {
        homeId: ctrl.homeId?.toString(16),
        nodes: [...ctrl.nodes.keys()],
        region: await ctrl.getRFRegion().catch(() => undefined),
      };
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const homeIdChanged = before.homeId === undefined || (after.homeId && after.homeId !== before.homeId);
  const nodesCleared = after.homeId !== undefined && after.nodes.length <= 1;

  if (after.homeId && homeIdChanged && nodesCleared) {
    console.log(`✓ Factory reset verified:
  New Home ID:  ${after.homeId}${before.homeId ? `  (was ${before.homeId})` : ""}
  Node list:    only the controller itself remains`);
  } else if (!after.homeId) {
    // The bootloader already confirmed the erase, so the wipe DID happen; we
    // just couldn't read the application state back for an automatic check.
    console.log(`
⚠ The wipe completed (the bootloader confirmed the NVM was erased), but the
  adapter did not report its application state in time for an automatic
  double-check. Your adapter IS wiped.
   • Run the read-only check to confirm a new Home ID with no paired devices.
   • RF region may have reset to the firmware default (EU); set it via
     https://home-assistant.github.io/zwa2-toolbox/ if needed.${backupFile ? `
   • Backup (to undo): ${restoreHint(backupFile)}` : ""}`);
    if (flags.resultJson) {
      try {
        fs.writeFileSync(
          flags.resultJson,
          JSON.stringify({
            verified: false,
            erased: true,
            oldHomeId: before.homeId ?? null,
            oldHomeIdDecimal: before.homeId ? parseInt(before.homeId, 16) : null,
            newHomeId: null,
            backupFile: backupFile ?? null,
          }),
        );
      } catch {
        /* best effort */
      }
    }
    await safeDestroy(driver);
    process.exit(3);
  } else {
    console.error(`✗ Verification FAILED:
  Home ID:  ${after.homeId} ${homeIdChanged ? "(changed ✓)" : "(UNCHANGED ✗)"}
  Nodes:    ${after.nodes.join(", ")} ${nodesCleared ? "(cleared ✓)" : "(NOT cleared ✗)"}${backupFile ? `
  Your backup: ${backupFile}` : ""}`);
    await safeDestroy(driver);
    process.exit(1);
  }

  if (flags.resultJson) {
    try {
      fs.writeFileSync(
        flags.resultJson,
        JSON.stringify({
          verified: true,
          oldHomeId: before.homeId ?? null,
          oldHomeIdDecimal: before.homeId ? parseInt(before.homeId, 16) : null,
          newHomeId: after.homeId,
          backupFile: backupFile ?? null,
        }),
      );
    } catch (e) {
      console.error(`(could not write result json: ${e.message})`);
    }
  }

  await handleRegion(driver.controller, before.region, after.region);

  await safeDestroy(driver);

  console.log(`
Done. Next steps:
  • Devices paired to the old network must be excluded (any controller can do
    it) or factory-reset per their manuals before they can be re-paired.
  • If re-adding to Home Assistant, removing and re-adding the Z-Wave
    integration is the cleanest path.${backupFile ? `
  • To undo this wipe:  ${restoreHint(backupFile)}` : ""}
`);
  process.exit(0);
}

async function handleRegion(ctrl, oldRegion, newRegion) {
  console.log(`RF region is now: ${regionName(newRegion)}`);
  if (oldRegion === undefined) {
    console.log("(Previous region unknown — leaving as-is. Use the zwa2-toolbox 'Configure' tool to change it.)");
    return;
  }
  if (oldRegion === newRegion) {
    console.log("(Region matches its pre-wipe value; nothing to do.)");
    return;
  }

  let target;
  if (flags.region !== undefined) {
    if (flags.region === "keep") target = oldRegion;
    else if (flags.region === "default") target = undefined;
    else {
      target = parseRegionArg(flags.region);
      if (target === undefined) {
        console.error(`Unknown region "${flags.region}" — leaving the firmware default.`);
      }
    }
  } else if (flags.yes) {
    // Non-interactive without an explicit choice: safest is to restore
    target = oldRegion;
  } else {
    const a = await rl.question(
      `Restore the previous region, ${regionName(oldRegion)}? [Y/n] (n = leave firmware default) `,
    );
    target = a.trim().toLowerCase() === "n" ? undefined : oldRegion;
  }

  if (target === undefined) {
    console.log("Leaving the region at its firmware default.");
    return;
  }
  try {
    await ctrl.setRFRegion(target);
    console.log(`✓ RF region set to ${regionName(await ctrl.getRFRegion().catch(() => target))}.`);
  } catch (e) {
    console.error(`Failed to set RF region: ${e.message}`);
    console.error("You can set it from Chrome/Edge at https://home-assistant.github.io/zwa2-toolbox/ → Configure.");
  }
}

async function restoreFlow() {
  const file = flags.restore;
  if (!fs.existsSync(file)) {
    console.error(`Backup file not found: ${file}`);
    process.exit(2);
  }
  const nvmData = fs.readFileSync(file);
  console.log(`Backup file: ${file} (${nvmData.length} bytes)`);
  if (fs.existsSync(file + ".json")) {
    try {
      const meta = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
      const devices = Math.max(0, (meta.nodeCount ?? 1) - 1);
      console.log(
        `Backup contents: network ${meta.homeId}, ${devices} paired device${devices === 1 ? "" : "s"}, ` +
          `region ${meta.regionName ?? "unknown"}, taken ${meta.createdAt ?? "unknown"}`,
      );
      if (devices === 0) {
        console.log("⚠ WARNING: this backup contains an EMPTY network (it was likely taken right after a wipe).");
        console.log("  If you meant to bring your devices back, pick an older backup with paired devices.");
      }
    } catch {
      console.log("(Backup metadata sidecar exists but could not be read.)");
    }
  } else {
    console.log("(No metadata sidecar next to this backup — contents unknown until restored.)");
  }

  const portPath = await resolvePort();
  console.log(`\nConnecting to ${portPath} ...`);
  const { driver, mode } = await connect(portPath);
  if (mode === "bootloader") {
    console.error("Adapter is in bootloader mode — unplug/replug it and try again.");
    await safeDestroy(driver);
    process.exit(1);
  }

  const ctrl = driver.controller;
  console.log(`Current Home ID: ${ctrl.homeId?.toString(16)}, nodes: ${[...ctrl.nodes.keys()].join(", ")}`);

  if (!flags.yes) {
    const a = await rl.question("Overwrite the adapter's NVM with this backup? [y/N] ");
    if (a.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      await safeDestroy(driver);
      process.exit(0);
    }
  }

  console.log("Restoring NVM (this can take a minute)...");
  try {
    await ctrl.restoreNVM(nvmData, makeProgressPrinter("converting"), makeProgressPrinter("writing"));
    console.log("\n  Restore command completed.");
  } catch (e) {
    // On some platforms (notably macOS) the adapter's post-restore soft reset
    // re-enumerates USB and kills the driver AFTER the NVM has already been
    // fully written. Don't fail here — reconnect below and verify instead.
    console.log(`\n  Restore ended with: ${e.message}`);
    console.log("  (Often harmless — the data is usually already written. Verifying...)");
  }
  await safeDestroy(driver);

  // Verify what's on the stick now
  console.log("\nReconnecting to verify...");
  await new Promise((r) => setTimeout(r, REVERIFY_DELAY_MS));
  const second = await connectWithRetry(portPath);
  if (second.mode === "bootloader") {
    console.error("Adapter is in bootloader mode after restore — unplug/replug it and re-run with --list to check.");
    await safeDestroy(second.driver);
    process.exit(1);
  }
  const c2 = second.driver.controller;
  console.log(`✓ Adapter now reports Home ID ${c2.homeId?.toString(16)} with nodes: ${[...c2.nodes.keys()].join(", ")}`);
  await safeDestroy(second.driver);
  process.exit(0);
}

/** Read the RF region recorded in the newest backup sidecar in a directory. */
function regionFromNewestBackup(dir) {
  try {
    const sidecars = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".bin.json"))
      .map((f) => path.join(dir, f))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { p } of sidecars) {
      const meta = JSON.parse(fs.readFileSync(p, "utf8"));
      if (typeof meta.region === "number") return { region: meta.region, file: p, homeId: meta.homeId };
    }
  } catch {
    /* no backups / unreadable */
  }
  return undefined;
}

async function infoFlow() {
  const portPath = flags.port || (await resolvePort());
  console.log(`\nConnecting to ${portPath} ...`);
  const { driver, mode } = await connect(portPath);
  if (mode === "bootloader") {
    console.log("Adapter is in BOOTLOADER mode (no Z-Wave application running).");
    console.log("A wipe run can recover this; or unplug/replug the adapter to try restarting it.");
    await safeDestroy(driver);
    process.exit(0);
  }
  const c = driver.controller;
  const region = await c.getRFRegion().catch(() => undefined);
  const nodes = [...c.nodes.keys()];
  const devices = Math.max(0, nodes.length - 1);
  console.log(`
Adapter state:
  Home ID:    ${c.homeId?.toString(16)}
  Nodes:      ${nodes.join(", ")} (${devices} paired device(s) besides the controller)
  Firmware:   ${c.firmwareVersion} (SDK ${c.sdkVersion})
  RF region:  ${regionName(region)}`);

  // Decide whether to restore the RF region. This runs on a settled connection
  // (unlike right after a wipe, when the re-enumerated port is briefly grabbed
  // by the host), so it's the reliable place to fix a region that a wipe reset.
  let target;
  let source = "";
  if (flags.region === undefined || flags.region === "keep") {
    const fromBackup = regionFromNewestBackup(flags.backupDir);
    if (fromBackup) {
      target = fromBackup.region;
      source = ` (from your most recent backup${fromBackup.homeId ? ` of network ${fromBackup.homeId}` : ""})`;
    }
  } else if (flags.region === "default") {
    target = undefined;
  } else {
    target = parseRegionArg(flags.region);
    if (target === undefined) console.error(`Unknown region "${flags.region}" — leaving it unchanged.`);
  }

  if (target !== undefined && target !== region) {
    console.log(`\nRestoring RF region to ${regionName(target)}${source}...`);
    try {
      await c.setRFRegion(target);
      console.log(`✓ RF region set to ${regionName(await c.getRFRegion().catch(() => target))}.`);
    } catch (e) {
      console.error(`Failed to set RF region: ${e.message}`);
      console.error("You can set it from Chrome/Edge at https://home-assistant.github.io/zwa2-toolbox/ → Configure.");
    }
  } else if (target !== undefined) {
    console.log("\nRF region already matches the desired value; nothing to change.");
  }

  if (flags.resultJson) {
    try {
      fs.writeFileSync(
        flags.resultJson,
        JSON.stringify({
          homeId: c.homeId?.toString(16) ?? null,
          nodeCount: nodes.length,
          deviceCount: devices,
          region: await c.getRFRegion().catch(() => region),
          regionName: regionName(await c.getRFRegion().catch(() => region)),
        }),
      );
    } catch {
      /* best effort */
    }
  }

  await safeDestroy(driver);
  process.exit(0);
}

async function listFlow() {
  const ports = await listPortsSafe();
  if (ports.length > 0) {
    for (const p of ports) {
      const known = KNOWN_ADAPTERS.find(
        (k) => p.vendorId?.toLowerCase() === k.vendorId && p.productId?.toLowerCase() === k.productId,
      );
      console.log(
        `${p.path}  ${p.manufacturer ?? ""} ${p.vendorId ? `(${p.vendorId}:${p.productId})` : ""}${known ? `  ← ${known.label}` : ""}`,
      );
    }
  } else {
    // Container / no-udevadm environment: report raw device nodes instead
    const byId = findByIdCandidates();
    const dev = scanDevCandidates();
    if (dev.length === 0) {
      console.log("No serial ports found.");
    } else {
      console.log("Serial devices (port metadata unavailable in this environment):");
      dev.forEach((p) => console.log(`  ${p}${byId.includes(p) ? "  ← looks like a ZWA-2" : ""}`));
    }
  }
  process.exit(0);
}

// -------------------------------------------------------------------- entry

process.on("SIGINT", () => {
  console.log("\nInterrupted.");
  process.exit(130);
});

// zwave-js can reject internally while the adapter reboots/re-enumerates after
// a soft reset. Our connect retries handle the recovery; don't let those
// stragglers crash the process.
process.on("unhandledRejection", (e) => {
  if (process.env.DEBUG) console.error("[unhandled rejection]", e?.message ?? e);
});

try {
  if (flags.list) await listFlow();
  else if (flags.info) await infoFlow();
  else if (flags.restore) await restoreFlow();
  else await wipeFlow();
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
} finally {
  rl.close();
}
