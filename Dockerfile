FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

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
