# ZWA-2 Factory Reset

Factory-resets a Home Assistant Connect ZWA-2 when the normal factory reset silently fails (a known firmware bug). **A backup is always taken first, so everything this add-on does can be undone.**

## Built-in safety features

- **Nothing destructive can happen by accident.** The default action is `check` (read-only), and a wipe or restore refuses to run unless you set `confirm: true` first.
- **`confirm` resets itself.** After a successful wipe or restore, the add-on flips `confirm` back to `false`, so starting the add-on again later can't wipe anything.
- **Automatic backup.** Every wipe saves the adapter's complete network to `/share/zwa2-factory-reset/backups/` *before* touching anything. If the backup fails, the wipe is cancelled.
- **Z-Wave JS guard.** If the Z-Wave JS add-on is running (it holds the adapter's port), this add-on stops and tells you — it won't fight over the port. Set `manage_zwave_js: true` to have it stopped and restarted for you automatically.
- **Verification.** After a wipe, the add-on reconnects and confirms the adapter really has a fresh network and is running normally. A watchdog aborts with a clear error rather than hanging forever.
- **Region preservation.** Wiping resets the adapter's radio region to the factory default (EU). The add-on remembers your region and restores it (`region: keep`, the default) — important if you're not in Europe.

## Recommended first run

1. Install the add-on, leave all options at their defaults (`action: check`).
2. Start it and read the Log tab: you'll see your adapter's Home ID, how many devices are paired, its firmware, and its region. **Nothing is changed.**

## Doing a factory reset

1. In this add-on's **Configuration** tab: set `action: wipe` and `confirm: true`. Leave `manage_zwave_js: true` so the add-on frees the port for you (otherwise stop the Z-Wave JS add-on yourself first).
2. **Start** the add-on and watch the **Log** tab. You'll see: backup → `Bootloader reports: NVM erased` → the adapter restarts with a **new Home ID**.
3. **Finish with a check (Home Assistant OS).** When the adapter restarts, its USB re-enumerates and the host briefly grabs the port, so the wipe often can't verify itself or restore the RF region in the same run. If the log ends with *"TO FINISH: set action to check…"*, set `action: check` (leave `region: keep`), Save, and Start again. The check runs on a settled connection and both confirms the new Home ID with no devices **and restores your RF region from the backup**. On desktops and some systems the wipe does this automatically in one run — the check step is only needed when the log asks for it.
4. `confirm` resets itself to `false` after the wipe. Your backup path is printed in the log (kept in `/share/zwa2-factory-reset/backups/`).

## Undoing things (walking back)

| What happened | How to walk it back |
|---|---|
| Wiped and regret it | Set `action: restore` and `restore_file` to the backup path from the log (also visible in `/share/zwa2-factory-reset/backups/`), set `confirm: true`, start the add-on. Your network — Home ID, devices, security keys — comes back exactly as it was. |
| Restored the wrong backup | Restore a different one. Every wipe's backup stays in `/share` until you delete it. Each `.bin` has a `.json` next to it describing what's inside (network ID, device count, date) — and the add-on warns you before restoring a backup that contains an empty network. |
| Region is wrong after a wipe | Set `action: check` to see the current region. To change it, use the official [ZWA-2 Toolbox](https://home-assistant.github.io/zwa2-toolbox/) → Configure (Chrome/Edge), or open an issue and we'll add a region-only action. |
| Adapter seems dead / stuck in bootloader | The add-on recovers this automatically in most cases. If not: unplug the adapter, wait 5 seconds, plug it back in, run `action: check`. Last resort: [ZWA-2 Toolbox](https://home-assistant.github.io/zwa2-toolbox/) → Recover adapter. |
| Devices show as dead in HA after a wipe | Expected — the old network is gone. Either restore the backup to bring it back, or re-pair each device (they must be excluded or factory-reset per their manuals first). To clear the dead entries from HA, set `cleanup_ha_devices: true` before the wipe, or remove the old network's integration entry yourself (Settings → Devices & Services → Z-Wave). |
| Used `cleanup_ha_devices` and want the devices list back | Restore the NVM backup (`action: restore`), then re-add the Z-Wave integration — HA re-discovers the adapter and re-creates the devices from the restored network. Entity customizations (renames, areas, automations referencing old entity IDs) may need to be redone, so prefer manual cleanup if you're unsure. |

## Options reference

| Option | Values | Meaning |
|---|---|---|
| `action` | `check` / `wipe` / `restore` / `list` | `check` = read-only adapter report (default, safe). `list` = show serial ports. |
| `confirm` | `true` / `false` | Required for `wipe` and `restore`. Auto-resets to `false` after success. |
| `manage_zwave_js` | `true` / `false` | Stop the Z-Wave JS add-on before running and restart it after. |
| `cleanup_ha_devices` | `true` / `false` | After a verified wipe, remove the Home Assistant integration entry (and its devices) that belonged to the **old, wiped network only** — identified by the old network's Home ID, so any other Z-Wave adapters you have are never touched. If more than one entry matches (ambiguous), nothing is removed and you're told to clean up manually. |
| `port` | `auto` or a device path | `auto` finds the ZWA-2 by USB IDs or `/dev/serial/by-id` name. |
| `region` | `keep` / `default` / a region name | `keep` (default) restores your pre-wipe region. `default` leaves the factory EU default. |
| `restore_file` | path | The `.bin` backup to restore (for `action: restore`). |

## What about cached node data?

Two different things get "left behind" by a wipe:

- **Home Assistant's device registry** — the old network's devices linger as dead entries. That's what `cleanup_ha_devices` handles (or manual removal of the old integration entry). Scoped strictly to the wiped network's Home ID.
- **The Z-Wave JS driver's internal cache** (files inside the Z-Wave JS add-on, keyed by Home ID) — intentionally **left alone**. After a wipe the adapter has a new Home ID, so the old cache files are simply never read again. And if you *restore* your backup, that cache becomes useful again — it saves a full re-interview of every device. Deleting it would only hurt.

## Notes

- Backup files contain your network's security keys. Anyone with the file could impersonate your network — treat backups as sensitive and delete them when no longer needed.
- This add-on needs the `manager` role (stop/start Z-Wave JS, reset its own `confirm` option) and Home Assistant API access (for `cleanup_ha_devices`).
