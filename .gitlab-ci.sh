#!/bin/bash

repo="repods.mdxdev.sk"
name="tools/k8s"
version="${CI_COMMIT_REF_NAME}"

base="$repo/$name:base"
image="$repo/$name:$version"

prepare() {
    docker pull ${base} || {
        docker build -t ${base} --cache-from=${base} --target=base src
    }
    docker build -t ${base} --cache-from=${base} --target=base src
}

build() {
    docker build -t ${image} --target=main src
}

publish() {
    docker push ${base}
    docker push ${image}
}

deploy() {
  docker run --rm bitnami/kubectl --server ${K8S_SERVER_PROD} --token ${K8S_TOKEN_PROD} -n admin rollout restart sts/test
  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin rollout restart sts/test
}

"$@"
