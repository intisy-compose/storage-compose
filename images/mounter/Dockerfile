FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b12 rsync util-linux \
       smartmontools=7.4-3 jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 ca-certificates=20250419 attr=1:2.5.2-3 \
       inotify-tools=4.23.9.0-2+b1 \
    && rm -rf /var/lib/apt/lists/*
COPY lib/ /usr/local/lib/storage/
COPY mounter.sh /usr/local/bin/mounter.sh
RUN chmod +x /usr/local/bin/mounter.sh
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s CMD test -f /run/mounter.ready
ENTRYPOINT ["/usr/local/bin/mounter.sh"]
