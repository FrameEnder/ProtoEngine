FROM node:20-alpine

WORKDIR /app

# Build toolchain needed to compile better-sqlite3's native addon on Alpine
# (musl). python3/make/g++ are required by node-gyp. We install them, build,
# then drop them in the same layer to keep the image small.
COPY package.json package-lock.json* ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm install --omit=dev --no-audit --no-fund \
  && npm rebuild better-sqlite3 \
  && apk del .build-deps

COPY . .

# Data and uploaded icons should be persisted via a volume.
RUN mkdir -p data/sessions public/icons

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run as the built-in non-root node user.
RUN chown -R node:node /app
USER node

CMD ["node", "server.js"]
