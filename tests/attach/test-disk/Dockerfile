FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends qemu-utils=1:10.0.13+ds-0+deb13u1 fdisk=2.41.5-0+deb13u1 \
       e2fsprogs=1.47.2-3+b12 \
    && rm -rf /var/lib/apt/lists/*
COPY make-test-disk.sh /usr/local/bin/make-test-disk.sh
RUN chmod +x /usr/local/bin/make-test-disk.sh
ENTRYPOINT ["/usr/local/bin/make-test-disk.sh"]
