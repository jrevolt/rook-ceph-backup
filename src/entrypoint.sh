#!/bin/bash

main() {
    cd /app && node main.js "$@"
}

main "$@"
