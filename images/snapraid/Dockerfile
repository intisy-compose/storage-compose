# Built with images/ as the context, for the node file library the mounter shares.
FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends snapraid=12.4-1 smartmontools=7.4-3 \
       e2fsprogs=1.47.2-3+b12 fdisk util-linux jq=1.7.1-6+deb13u4 \
    && rm -rf /var/lib/apt/lists/*
COPY mounter/lib/nodefile.sh /usr/local/lib/storage/nodefile.sh
COPY snapraid/snapraid.sh /usr/local/bin/snapraid.sh
COPY snapraid/snapraid-run.sh /usr/local/bin/snapraid
COPY snapraid/migrate-labels.sh /usr/local/bin/migrate-labels.sh
RUN chmod +x /usr/local/bin/snapraid.sh /usr/local/bin/snapraid /usr/local/bin/migrate-labels.sh
ENTRYPOINT ["/usr/local/bin/snapraid.sh"]
