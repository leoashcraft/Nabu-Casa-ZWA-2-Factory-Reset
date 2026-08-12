#!/usr/bin/with-contenv bashio
# Safety-first wrapper around the zwa2-factory-reset CLI.
set +e

ACTION=$(bashio::config 'action')
CONFIRM=$(bashio::config 'confirm')
MANAGE_ZWJS=$(bashio::config 'manage_zwave_js')
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

# Z-Wave JS add-ons that could be holding the serial port
ZWJS_SLUGS="core_zwave_js a0d7b954_zwavejsui a0d7b954_zwavejs2mqtt"
STOPPED_SLUGS=""

zwjs_state() {
    bashio::api.supervisor "GET" "/addons/${1}/info" "" ".state" 2>/dev/null || echo "not_installed"
}

ensure_port_free() {
    for slug in ${ZWJS_SLUGS}; do
        state=$(zwjs_state "${slug}")
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
        node /app/cli.mjs "${ARGS[@]}" --region "${REGION}"
        RC=$?
        restart_stopped
        [ ${RC} -eq 0 ] && reset_confirm
        exit ${RC}
        ;;
    *)
        bashio::log.fatal "Unknown action '${ACTION}' (use check, wipe, restore, or list)"
        exit 1
        ;;
esac
