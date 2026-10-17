#!/bin/bash
# One HTTP request on stdin, as ntfy would get it: the title, priority and message are appended to the
# capture log, one line each, and the request is answered with 200.
set -u
log=/var/log/ntfy-capture.log
title=''
priority=''
length=0

read -r _ path _
while IFS= read -r line; do
    line=${line%$'\r'}
    [ -z "$line" ] && break
    case ${line,,} in
        title:*) title=${line#*: } ;;
        priority:*) priority=${line#*: } ;;
        content-length:*) length=${line#*: } ;;
    esac
done
body=
[ "$length" -gt 0 ] && IFS= read -r -N "$length" body
echo "$(date +%s) ${path#/} p$priority $title | $body" >> "$log"
printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'
