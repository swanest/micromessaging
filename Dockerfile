# -- BASE --
FROM alpine:3.9 AS base
RUN apk add --no-cache nodejs tini ca-certificates yarn
ENV DEBUG=micromessaging
# Create app directory
WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--"]
COPY package.json ./

# -- DEPENDENCIES --
FROM base AS dependencies
COPY yarn.lock ./
RUN yarn install -q

# -- TEST --
FROM dependencies AS test
COPY tslint.json tsconfig.json ./
COPY src src
RUN yarn build

# -- DEV --
FROM test AS dev
CMD ["tail", "-f", "/dev/null"]
