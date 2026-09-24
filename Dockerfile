FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# No npm install needed: the app has zero dependencies.
COPY --chown=node:node package.json server.js taglines.json sponsors.json ./
COPY --chown=node:node locales ./locales
COPY --chown=node:node public ./public

# Share cards are written here; mount a volume so they survive container rebuilds.
RUN mkdir -p /app/data/cards && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/config > /dev/null || exit 1

CMD ["node", "server.js"]
