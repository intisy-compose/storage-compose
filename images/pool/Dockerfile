FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends mergerfs=2.40.2-5 fuse3 attr util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY pool.sh /usr/local/bin/pool.sh
RUN chmod +x /usr/local/bin/pool.sh
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD mountpoint -q /mnt/storage/pool && test -d /mnt/storage/pool/kopia
ENTRYPOINT ["/usr/local/bin/pool.sh"]
