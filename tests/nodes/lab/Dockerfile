# The nodes test's bench: makes the loop drives and volumes and reads the API from inside the stack.
FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b12 util-linux jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 \
    && rm -rf /var/lib/apt/lists/*
COPY lab.sh /usr/local/bin/lab.sh
RUN chmod +x /usr/local/bin/lab.sh
ENTRYPOINT ["/usr/local/bin/lab.sh"]
CMD ["serve"]
