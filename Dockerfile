FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates curl --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Chromium Headless Shell (Playwright) — a stripped-down headless-only Chromium
# build with a much smaller memory footprint than a full browser. --with-deps also
# installs the system libraries it needs (libasound2, libnss3, etc.) via apt.
RUN npx playwright install --with-deps chromium-headless-shell

COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "src/app.js"]
