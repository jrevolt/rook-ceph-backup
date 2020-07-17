# syntax=docker/dockerfile:1-experimental

FROM alpine as download-kubectl
RUN apk add curl
RUN echo "Installing kubectl..." &&\
    version=$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt) &&\
    url=https://storage.googleapis.com/kubernetes-release/release/${version}/bin/linux/amd64/kubectl &&\
    curl -sL -o /usr/local/bin/kubectl $url &&\
    chmod +x /usr/local/bin/kubectl &&\
    kubectl version --client

FROM node:14-alpine as base
RUN --mount=from=download-kubectl,source=/usr/local/bin,target=/mnt/kubectl \
    apk add --update --no-cache bash tzdata tar &&\
    tar c -C /mnt/kubectl . | tar xv -C /usr/local/bin
ENTRYPOINT ["rbdtools"]
ENV TZ="Europe/Bratislava"
WORKDIR /app
RUN --mount=source=package.json,target=/app/package.json \
    --mount=source=package-lock.json,target=/app/package-lock.json \
    --mount=source=tsconfig.json,target=/app/tsconfig.json \
    npm ci -d

FROM base as build
ADD . ./
ARG GITVERSION
RUN echo "$GITVERSION" > src/version.json && npm run build
RUN node .build/main.js -V

FROM base as runtime
RUN --mount=from=build,source=/app/.build,target=/mnt/root/app,rw \
    --mount=source=/config,target=/mnt/root/app/config,rw \
    --mount=source=/bin/entrypoint.sh,target=/mnt/root/usr/local/bin/rbdtools \
    tar c -C /mnt/root/ --exclude "app/*test*" . | tar xv -C /




