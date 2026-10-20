# Built with images/ as the context: the dashboard runs the same snapraid.sh as the scheduler, so
# every change to the array goes through one script and one job lock.
FROM debian:trixie-slim AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs=20.19.2+dfsg-1+deb13u3 npm=9.2.0~ds1-3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY dashboard/package.json dashboard/package-lock.json dashboard/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/src ./src
RUN npx tsc -p tsconfig.json

FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs=20.19.2+dfsg-1+deb13u3 snapraid=12.4-1 smartmontools=7.4-3 \
       e2fsprogs=1.47.2-3+b12 fdisk util-linux jq=1.7.1-6+deb13u4 git=1:2.47.3-0+deb13u1 \
       openssh-client=1:10.0p1-7+deb13u4 ca-certificates=20250419 \
    && rm -rf /var/lib/apt/lists/*
COPY mounter/lib/nodefile.sh /usr/local/lib/storage/nodefile.sh
COPY snapraid/snapraid-run.sh /usr/local/bin/snapraid
RUN chmod +x /usr/local/bin/snapraid
COPY snapraid/snapraid.sh /usr/local/bin/snapraid.sh
RUN chmod +x /usr/local/bin/snapraid.sh
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY dashboard/public ./public
ENTRYPOINT ["node", "/app/dist/server.js"]
