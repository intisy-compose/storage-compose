FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends snapraid=12.4-1 smartmontools=7.4-3 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY snapraid.sh /usr/local/bin/snapraid.sh
RUN chmod +x /usr/local/bin/snapraid.sh
ENTRYPOINT ["/usr/local/bin/snapraid.sh"]
