FROM node:20-slim

# nmap: one-off LAN discovery aid (find a Tuya device's local IP by scanning
# for its open local-protocol port, e.g. `nmap -p 6668 --open 192.168.1.0/24`)
# - not used by the app itself at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends nmap && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PATH="/app/node_modules/.bin:${PATH}"

COPY package.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/anker/package.json packages/anker/package.json
COPY packages/tuya/package.json packages/tuya/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm install

COPY tsconfig.json ./
COPY packages ./packages

# npm install (above) ran before packages/cli/src existed, so it silently
# skipped linking the "soltrk" bin (bin-links checks the target exists).
# Link it now that the real source is in place.
RUN ln -sf ../../packages/cli/src/index.ts node_modules/.bin/soltrk

CMD ["npx", "tsx", "watch", "packages/cli/src/index.ts", "run"]
