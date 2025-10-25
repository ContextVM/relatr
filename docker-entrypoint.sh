#!/usr/bin/env sh
set -eu

DATA_DIR=${DATA_DIR:-/usr/src/app/data}
RUN_UID=${RELATR_UID:-1000}
RUN_GID=${RELATR_GID:-1000}
SKIP_CHOWN=${RELATR_SKIP_CHOWN:-false}
RUN_USER=relatr
RUN_GROUP=relatr

log() {
    printf '%s\n' "$*" >&2
}

ensure_identity() {
    if ! command -v getent >/dev/null 2>&1; then
        log "[entrypoint] getent not available; cannot manage runtime user/group"
        return 1
    fi

    if ! getent group "${RUN_GROUP}" >/dev/null 2>&1; then
        groupadd --system --gid "${RUN_GID}" "${RUN_GROUP}"
    else
        CURRENT_GID=$(getent group "${RUN_GROUP}" | cut -d: -f3)
        if [ "${CURRENT_GID}" != "${RUN_GID}" ]; then
            groupmod -o -g "${RUN_GID}" "${RUN_GROUP}"
        fi
    fi

    if ! getent passwd "${RUN_USER}" >/dev/null 2>&1; then
        useradd --system --home-dir /usr/src/app --gid "${RUN_GROUP}" --uid "${RUN_UID}" "${RUN_USER}"
    else
        CURRENT_UID=$(id -u "${RUN_USER}")
        if [ "${CURRENT_UID}" != "${RUN_UID}" ]; then
            usermod -o -u "${RUN_UID}" "${RUN_USER}"
        fi
    fi
}

prepare_data_dir() {
    mkdir -p "${DATA_DIR}"

    if command -v stat >/dev/null 2>&1; then
        OWNER_UID=$(stat -c '%u' "${DATA_DIR}")
        OWNER_GID=$(stat -c '%g' "${DATA_DIR}")
    else
        OWNER_UID=
        OWNER_GID=
    fi

    if [ "${OWNER_UID}" != "${RUN_UID}" ] || [ "${OWNER_GID}" != "${RUN_GID}" ]; then
        chown "${RUN_UID}:${RUN_GID}" "${DATA_DIR}"
    fi

    chmod 0770 "${DATA_DIR}"
}

if [ "${SKIP_CHOWN}" = "true" ] || [ "${SKIP_CHOWN}" = "1" ]; then
    log "[entrypoint] Skipping ownership adjustments (RELATR_SKIP_CHOWN=${SKIP_CHOWN})"
else
    if [ "$(id -u)" -eq 0 ]; then
        ensure_identity
        prepare_data_dir
    else
        log "[entrypoint] Not running as root; cannot adjust ownership automatically"
    fi
fi

if [ "$(id -u)" -eq 0 ]; then
    exec gosu "${RUN_USER}:${RUN_GROUP}" "$@"
else
    exec "$@"
fi