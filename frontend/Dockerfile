FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` alone, not `npm ci || npm install`. The fallback made a lockfile that
# disagreed with package.json a silent non-event: npm install would resolve
# fresh versions, write a different tree than CI's `npm ci` step validated, and
# the docker-images job could never detect the drift it exists to catch.
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
