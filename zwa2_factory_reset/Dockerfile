ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json cli.mjs ./

# serialport ships musl prebuilds for common arches; the build deps are a
# fallback for anything without one (e.g. armv7), removed again afterwards.
RUN apk add --no-cache --virtual .build python3 make g++ linux-headers \
    && npm install --omit=dev --no-audit --no-fund \
    && apk del .build \
    && npm cache clean --force

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
