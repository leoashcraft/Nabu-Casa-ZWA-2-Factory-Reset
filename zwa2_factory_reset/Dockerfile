ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install dependencies first, keyed only on package.json — so editing the
# script does NOT trigger a full npm reinstall on rebuild.
COPY package.json ./
# serialport ships musl prebuilds for common arches; the build deps are a
# fallback for anything without one (e.g. armv7), removed again afterwards.
RUN apk add --no-cache --virtual .build python3 make g++ linux-headers \
    && npm install --omit=dev --no-audit --no-fund \
    && apk del .build \
    && npm cache clean --force

# App code and UI change often; keep them in later, cheap layers.
COPY cli.mjs server.mjs ./
COPY www ./www
COPY run.sh /
RUN chmod a+x /run.sh
# Launch via with-contenv so SUPERVISOR_TOKEN and friends are in the env.
CMD [ "/run.sh" ]
