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
RUN apk add --update --no-cache bash curl jq tzdata
COPY --from=download-kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl
ADD bin/entrypoint.sh /usr/local/bin/rbdtools
ENTRYPOINT ["rbdtools"]
ENV TZ="Europe/Bratislava"
WORKDIR /app
ADD package*json tsconfig.json ./
RUN npm ci -d

FROM base as build
ADD . ./
RUN npm run build

FROM base as runtime
COPY --from=build /app/.build/ /app/




