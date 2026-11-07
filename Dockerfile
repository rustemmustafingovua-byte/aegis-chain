FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/explorer ./explorer
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docs ./docs
USER node
EXPOSE 8899 3899 4899
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8899/health || exit 1
CMD ["npm", "run", "serve", "--", "--port=8899"]
