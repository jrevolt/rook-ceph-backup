FROM alpine as base
RUN apk add --update --no-cache bash curl jq nodejs
RUN echo "Installing kubectl..." &&\
    version=$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt) &&\
    url=https://storage.googleapis.com/kubernetes-release/release/${version}/bin/linux/amd64/kubectl &&\
    curl -sL -o /usr/local/bin/kubectl $url &&\
    chmod +x /usr/local/bin/kubectl &&\
    kubectl version --client
ADD entrypoint.sh /usr/local/bin/k8s

FROM node:12-alpine as build
WORKDIR /work
ADD package*json ./
RUN npm ci
ADD . ./
RUN npm run tsc
#RUN npm run test

FROM base
WORKDIR /app
COPY --from=build /work/node_modules/ node_modules/
COPY --from=build /work/config/ config/
COPY --from=build /work/.build/ ./
ENTRYPOINT ["k8s"]




