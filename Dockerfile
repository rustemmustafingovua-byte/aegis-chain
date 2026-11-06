FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build
EXPOSE 8899 3899
CMD ["npm", "run", "serve", "--", "--port=8899"]
