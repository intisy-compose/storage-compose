# The test bench: makes the loop and device-mapper drives, injects the faults, captures what would go
# to ntfy, and owns the network namespace the array's Syncthing joins in the test.
FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends dmsetup=2:1.02.205-2 e2fsprogs=1.47.2-3+b12 util-linux \
       jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 socat=1.8.0.3-1+deb13u1 procps=2:4.0.4-9 \
    && rm -rf /var/lib/apt/lists/*
COPY lab.sh capture.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/lab.sh /usr/local/bin/capture.sh
ENTRYPOINT ["/usr/local/bin/lab.sh"]
CMD ["serve"]
