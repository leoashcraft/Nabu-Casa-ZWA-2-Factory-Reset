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
5. Optionally (checkbox, on by default) removes the **old Z-Wave integration from Home Assistant** — and only the one matching this network's Home ID, so any other Z-Wave adapters are left untouched. This clears the stale cached devices that otherwise can't be deleted one-by-one.

## After a reset — finish in Home Assistant

Wiping the stick is only half the job. Home Assistant keeps its own copy of the old network (a config entry — the "hub" — keyed to the old Home ID), and it still owns all the old devices, so you **can't remove those devices individually**. The live log spells this out, but in short:

1. **Remove the old Z-Wave integration.** Done for you if you left *"Also remove the old Z-Wave integration"* ticked. By hand: *Settings → Devices & Services → Z-Wave → ⋮ → Delete* — this clears all its cached devices at once.
2. **Restart Home Assistant** (*Settings → System → ⋮ → Restart Home Assistant*) to clear leftover state.
3. **Re-add the adapter.** When HA comes back, the ZWA-2 appears as a newly **discovered** device under *Settings → Devices & Services* — click it to set up a clean network on the new Home ID.
4. **Re-pair your devices:** exclude or factory-reset each one (per its manual), then pair it to the new network.

Changed your mind entirely? Use **Restore a backup** and pick the backup from just before the wipe.

## Notes & safety

- A backup is always made before a wipe, and the wipe refuses to proceed if the backup fails.
- Backups contain your network's security keys — treat the files in `/share/zwa2-factory-reset/backups/` as sensitive and delete them when no longer needed.
- The **Restore** list warns you if a backup contains an empty network (i.e. one taken right after a wipe).
- The add-on needs the `manager` role (to stop/start Z-Wave JS) and Home Assistant API access (for the optional device cleanup).
- Only Home Assistant OS / Supervised support add-ons. On HA Container/Core, use the command-line tool from the [repository](https://github.com/leoashcraft/Nabu-Casa-ZWA-2-Factory-Reset) instead.
