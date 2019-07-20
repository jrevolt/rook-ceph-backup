#!/bin/bash

repo="repods.mdxdev.sk"
name="tools/k8s"
version="latest"

base="$repo/$name:base"
image="$repo/$name:$version"

prepare() {
#    docker pull ${base} || {
#        docker build -t ${base} --cache-from=${base} --target=base src
#    }
    docker pull ${base}
    docker build -t ${base} --cache-from=${base} --target=base src
}

build() {
    docker build -t ${image} src
}

publish() {
    docker push ${base}
    docker push ${image}
}

"$@"