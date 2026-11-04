#!/usr/bin/env sh
# Builds MOTH Engine to freestanding WebAssembly. Requires clang (>= 15) with the wasm32 target + wasm-ld.
set -e
cd "$(dirname "$0")"
OUT=${1:-../../public/moth-engine/moth.wasm}
mkdir -p "$(dirname "$OUT")"
clang++ --target=wasm32 -std=c++17 -O3 -flto -nostdlib -fno-exceptions -fno-rtti -fno-threadsafe-statics \
  -msimd128 -mbulk-memory -mnontrapping-fptoint -mmutable-globals -msign-ext \
  -Wall -Wno-unused-function \
  -Wl,--no-entry -Wl,--strip-all -Wl,--lto-O3 -Wl,-z,stack-size=4194304 -Wl,--initial-memory=33554432 -Wl,--max-memory=536870912 \
  -Wl,--allow-undefined-file=imports.txt \
  -o "$OUT" moth.cpp
echo "built $OUT ($(wc -c < "$OUT") bytes)"
