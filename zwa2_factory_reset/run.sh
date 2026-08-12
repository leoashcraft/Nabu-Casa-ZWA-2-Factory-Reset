#!/usr/bin/with-contenv bashio
set -e

ACTION=$(bashio::config 'action')
CONFIRM=$(bashio::config 'confirm')
PORT=$(bashio::config 'port')
REGION=$(bashio::config 'region')
RESTORE_FILE=$(bashio::config 'restore_file')

BACKUP_DIR=/share/zwa2-factory-reset/backups
mkdir -p "${BACKUP_DIR}"

ARGS=(--yes --backup-dir "${BACKUP_DIR}")
if [ -n "${PORT}" ] && [ "${PORT}" != "auto" ]; then
    ARGS+=(--port "${PORT}")
fi

bashio::log.info "Reminder: the Z-Wave JS add-on must be STOPPED while this runs."

case "${ACTION}" in
    list)
        exec node /app/cli.mjs --list
        ;;
    restore)
        if [ -z "${RESTORE_FILE}" ]; then
            bashio::log.fatal "Set 'restore_file' to a backup path (e.g. /share/zwa2-factory-reset/backups/....bin) to restore."
            exit 1
        fi
        exec node /app/cli.mjs --restore "${RESTORE_FILE}" "${ARGS[@]}"
        ;;
    wipe)
        if [ "${CONFIRM}" != "true" ]; then
            bashio::log.fatal "Refusing to wipe: this PERMANENTLY erases the Z-Wave network on the adapter."
            bashio::log.fatal "Set 'confirm: true' in the add-on Configuration tab, then start the add-on again."
            exit 1
        fi
        exec node /app/cli.mjs "${ARGS[@]}" --region "${REGION}"
        ;;
    *)
        bashio::log.fatal "Unknown action '${ACTION}' (use wipe, restore, or list)"
        exit 1
        ;;
esac
