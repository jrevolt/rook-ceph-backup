#!/bin/bash

realpath() {
   [[ "$(uname)" =~ CYGWIN.* ]] && cygpath -wam "$1" || $(which realpath) "$1"
}

gitversion() {
   docker run --rm -w /work -v "$(realpath .):/work" registry.gitlab.com/jrevolt/citools/gitversion
}

image() {
  local path="jrevolt/rook-ceph-backup"
  local version="${version:-local}"
  local registry=${registry:-registry.gitlab.com}
  local cache=${cache:-$registry}
  local push=${push:-true}
  [[ -t 1 ]] && local dockeropts="-it"
  docker run ${dockeropts:-} --rm --privileged \
    -w /work \
    -v "$(realpath .):/work" \
    -v "$(realpath .git/docker.json):/home/user/.docker/config.json" \
    -v jrevolt-citools:/home/user/.local/share/buildkit \
    --entrypoint buildctl-daemonless.sh \
    moby/buildkit:master-rootless \
      build \
        --frontend dockerfile.v0 \
        --local context=. \
        --local dockerfile=. \
        --opt build-arg:GITVERSION="$(gitversion)" \
        --import-cache=type=registry,ref=${cache}/${path}:cache \
        --export-cache=type=registry,ref=${cache}/${path}:cache \
        --output type=image,name=${registry}/${path}:${version},push=${push} \
        "$@"

}

