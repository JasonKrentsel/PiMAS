# First supported target: the pinned Ubuntu 24.04 telecom task environment.
# Other task bases must pass the same runtime/native-tool smoke check.
ARG NODE_IMAGE=node:22.19.0-bookworm-slim
ARG TASK_IMAGE
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/pimas
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY prompts ./prompts
COPY container ./container
COPY agents.example.json models.example.json ./

FROM ${TASK_IMAGE}
ARG TASK_IMAGE
LABEL org.pimas.task-base="${TASK_IMAGE}"
COPY --from=dependencies /usr/local/bin/node /opt/pimas-node/bin/node
COPY --from=dependencies /opt/pimas /opt/pimas
# Deliberately retain the task image's entrypoint, command, user, PATH and workspace.
