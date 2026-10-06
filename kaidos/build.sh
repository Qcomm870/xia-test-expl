#!/bin/sh
# Требуется emsdk (Emscripten SDK). Сборка каркаса, не эмулятора.
set -e
emcc src/vm.c src/dos.c src/vga.c -O2 -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_vm_load_com","_vm_step","_vga_update","_vga_buffer","_main"]' \
  -s ALLOW_MEMORY_GROWTH=1 -o webapp/js/kados.js
(cd webapp && zip -r ../kados.krn . )
echo "kados.krn готов — установи Wallace Toolbox; игра запускаться НЕ будет"
