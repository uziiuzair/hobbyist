Self-signed certificates for `tls.test.ts`, valid for 100 years, never used
outside tests. Two, so the reload test can tell which one is being served by
its common name. Regenerate with:

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout first.key -out first.crt -days 36500 \
      -subj /CN=first.test -addext subjectAltName=DNS:first.test
