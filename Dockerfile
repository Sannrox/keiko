# The whole box in one image: the server, the seed command, and the TLS
# authority generator (bash, openssl, flock). TypeScript runs directly.
FROM node:24.11.1-alpine3.22
LABEL org.opencontainers.image.source="https://github.com/Sannrox/keiko"
LABEL org.opencontainers.image.licenses="Apache-2.0"
RUN apk add --no-cache bash openssl util-linux-misc
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npx --yes pnpm@12.15.0 install --prod --frozen-lockfile && rm -rf /root/.npm /root/.cache
COPY src ./src
COPY scripts/db-tls.sh ./scripts/db-tls.sh
# The box's own compose file, read by the release's install command.
COPY compose.yaml ./
# tls/ is a volume shared with the database; the generator runs as node.
RUN mkdir tls && chown node:node tls
USER node
ENTRYPOINT ["node", "src/main.ts"]
CMD ["serve"]
