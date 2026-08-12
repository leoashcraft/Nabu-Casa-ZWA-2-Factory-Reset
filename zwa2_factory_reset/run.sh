#!/usr/bin/with-contenv bashio
# Safety-first wrapper around the zwa2-factory-reset CLI.
set +e

ACTION=$(bashio::config 'action')
CONFIRM=$(bashio::config 'confirm')
MANAGE_ZWJS=$(bashio::config 'manage_zwave_js')
CLEANUP_HA=$(bashio::config 'cleanup_ha_devices')
PORT=$(bashio::config 'port')
REGION=$(bashio::config 'region')
RESTORE_FILE=$(bashio::config 'restore_file')

BACKUP_DIR=/share/zwa2-factory-reset/backups
mkdir -p "${BACKUP_DIR}"

# Make the CLI's "to undo this" hints speak add-on language, not node commands
export ZWA2_RESTORE_HINT="set action: restore and restore_file: {file} in this add-on's Configuration tab, then start the add-on"

ARGS=(--yes --backup-dir "${BACKUP_DIR}")
if [ -n "${PORT}" ] && [ "${PORT}" != "auto" ]; then
    ARGS+=(--port "${PORT}")
fi

# Z-Wave JS add-ons that could be holding the serial port. We only probe the
# ones actually installed (avoids noisy 404s in the log for the rest).
ZWJS_SLUGS="core_zwave_js a0d7b954_zwavejsui a0d7b954_zwavejs2mqtt"
STOPPED_SLUGS=""
INSTALLED_ADDONS=""

load_installed_addons() {
    # One call: the slugs of every installed add-on
    INSTALLED_ADDONS=$(bashio::api.supervisor "GET" "/addons" false ".addons[].slug" 2>/dev/null || echo "")
}

ensure_port_free() {
    load_installed_addons
    for slug in ${ZWJS_SLUGS}; do
        # Skip slugs that aren't installed — probing them would 404
        echo "${INSTALLED_ADDONS}" | grep -qx "${slug}" || continue
        state=$(bashio::api.supervisor "GET" "/addons/${slug}/info" false ".state" 2>/dev/null || echo "unknown")
        if [ "${state}" = "started" ]; then
            if [ "${MANAGE_ZWJS}" = "true" ]; then
                bashio::log.info "Stopping ${slug} to free the serial port (will restart it afterwards)..."
                if bashio::api.supervisor "POST" "/addons/${slug}/stop" > /dev/null 2>&1; then
                    STOPPED_SLUGS="${STOPPED_SLUGS} ${slug}"
                    sleep 3
                else
                    bashio::log.fatal "Could not stop ${slug} automatically. Stop it manually and run again."
                    exit 1
                fi
            else
                bashio::log.fatal "The '${slug}' add-on is running and holds the Z-Wave adapter's serial port."
                bashio::log.fatal "Either stop it first (Settings → Add-ons → Z-Wave JS → STOP), or set"
                bashio::log.fatal "'manage_zwave_js: true' in this add-on's Configuration to have it stopped"
                bashio::log.fatal "and restarted automatically. Nothing was changed."
                exit 1
            fi
        fi
    done
}

restart_stopped() {
    for slug in ${STOPPED_SLUGS}; do
        bashio::log.info "Restarting ${slug}..."
        bashio::api.supervisor "POST" "/addons/${slug}/start" > /dev/null 2>&1 \
            || bashio::log.warning "Could not restart ${slug} automatically — start it from Settings → Add-ons."
    done
}

# Optionally remove the HA integration entry that belonged to the OLD (wiped)
# network — identified by the old Home ID, so other Z-Wave adapters/networks
# the user may have are never touched. Devices/entities of that entry are
# removed by HA along with it.
cleanup_ha_devices() {
    local old_dec="$1" old_hex="$2"
    if [ -z "${old_dec}" ] || [ "${old_dec}" = "null" ]; then
        bashio::log.warning "Old Home ID unknown — skipping HA device cleanup."
        return 0
    fi

    bashio::log.info "Looking for the HA integration entry of the old network (${old_hex})..."
    # One template call: find zwave_js config entries whose devices carry the
    # old network's identifiers ("<homeId-decimal>-<nodeId>").
    local template result
    template=$(cat <<TEMPLATE
{% set ns = namespace(entries=[]) %}
{% for e in integration_entities('zwave_js') %}
{% set d = device_id(e) %}
{% if d %}
{% set ids = device_attr(d, 'identifiers') | string %}
{% if "'${old_dec}-" in ids %}
{% set ns.entries = ns.entries + [config_entry_id(e)] %}
{% endif %}
{% endif %}
{% endfor %}
{{ ns.entries | unique | list | to_json }}
TEMPLATE
)
    result=$(curl -sf -X POST \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        -H "Content-Type: application/json" \
        "http://supervisor/core/api/template" \
        -d "$(jq -cn --arg t "${template}" '{template: $t}')" 2>/dev/null)

    if [ -z "${result}" ]; then
        bashio::log.warning "Could not query Home Assistant for old-network devices."
        bashio::log.warning "Clean up manually: Settings → Devices & Services → Z-Wave → remove the entry whose devices are all dead."
        return 0
    fi

    local count entry_id
    count=$(echo "${result}" | jq 'length' 2>/dev/null || echo 0)
    if [ "${count}" = "0" ]; then
        bashio::log.info "No HA integration entry references the old network — nothing to clean up."
        return 0
    fi
    if [ "${count}" != "1" ]; then
        bashio::log.warning "Found ${count} integration entries referencing the old network — ambiguous, not touching anything."
        bashio::log.warning "Clean up manually: Settings → Devices & Services → Z-Wave."
        return 0
    fi

    entry_id=$(echo "${result}" | jq -r '.[0]')
    bashio::log.notice "Removing HA integration entry ${entry_id} (old network ${old_hex} and ONLY that network)..."
    if curl -sf -X DELETE \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        "http://supervisor/core/api/config/config_entries/entry/${entry_id}" > /dev/null 2>&1; then
        bashio::log.info "Old network's integration entry and its devices removed from Home Assistant."
        bashio::log.info "When Z-Wave JS starts again, HA will offer to set up the (now blank) adapter fresh."
    else
        bashio::log.warning "Could not remove the integration entry automatically."
        bashio::log.warning "Remove it manually: Settings → Devices & Services → Z-Wave → old entry → Delete."
    fi
}

