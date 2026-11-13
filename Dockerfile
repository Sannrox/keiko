# The whole box in one image: the server, the seed command, and the TLS
# authority generator (bash, openssl, flock). TypeScript runs directly.
FROM node:24.11.1-alpine3.22
RUN apk add --no-cache bash openssl util-linux-misc
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npx --yes pnpm@12.15.0 install --prod --frozen-lockfile && rm -rf /root/.npm /root/.cache
COPY src ./src
COPY scripts/db-tls.sh ./scripts/db-tls.sh
# tls/ is a volume shared with the database; the generator runs as node.
RUN mkdir tls && chown node:node tls
USER node
ENTRYPOINT ["node", "src/main.ts"]
CMD ["serve"]
