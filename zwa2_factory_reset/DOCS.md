# ZWA-2 Factory Reset

Factory-resets a Home Assistant Connect ZWA-2 by erasing its NVM from the Gecko bootloader, bypassing the firmware's broken `SetDefault` handler. An NVM backup is always written first so the operation is reversible.

## ⚠️ Before you start

1. **Stop the Z-Wave JS add-on** (Settings → Add-ons → Z-Wave JS → Stop). The serial port must be free — this add-on will fail with a port error otherwise.
2. Understand that a wipe **permanently erases the Z-Wave network** on the adapter: every paired device must be excluded or factory-reset before it can be re-paired.

## Options

| Option | Values | Meaning |
|---|---|---|
| `action` | `wipe` / `restore` / `list` | What to do. `list` just prints detected serial ports to the log — a safe first run. |
| `confirm` | `true` / `false` | Must be `true` for a wipe to proceed. Safety interlock. |
| `port` | `auto` or a device path | `auto` finds the ZWA-2 by its USB IDs. Otherwise e.g. `/dev/serial/by-id/usb-Nabu_Casa_ZWA-2_...` |
| `region` | `keep` / `default` / region name | `keep` restores the RF region the stick had before the wipe (recommended). `default` leaves the firmware default (EU). Or name one, e.g. `Europe`, `USA (Long Range)`. |
| `restore_file` | path | For `action: restore` — a backup file, e.g. `/share/zwa2-factory-reset/backups/zwa2-nvm-xxxx.bin` |

## Typical wipe

1. Stop the Z-Wave JS add-on.
2. Set `action: wipe`, `confirm: true` in Configuration and save.
3. Start this add-on and watch the Log tab. You should see: backup → `Bootloader reports: NVM erased` → `✓ Factory reset verified` with a **new Home ID**.
4. Note the backup path printed in the log (kept in `/share/zwa2-factory-reset/backups/`).
5. Set `confirm` back to `false` (so a stray start can't wipe again).
6. Start the Z-Wave JS add-on again — or remove/re-add the Z-Wave integration for a clean slate.

## Undo a wipe

Set `action: restore` and `restore_file` to the backup path from the log, then start the add-on. This puts back the complete network (Home ID, nodes, security keys).

## Troubleshooting

- **"Cannot lock port" / port errors** — the Z-Wave JS add-on (or Z-Wave JS UI) is still running. Stop it first.
- **Stuck in bootloader** — the add-on tries to recover automatically. If it stays stuck, unplug/replug the ZWA-2 and run again with `action: list` to check it's detected. As a last resort use the official [ZWA-2 Toolbox](https://home-assistant.github.io/zwa2-toolbox/) "Recover adapter" from Chrome/Edge on another machine.
- **Verification failed: Home ID unchanged** — re-run the wipe. If it persists, open an issue with the log.
