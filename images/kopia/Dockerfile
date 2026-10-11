# Kopia publishes its image only on Docker Hub, so it is built from the release binary, checksum-pinned.
FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG KOPIA_VERSION=0.23.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && case "$TARGETARCH" in \
         amd64) asset=linux-x64; sha256=416d0f84a3dbb321a8b2d8f0997b1a0a6e915babe79ee76fa6e4d2bd1e1c5178 ;; \
         arm64) asset=linux-arm64; sha256=a4ffbc019e0b0f932e2632054e73ec521dc1e80172a00095369c53ecf4e5a6cb ;; \
         *) echo "no Kopia build for $TARGETARCH"; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/kopia.tar.gz "https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}/kopia-${KOPIA_VERSION}-${asset}.tar.gz" \
    && echo "$sha256  /tmp/kopia.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/kopia.tar.gz -C /tmp \
    && mv "/tmp/kopia-${KOPIA_VERSION}-${asset}/kopia" /usr/local/bin/kopia \
    && rm -rf /tmp/kopia* \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY kopia.sh /usr/local/bin/kopia.sh
RUN chmod +x /usr/local/bin/kopia.sh
ENTRYPOINT ["/usr/local/bin/kopia.sh"]
