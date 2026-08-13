FROM node:22-bookworm

WORKDIR /app

COPY backend/package*.json ./backend/
RUN cd backend && npm install --no-fund --no-audit

COPY backend ./backend
COPY frontend ./frontend

RUN cd backend && npx tsc

EXPOSE 3000 8100

CMD ["bash", "-lc", "cd /app/backend && node dist/index.js"]
