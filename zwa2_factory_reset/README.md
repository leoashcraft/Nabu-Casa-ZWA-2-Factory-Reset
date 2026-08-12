# ZWA-2 Factory Reset (Home Assistant add-on)

> ⚠️ **Experimental.** The underlying CLI is tested on real hardware; this add-on packaging is new. Please report issues.

Factory-reset a **Home Assistant Connect ZWA-2** via the Gecko bootloader — works even when Home Assistant's own "Factory reset" button silently fails due to the firmware's `SetDefault` bug. Backs up the NVM to `/share/zwa2-factory-reset/backups/` first, verifies the wipe, and preserves your RF region.

See [DOCS](DOCS.md) for usage. Full background in the [repository README](https://github.com/leoashcraft/zwa2-factory-reset).
