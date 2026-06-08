# Stage 1: build the Vite app
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: production server
FROM node:20-alpine AS runtime
WORKDIR /app

# Install server-side deps (busboy + ws only; qr-scanner stays frontend-only)
RUN npm install --prefer-offline busboy@^1 ws@^8

# Generate a self-signed TLS cert; camera access requires HTTPS on non-localhost origins.
# Mount your own cert/key via CERT_FILE / KEY_FILE env vars to use a trusted cert.
RUN apk add --no-cache openssl && \
    mkdir -p /certs && \
    openssl req -x509 -newkey rsa:2048 \
      -keyout /certs/key.pem -out /certs/cert.pem \
      -days 3650 -nodes \
      -subj '/CN=ha-matter-utils'

COPY --from=build /app/dist ./dist
COPY server.js ./

EXPOSE 5173
CMD ["node", "server.js"]
