FROM alpine:3.20
RUN apk add --no-cache busybox-extras && mkdir -p /www && echo ok > /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
