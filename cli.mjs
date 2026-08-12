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
const REVERIFY_DELAY_MS = 2_000;
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
async function connectWithRetry(portPath, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = 3_000 * i;
      console.log(`  (connect attempt ${i} failed: ${lastErr.message} — retrying in ${delay / 1000}s)`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await connect(portPath);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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

async function resolvePort() {
  if (flags.port) return flags.port;

  const ports = await SerialPort.list();
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

  // Still nothing — offer everything that looks like a serial port
  const candidates = ports.filter((p) => p.vendorId || /usb|acm/i.test(p.path));
  if (candidates.length === 0) {
    console.error("No serial ports found. Is the adapter plugged in?");
    process.exit(2);
  }
  console.log("No ZWA-2 auto-detected. Available serial ports:");
  candidates.forEach((p, i) =>
    console.log(
      `  [${i + 1}] ${p.path}  ${p.manufacturer ?? ""} ${p.vendorId ? `(${p.vendorId}:${p.productId})` : ""}`,
    ),
  );
  if (flags.yes) {
    console.error("Cannot pick a port non-interactively — use --port.");
    process.exit(2);
  }
  const answer = await rl.question("Select port number: ");
  const idx = Number(answer) - 1;
  if (!(idx >= 0 && idx < candidates.length)) {
    console.error("Invalid selection.");
    process.exit(2);
  }
  return normalizePortPath(candidates[idx].path);
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
  await driver.leaveBootloader().catch(() => {
    // Some platforms lose the serial connection briefly here; the fresh
    // verification connection below is what actually matters.
  });
}

// --------------------------------------------------------------- main flows

async function wipeFlow() {
  const portPath = await resolvePort();

  console.log(`\nConnecting to ${portPath} ...`);
  let { driver, mode } = await connect(portPath);

  if (mode === "bootloader") {
    console.log("⚠ Adapter is currently stuck in bootloader mode (likely from a previous attempt).");
    if (!flags.yes) {
      const a = await rl.question("Erase NVM from here and restart it? [Y/n] ");
      if (a.trim().toLowerCase() === "n") {
        await safeDestroy(driver);
        process.exit(0);
      }
    }
    await eraseNVMViaBootloader(driver);
    await safeDestroy(driver);
    await verifyAndFinish(portPath, { homeId: undefined, region: undefined });
    return;
  }

  // ---- gather pre-wipe state
  const ctrl = driver.controller;
  const before = {
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

  // ---- backup
  let backupFile;
  if (flags.noBackup) {
    console.log("Skipping NVM backup (--no-backup).");
  } else {
    fs.mkdirSync(flags.backupDir, { recursive: true });
    backupFile = path.join(flags.backupDir, `zwa2-nvm-${before.homeId}-${ts()}.bin`);
    console.log(`Backing up NVM to ${backupFile} ...`);
    try {
      const nvm = await ctrl.backupNVMRaw(makeProgressPrinter("backup"));
      fs.writeFileSync(backupFile, nvm);
      // Sidecar so a human (or the restore flow) can tell what's inside
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

  // ---- confirm
  if (!flags.yes) {
    console.log("This will PERMANENTLY erase the Z-Wave network on this adapter.");
    console.log("Every paired device will need to be excluded/reset and re-paired afterwards.");
    const a = await rl.question('Type "WIPE" to continue: ');
    if (a.trim() !== "WIPE") {
      console.log("Aborted. Nothing was changed.");
      await safeDestroy(driver);
      process.exit(0);
    }
  }

  // ---- erase
  await eraseNVMViaBootloader(driver);
  await safeDestroy(driver);

  await verifyAndFinish(portPath, before, backupFile);
}

async function verifyAndFinish(portPath, before, backupFile) {
  console.log("\nVerifying the reset...");
  await new Promise((r) => setTimeout(r, REVERIFY_DELAY_MS));

  let { driver, mode } = await connectWithRetry(portPath);

  if (mode === "bootloader") {
    // One rescue attempt, then bail with instructions
    console.log("Adapter came back in bootloader mode — attempting to start the application...");
    await driver.leaveBootloader().catch(() => {});
    await safeDestroy(driver);
    await new Promise((r) => setTimeout(r, REVERIFY_DELAY_MS));
    ({ driver, mode } = await connectWithRetry(portPath));
    if (mode === "bootloader") {
      await safeDestroy(driver);
      console.error(`
✗ The adapter is stuck in bootloader mode.
  1. Unplug it, wait 5 seconds, and plug it back in, then re-run this tool.
  2. If it is still stuck, use the official recovery tool in Chrome/Edge:
     https://home-assistant.github.io/zwa2-toolbox/  →  "Recover adapter"${backupFile ? `
  3. Your NVM backup is safe at: ${backupFile}
     You can restore it later with:  ${restoreHint(backupFile)}` : ""}`);
      process.exit(1);
    }
  }

  const ctrl = driver.controller;
  const after = {
    homeId: ctrl.homeId?.toString(16),
    nodes: [...ctrl.nodes.keys()],
    region: await ctrl.getRFRegion().catch(() => undefined),
  };

  const homeIdChanged = before.homeId === undefined || after.homeId !== before.homeId;
  const nodesCleared = after.nodes.length === 1;

  if (homeIdChanged && nodesCleared) {
    console.log(`✓ Factory reset verified:
  New Home ID:  ${after.homeId}${before.homeId ? `  (was ${before.homeId})` : ""}
  Node list:    only the controller itself remains`);
  } else {
    console.error(`✗ Verification FAILED:
  Home ID:  ${after.homeId} ${homeIdChanged ? "(changed ✓)" : "(UNCHANGED ✗)"}
  Nodes:    ${after.nodes.join(", ")} ${nodesCleared ? "(cleared ✓)" : "(NOT cleared ✗)"}${backupFile ? `
  Your backup: ${backupFile}` : ""}`);
    await safeDestroy(driver);
    process.exit(1);
  }

  // Machine-readable summary for wrappers (e.g. the HA add-on)
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

  // ---- RF region handling
  await handleRegion(ctrl, before.region, after.region);

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

async function infoFlow() {
  const portPath = await resolvePort();
  console.log(`\nConnecting to ${portPath} (read-only check)...`);
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
  console.log(`
Adapter state (nothing was changed):
  Home ID:    ${c.homeId?.toString(16)}
  Nodes:      ${nodes.join(", ")} (${Math.max(0, nodes.length - 1)} paired device(s) besides the controller)
  Firmware:   ${c.firmwareVersion} (SDK ${c.sdkVersion})
  RF region:  ${regionName(region)}`);
  await safeDestroy(driver);
  process.exit(0);
}

async function listFlow() {
  const ports = await SerialPort.list();
  if (ports.length === 0) {
    console.log("No serial ports found.");
  } else {
    for (const p of ports) {
      const known = KNOWN_ADAPTERS.find(
        (k) => p.vendorId?.toLowerCase() === k.vendorId && p.productId?.toLowerCase() === k.productId,
      );
      console.log(
        `${p.path}  ${p.manufacturer ?? ""} ${p.vendorId ? `(${p.vendorId}:${p.productId})` : ""}${known ? `  ← ${known.label}` : ""}`,
      );
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
