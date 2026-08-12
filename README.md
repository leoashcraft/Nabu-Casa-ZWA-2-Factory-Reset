# zwa2-factory-reset

Factory-reset a **Home Assistant Connect ZWA-2** Z-Wave adapter — even when the normal factory reset silently fails.

There are **two ways to use it**, same engine underneath — pick whichever fits you:

| | Best for | What you do |
|---|---|---|
| 🖥️ **Standalone command-line tool** | Any computer with the stick plugged in — no Home Assistant needed | `npm install`, then `node cli.mjs` |
| 🏠 **Home Assistant add-on** | Home Assistant OS / Supervised users | Add the repo, install, **Open Web UI**, click a button |

No Z-Wave PC Controller and no Windows-only tooling required either way.

**Supported systems for the standalone tool:** macOS and Linux are tested. **Windows should work too** — Node.js, `serialport`, and `zwave-js` all support it (the adapter appears as a COM port like `COM5`) — but it hasn't been tested on Windows yet, so treat it as best-effort.

![The ZWA-2 Factory Reset Home Assistant add-on web UI](img/zwa2-factory-reset-screenshot.avif)

## Table of contents

- [The problem this solves](#the-problem-this-solves)
- [How this tool works around it](#how-this-tool-works-around-it)
- [Option A — Standalone command-line tool](#option-a--standalone-command-line-tool)
  - [Install](#install)
  - [Usage](#usage)
  - [Options](#options)
  - [Undo a wipe](#undo-a-wipe)
- [Option B — Home Assistant add-on](#option-b--home-assistant-add-on)
- [RF region](#rf-region)
- [After a successful wipe](#after-a-successful-wipe)
- [Troubleshooting](#troubleshooting)
- [Other adapters](#other-adapters)
- [Safety notes](#safety-notes)
- [Credits](#credits)

## The problem this solves

The ZWA-2's Z-Wave firmware (observed on v1.2, SDK 8.0) has a bug where the standard factory-reset command (`SetDefault`) is acknowledged — the stick even sends back the "reset complete" callback — **but the network data survives untouched**. This was confirmed at the raw serial level:

```
DRIVER » [REQ] [HardReset]          ← SetDefault sent
SERIAL « [ACK]                      ← stick accepts it
DRIVER « [REQ] [HardReset]          ← stick claims completion
CNTRLR   hard reset succeeded
...but the Home ID and node list are unchanged, even after a power cycle.
```

This is why Home Assistant's own **Factory reset** button can fail silently on this adapter: it sends that exact command through the same driver.

## How this tool works around it

Home Assistant publishes an official [ZWA-2 Toolbox](https://home-assistant.github.io/zwa2-toolbox/) whose source contains a lower-level wipe: reboot the Z-Wave chip into its **Gecko bootloader** and use the bootloader's own `erase nvm` menu command — erasing the flash directly, so the buggy firmware handler is never involved. That wizard is currently disabled in the hosted toolbox UI, so this tool replicates the exact same procedure locally using the same [Z-Wave JS](https://github.com/zwave-js/zwave-js) driver library:

1. Connect over USB serial and record the adapter's state (Home ID, node list, firmware, **RF region**)
2. **Back up the full NVM** to a file (so the wipe is reversible)
3. Reboot the Z-Wave chip into the Gecko bootloader
4. Select `erase nvm`, confirm, and wait for the bootloader's `NVM erased` message
5. Restart the application firmware
6. **Reconnect and verify**: new Home ID, empty node list, and not stuck in the bootloader
7. Offer to restore your previous RF region (a full NVM erase resets it to the firmware default)

## Option A — Standalone command-line tool

Run it on any computer with the ZWA-2 plugged in (macOS and Linux tested; Windows should work — see the note above). **No Home Assistant required** — handy when your HA install is the thing that's misbehaving, or you just want to wipe a stick on a laptop.

### Install

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/leoashcraft/zwa2-factory-reset.git
cd zwa2-factory-reset
npm install
```

### Usage

Plug in the adapter, then:

```bash
node cli.mjs
```

The tool auto-detects the ZWA-2 by its USB identifiers (Espressif `303a:4001`, manufacturer "Nabu Casa"). If more than one is plugged in you'll be asked which one to target; if none is detected you can pick a port manually — `--port /dev/cu.usbmodemXXXX` on macOS, `--port /dev/ttyACM0` on Linux, or `--port COM5` on Windows. **Close anything else using the stick first** (Home Assistant, Z-Wave JS UI, etc.) — the port must be free.

You'll see the adapter's current state, an NVM backup will be written to `./backups/`, and you must type `WIPE` to confirm before anything destructive happens.

### Options

| Flag | Meaning |
|---|---|
| `--list` | List detected serial ports and exit |
| `--port <path>` | Use a specific port (skips auto-detection) |
| `--restore <file>` | Restore a previous NVM backup instead of wiping |
| `--region keep` | After the wipe, restore the RF region the stick had before |
| `--region default` | Leave the RF region at the firmware default |
| `--region <name\|number>` | Set a specific region (e.g. `Europe`, `USA`, `9`). Applies on wipe and on `--info` (check). |
| `--backup-dir <dir>` | Where to write backups (default `./backups`) |
| `--no-backup` | Skip the backup (not recommended) |
| `--yes` / `-y` | Non-interactive; skips confirmations |

### Undo a wipe

Every run (unless `--no-backup`) writes a timestamped backup first. To roll back:

```bash
node cli.mjs --restore backups/zwa2-nvm-<homeid>-<timestamp>.bin
```

This restores the complete network — Home ID, paired nodes, security keys — exactly as it was.

## Option B — Home Assistant add-on

If you run **Home Assistant OS or Supervised**, install this as an add-on with a one-click web interface — no configuration:

1. Settings → Add-ons → Add-on Store → ⋮ (top right) → **Repositories** → add
   `https://github.com/leoashcraft/zwa2-factory-reset`
2. Install **ZWA-2 Factory Reset**, click **Start**, then **Open Web UI**.
3. Click **Factory reset this adapter**, confirm, and watch the live log. That single button stops Z-Wave JS, backs up the network to `/share/zwa2-factory-reset/backups/`, erases via the bootloader, verifies the result, restores your RF region, optionally removes the old devices from Home Assistant, and restarts Z-Wave JS.

There's also a **Check adapter** button (safe, read-only) and **Restore a backup** button. See the [add-on documentation](zwa2_factory_reset/DOCS.md). Tested on Home Assistant OS with a real ZWA-2. HA Container/Core installs can't use add-ons — use the CLI on the host instead.

## RF region

Erasing the NVM resets the radio region to the firmware default. Because not everyone is in the US, the tool records your region **before** wiping and asks afterwards whether to restore it or leave the default (or use `--region` to decide up front). You can also change it any time with the official toolbox's **Configure** tool in Chrome/Edge.

## After a successful wipe

- The stick is factory-fresh and ready to start a new network. A new random Home ID is generated on first boot.
- **Devices paired to the old network still believe they're in it.** Each must be excluded (any Z-Wave controller can perform exclusion) or factory-reset per its manual before it can be re-paired.
- If you're re-adding the stick to Home Assistant and it still has the old Z-Wave integration config, removing and re-adding the integration is the cleanest path.
- Keep an eye out for a ZWA-2 firmware update that fixes the `SetDefault` bug — the [toolbox](https://home-assistant.github.io/zwa2-toolbox/) can flash firmware from the browser when one ships.

## Troubleshooting

**"Failed to open the serial port" / "Cannot lock port"** — something else has the stick open. Stop Home Assistant / Z-Wave JS UI or any other process using it (`lsof /dev/cu.usbmodem*` on macOS, `lsof /dev/ttyACM*` on Linux; on Windows, close any serial monitor / Z-Wave software holding the COM port).

**Adapter stuck in bootloader mode** — the tool detects this on connect and on verify, and will try to start the application firmware for you. If it stays stuck: unplug it, wait 5 seconds, plug it back in, and re-run. Still stuck? Use **Recover adapter** in the official [ZWA-2 Toolbox](https://home-assistant.github.io/zwa2-toolbox/) (Chrome/Edge). Your NVM backup remains valid either way.

**Verification failed: Home ID unchanged** — the wipe didn't take. Re-run the tool; if it persists, your bootloader may not expose `erase nvm` (see below).

**"'erase nvm' option not found"** — your adapter's bootloader menu doesn't offer a serial NVM erase. This tool targets the ZWA-2 (Gecko Bootloader v3.x); other Silicon Labs 700/800-series sticks may work but are untested.

## Other adapters

The bootloader-erase technique applies to any Silicon Labs 700/800-series Z-Wave adapter whose Gecko bootloader is reachable over serial and offers the `erase nvm` menu option. Auto-detection only knows the ZWA-2's USB IDs, but you can point the tool at any adapter with `--port`. Test with `--list` first, and know that anything but a ZWA-2 is uncharted territory.

## Safety notes

- The NVM backup is taken **before** anything destructive and the tool refuses to continue if the backup fails (override with `--no-backup` at your own risk).
- The wipe erases network data only — the Z-Wave application firmware itself is untouched (the bootloader's `erase nvm` does not touch the application flash).
- Security keys for the old network live in that backup file. Treat it as sensitive.

## Credits

- The erase procedure is taken from Home Assistant's official [zwa2-toolbox](https://github.com/home-assistant/zwa2-toolbox) source.
- Built on [Z-Wave JS](https://github.com/zwave-js/zwave-js).

## License

MIT
