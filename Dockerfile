# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Compile the MCP server into a standalone binary
RUN bun build --compile --minify --sourcemap ./src/mcp/server.ts --outfile relatr

# copy production dependencies and compiled binary into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/relatr .

# copy necessary source files for runtime (schema, etc.)
COPY --from=prerelease /usr/src/app/src/database/schema.sql ./src/database/schema.sql

# run the compiled binary directly
# Use --user flag when running docker to match host user UID
# Example: docker run --user $(id -u):$(id -g) ...
EXPOSE 3000/tcp
CMD [ "./relatr" ]