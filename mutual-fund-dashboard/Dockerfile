# Equity Fund Scoring dashboard -- React/Vite build served by nginx.
#
# Two stages: node compiles the bundle, then only the static output is copied
# into nginx. Node is absent from the final image, which is a few MB.

FROM node:22-alpine AS build

# Vite inlines VITE_API_BASE_URL at BUILD time -- it is not read at runtime.
# Changing the API URL therefore requires rebuilding this image, not just
# restarting the container. Must be a URL the user's BROWSER can reach, so it
# is the API's public hostname, never an internal Docker service name.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

WORKDIR /build

# npm ci needs both files and installs exactly what the lockfile pins.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM nginx:1.27-alpine

# No `apk add tzdata` -- this container only serves static files (no app-level
# code cares what timezone it thinks it's in, unlike the API's scheduler), so
# it's not worth an Alpine package mirror needing to be reachable at build
# time just for log-timestamp cosmetics.

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html

EXPOSE 80

# wget ships with Alpine's busybox base -- no extra `apk add curl` needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
