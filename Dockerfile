FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --include=dev --legacy-peer-deps

COPY . .

ENV VITE_BASE_PATH=/
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]
