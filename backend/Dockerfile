FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --no-fund --no-audit

COPY . .
RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/index.js"]
