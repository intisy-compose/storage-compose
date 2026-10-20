FROM ghcr.io/syncthing/syncthing:2.1.6 AS syncthing

FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 ca-certificates=20250419 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=syncthing /bin/syncthing /usr/local/bin/syncthing
COPY nodes.sh /usr/local/bin/nodes.sh
RUN chmod +x /usr/local/bin/nodes.sh
ENTRYPOINT ["/usr/local/bin/nodes.sh"]
