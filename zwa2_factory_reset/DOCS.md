# ZWA-2 Factory Reset

Wipes a Home Assistant Connect ZWA-2 back to factory settings — even when Home Assistant's own factory reset silently fails (a known firmware bug). Everything is done from a simple web page: **there is nothing to configure.**

## How to use it

1. Install the add-on and click **START**.
2. Click **OPEN WEB UI** (also appears as "ZWA-2 Reset" in the sidebar).
3. On the page you get three buttons:
   - **Check adapter** — shows what's on the stick right now. Changes nothing.
   - **Factory reset this adapter** — the big one. Asks you to confirm, then does everything automatically and shows a live progress log.
   - **Restore a backup** — roll the adapter back to a saved network.

That's it. You never touch YAML or toggles.

## What "Factory reset" does for you

Behind that one button, the add-on:

1. Stops the Z-Wave JS add-on so the adapter is free (and restarts it when finished).
2. **Backs up** the adapter's full network to `/share/zwa2-factory-reset/backups/` — so the wipe can be undone.
3. Erases the Z-Wave network via the adapter's bootloader (the reliable method that works around the firmware bug).
4. Verifies the adapter came back with a fresh, empty network and restores your **RF region**.
5. Optionally (checkbox) removes the **old network's devices from Home Assistant** — and only that network's, identified by its Home ID, so any other Z-Wave adapters are left untouched.

## After a reset

- Your devices need to be re-added: exclude or factory-reset each one (per its manual), then pair it to the new network.
- If you're re-adding the stick to Home Assistant, removing and re-adding the Z-Wave integration is the cleanest path.
- Changed your mind? Use **Restore a backup** and pick the backup from just before the wipe.

## Notes & safety

- A backup is always made before a wipe, and the wipe refuses to proceed if the backup fails.
- Backups contain your network's security keys — treat the files in `/share/zwa2-factory-reset/backups/` as sensitive and delete them when no longer needed.
- The **Restore** list warns you if a backup contains an empty network (i.e. one taken right after a wipe).
- The add-on needs the `manager` role (to stop/start Z-Wave JS) and Home Assistant API access (for the optional device cleanup).
- Only Home Assistant OS / Supervised support add-ons. On HA Container/Core, use the command-line tool from the [repository](https://github.com/leoashcraft/zwa2-factory-reset) instead.
