# Mint in a container. No npm install and no build step: the image is the Node runtime plus the source.
# node:sqlite ships inside Node 22, so there is nothing else to add.
FROM node:22-alpine

ENV NODE_ENV=production \
    MINT_HOME=/data \
    MINT_HOST=0.0.0.0 \
    MINT_PORT=8970

WORKDIR /app
# Only what the server and the demo need. The tests, docs and Android shell stay out (see .dockerignore).
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY test/fixtures ./test/fixtures
COPY LICENSE ./

# The `node` user (uid 1000) ships with the image. /data holds the database, receipts and backups.
# a checkout with a tight umask would otherwise leave files the node user cannot read
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8970

# /healthz is open to the local check and needs no gateway headers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MINT_PORT||8970)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.mjs"]
