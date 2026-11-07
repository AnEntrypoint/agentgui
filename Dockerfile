FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 BASE_URL=/gm
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
COPY site ./site
EXPOSE 3000
CMD ["node", "server.js"]
