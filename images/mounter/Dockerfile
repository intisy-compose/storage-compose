FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b12 rsync util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY mounter.sh /usr/local/bin/mounter.sh
RUN chmod +x /usr/local/bin/mounter.sh
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s CMD test -f /run/mounter.ready
ENTRYPOINT ["/usr/local/bin/mounter.sh"]
