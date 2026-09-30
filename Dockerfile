FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/node/server.ts"]