# After a successful destructive run, flip 'confirm' back to false so an
# accidental later start of this add-on cannot wipe anything.
reset_confirm() {
    local opts
    opts=$(bashio::addon.config | jq -c '.confirm = false') || return 1
    if bashio::api.supervisor "POST" "/addons/self/options" "{\"options\": ${opts}}" > /dev/null 2>&1; then
        bashio::log.info "Safety: 'confirm' has been reset to false. Set it to true again for the next destructive run."
    else
        bashio::log.warning "Could not reset 'confirm' automatically — please set it back to false in Configuration."
    fi
}

case "${ACTION}" in
    list)
        node /app/cli.mjs --list
        exit $?
        ;;
    check)
        ensure_port_free
        node /app/cli.mjs --info "${ARGS[@]}"
        RC=$?
        restart_stopped
        if [ ${RC} -eq 0 ]; then
            bashio::log.info "======================================================================"
            bashio::log.info "This was a safe, read-only check — nothing was changed."
            bashio::log.info "To FACTORY RESET this adapter:"
            bashio::log.info "  1. Open the Configuration tab above."
            bashio::log.info "  2. Set 'action' to 'wipe' and turn 'confirm' ON."
            bashio::log.info "  3. (Optional) turn 'cleanup_ha_devices' ON to also remove the old"
            bashio::log.info "     devices from Home Assistant."
            bashio::log.info "  4. Save, then Start this add-on again and watch this log."
            bashio::log.info "A backup is always saved first, so a wipe can be undone."
            bashio::log.info "======================================================================"
        fi
        exit ${RC}
        ;;
    restore)
        if [ -z "${RESTORE_FILE}" ]; then
            bashio::log.fatal "Set 'restore_file' to a backup path (e.g. ${BACKUP_DIR}/zwa2-nvm-....bin)."
            bashio::log.fatal "Available backups:"
            ls -1 "${BACKUP_DIR}" 2>/dev/null | grep -v '\.json$' | while read -r f; do bashio::log.fatal "  ${BACKUP_DIR}/${f}"; done
            exit 1
        fi
        if [ "${CONFIRM}" != "true" ]; then
            bashio::log.fatal "Restoring OVERWRITES the adapter's current network with the backup."
            bashio::log.fatal "Set 'confirm: true' in the Configuration tab, then start the add-on again."
            exit 1
        fi
        ensure_port_free
        node /app/cli.mjs --restore "${RESTORE_FILE}" "${ARGS[@]}"
        RC=$?
        restart_stopped
        [ ${RC} -eq 0 ] && reset_confirm
        exit ${RC}
        ;;
    wipe)
        if [ "${CONFIRM}" != "true" ]; then
            bashio::log.fatal "Refusing to wipe: this PERMANENTLY erases the Z-Wave network on the adapter."
            bashio::log.fatal "Every paired device will need to be re-paired afterwards."
            bashio::log.fatal "A backup is always taken first, so this can be undone with action: restore."
            bashio::log.fatal "If you are sure: set 'confirm: true' in the Configuration tab and start the add-on again."
            exit 1
        fi
        ensure_port_free
        RESULT_JSON=/tmp/zwa2-result.json
        rm -f "${RESULT_JSON}"
        node /app/cli.mjs "${ARGS[@]}" --region "${REGION}" --result-json "${RESULT_JSON}"
        RC=$?
        # RC 0 = fully verified; RC 3 = erased OK but couldn't reopen to
        # verify/restore-region (still a successful wipe); other = real failure.
        if [ ${RC} -eq 0 ] && [ "${CLEANUP_HA}" = "true" ] && [ -s "${RESULT_JSON}" ]; then
            OLD_DEC=$(jq -r '.oldHomeIdDecimal' "${RESULT_JSON}")
            OLD_HEX=$(jq -r '.oldHomeId' "${RESULT_JSON}")
            cleanup_ha_devices "${OLD_DEC}" "${OLD_HEX}"
        elif [ ${RC} -eq 0 ] && [ "${CLEANUP_HA}" != "true" ]; then
            bashio::log.info "Tip: the old network's devices will show as dead in Home Assistant."
            bashio::log.info "Set 'cleanup_ha_devices: true' to have ONLY that network's integration entry removed automatically,"
            bashio::log.info "or remove it yourself: Settings → Devices & Services → Z-Wave."
        elif [ ${RC} -eq 3 ]; then
            bashio::log.warning "Wipe completed, but the adapter could not be reopened to verify/restore region (see above)."
        fi
        restart_stopped
        # confirm auto-resets after a successful (0) or partial-success (3) wipe
        { [ ${RC} -eq 0 ] || [ ${RC} -eq 3 ]; } && reset_confirm
        [ ${RC} -eq 3 ] && exit 0
        exit ${RC}
        ;;
    *)
        bashio::log.fatal "Unknown action '${ACTION}' (use check, wipe, restore, or list)"
        exit 1
        ;;
esac
