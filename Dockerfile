FROM node:20-slim

WORKDIR /app

COPY package.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/anker/package.json packages/anker/package.json
COPY packages/tuya/package.json packages/tuya/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm install

COPY tsconfig.json ./
COPY packages ./packages

CMD ["npx", "tsx", "watch", "packages/cli/src/index.ts", "run"]
