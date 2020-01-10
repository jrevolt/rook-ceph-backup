#!/bin/bash

repo="repods.mdxdev.sk"
name="tools/k8s"
version="${CI_COMMIT_REF_NAME}"

base="$repo/$name:base"
image="$repo/$name:$version"

prepare() {
  return 0
  #echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin
  #printf '{"auths": {"%s": "auth": "%s"}}' $CI_REGISTRY $(echo -n "$CI_REGISTRY_USERNAME:$CI_REGISTRY_PASSWORD" | base64) > ~/.docker/config.json
  wget https://github.com/moby/buildkit/releases/download/v0.6.2/buildkit-v0.6.2.linux-amd64.tar.gz
  tar xzvf buildkit*gz
  mv bin/* /usr/local/bin/
  buildkitd --tlscacert /etc/ssl/certs/ca-certificates.crt &
  sleep 2s
}

build() {
    cd src &&
    buildctl build \
      --frontend dockerfile.v0 \
      --local context=. \
      --local dockerfile=. \
      $(true && echo "--output type=image,name=docker.io/jrevolt/rook-ceph-backup:${CI_COMMIT_REF_NAME},push=true") \
      $(false && echo "--export-cache type=registry,ref=registry.gitlab.com/jrevolt/rook-ceph-backup:cache,mode=max") \
      $(false && echo "--import-cache type=registry,ref=registry.gitlab.com/jrevolt/rook-ceph-backup:cache") \
      "$@"
}

publish() {
    return 0
#    docker push ${base}
#    docker push ${image}
}

deploy() {
  return 0
#  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin set image sts/test "*=${name}:${version}"
#  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin set image cronjob/snapshot "*=${name}:${version}"
#  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin set image cronjob/backup "*=${name}:${version}"
#  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin set image cronjob/consolidate "*=${name}:${version}"
#  docker run --rm bitnami/kubectl --server ${K8S_SERVER_DEVTEST} --token ${K8S_TOKEN_DEVTEST} -n admin rollout restart sts/test
}

"$@"
