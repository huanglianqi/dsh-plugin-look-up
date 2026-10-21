#!/usr/bin/env bash
# Rebuild bin/dsh-lookup-dict as a signed universal (arm64 + x86_64) helper.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-helper.sh: macOS only" >&2
  exit 1
fi

mkdir -p bin
xcrun clang \
  -O2 \
  -fobjc-arc \
  -arch arm64 \
  -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -Wno-deprecated-declarations \
  -framework Foundation \
  -framework CoreServices \
  -o bin/dsh-lookup-dict \
  native/dsh-lookup-dict.m

# ad-hoc signature keeps the arm64 slice runnable after lipo merges it.
codesign --force --sign - bin/dsh-lookup-dict

echo "built bin/dsh-lookup-dict ($(lipo -archs bin/dsh-lookup-dict))"
./bin/dsh-lookup-dict --version
