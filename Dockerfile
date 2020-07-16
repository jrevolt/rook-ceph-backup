# syntax=docker/dockerfile:1-experimental

FROM alpine as download-kubectl
RUN apk add curl
RUN echo "Installing kubectl..." &&\
    version=$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt) &&\
    url=https://storage.googleapis.com/kubernetes-release/release/${version}/bin/linux/amd64/kubectl &&\
    curl -sL -o /usr/local/bin/kubectl $url &&\
    chmod +x /usr/local/bin/kubectl &&\
    kubectl version --client

FROM registry.gitlab.com/jrevolt/citools/gitversion as gitversion
WORKDIR /work
ADD .git/ .git/
RUN gitversion > /version.json

FROM node:14-alpine as base
RUN apk add --update --no-cache bash curl jq tzdata tar
COPY --from=download-kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl
ADD bin/entrypoint.sh /usr/local/bin/rbdtools
ENTRYPOINT ["rbdtools"]
ENV TZ="Europe/Bratislava"
WORKDIR /app
RUN --mount=source=package.json,target=/app/package.json \
    --mount=source=package-lock.json,target=/app/package-lock.json \
    --mount=source=tsconfig.json,target=/app/tsconfig.json \
    npm ci -d

FROM base as build
ADD . ./
COPY --from=gitversion /version.json src/version.json
RUN npm run build
RUN node .build/main.js -V

FROM base as runtime
RUN --mount=from=build,source=/app/.build,target=/build \
    --mount=target=/context \
    tar c -C /context config -C /build --exclude "*test*" . | tar xv




