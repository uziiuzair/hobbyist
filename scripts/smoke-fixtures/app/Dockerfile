# The smallest app that proves the HTTP wake path: busybox httpd serving one
# file whose body the smoke runner checks for, so a router error page or a
# different app answering cannot pass for this one. Alpine's busybox has no
# httpd applet, which is why busybox-extras is installed (the same as
# scripts/fixtures/static).
FROM alpine:3.20
RUN apk add --no-cache busybox-extras && mkdir -p /www && echo hobby-smoke-app-ok > /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
