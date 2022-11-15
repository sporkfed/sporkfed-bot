#
# Production Dependencies stage
FROM node:16-alpine AS production-dependencies
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --production

#
# Dev Dependencies stage
FROM production-dependencies AS dev-dependencies

RUN yarn install

#
# Build stage
FROM dev-dependencies AS build

COPY ./ ./
RUN yarn build

#
# Local Runtime Stage
FROM dev-dependencies AS local-runtime

COPY --from=build /app/package.json /app/yarn.lock /app/lib ./
RUN yarn cache clean --force

ENV NODE_ENV="production"
CMD [ "npx", "probot", "run", "./index.js" ]

#
# Runtime Stage
FROM production-dependencies AS runtime

COPY --from=build /app/package.json /app/yarn.lock /app/lib ./
RUN yarn cache clean --force

ENV NODE_ENV="production"
CMD [ "npx", "probot", "run", "./index.js" ]
