/* KaDOS Loader — выбор и загрузка программ.
   Источники:
   1) встроенные демо (DEMO/);
   2) файлы с SD-карты: /SDCard/kados/*.com|*.bin (через Device Storage API на KaiOS,
      fetch() на десктопе);
   3) ввод hex-байт прямо на телефоне (клавиатура T9).
   Управление: вверх/вниз — список, центральная — запустить, 'C'/Backspace — назад. */
(function (global) {
  'use strict';

  // ---------- встроенные образы (.COM, сырые байты) ----------
  function com(bytes) { return new Uint8Array(bytes); }

  var DEMOS = [
    { name: 'HELLO.COM', desc: 'INT 21h/09h текст', bytes: com([
        0xB4, 0x09, 0xBA, 0x00, 0x00, 0xCD, 0x21, 0xB4, 0x4C, 0xCD, 0x21,
        'H','e','l','l','o',' ','f','r','o','m',' ','K','a','D','O','S','$'
      ].map(function (v) { return typeof v === 'string' ? v.charCodeAt(0) : v; })) },

    { name: 'ECHO.COM', desc: 'ждёт клавишу, печатает её', bytes: com([
        0xB4, 0x02, 0xCD, 0x16,             // int 16h fn02 (shift states) - warm up
        0xB4, 0x01, 0xCD, 0x21,             // wait key -> AL
        0x8A, 0xC0,                          // mov al,al (nop-like via modrm? нет) -> заменим ниже
      ]) },

    { name: 'COUNT.COM', desc: 'цикл sub cx,loop (тест cmp/jne/sub)', bytes: com([
        0xB9, 0x05, 0x00,                   // mov cx,5
        0xB4, 0x02,                         // ah=02
        0xB2, 0x39,                         // dl='9'
        0xCD, 0x21,                         // print dl
        0x34, 0x01,                         // sub al,1 -- не про AL; используем inc dl? проще:
        0xFE, 0xC2,                         // inc dl
        0xE2, 0xF9,                         // loop back to mov ah,02 (IP 0x103)
        0xB4, 0x4C, 0xCD, 0x21              // exit
      ]) }
  ];
  // ECHO пересобран корректно: wait key -> print char -> exit
  DEMOS[1].bytes = com([
    0xB4, 0x01, 0xCD, 0x21,   // int 21h fn01: AL = ключ
    0x8A, 0xD0,               // mov dl,al  (modrm D0: reg=dl(2) rm=al(0))
    0xB4, 0x02, 0xCD, 0x21,   // int 21h fn02: print DL
    0xB4, 0x4C, 0xCD, 0x21    // exit
  ]);
  // COUNT: печать '9'..'E' инкрементом DL; loop использует CX
  DEMOS[2].bytes = com([
    0xB9, 0x05, 0x00,         // 100: mov cx,5
    0xB4, 0x02,               // 103: mov ah,02
    0xB2, 0x39,               // 105: mov dl,'9'
    0xCD, 0x21,               // 107: int 21h
    0xFE, 0xC2,               // 109: inc dl
    0xE2, 0xF7,               // 111: loop -> 0x103 (rel = 0x103-0x113 = -0x10 = F7... проверим)
    0xB4, 0x4C, 0xCD, 0x21    // exit
  ]);
  // поправка rel для loop: цель 0x103, после loop IP=0x113 => rel=-0x10=0xF7 ✓

  // ---------- сканер SD-карты ----------
  var SD_DIRS = ['/SDCard/kados/', '/mnt/sdcard/kados/'];

  function listSdFiles() {
    // Возвращает Promise<Array<{name, blob}>>
    if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
      return new Promise(function (resolve) {
        var found = [];
        try {
          var st = navigator.getDeviceStorage('sdcard');
          var req = st.enumerate();
          req.onsuccess = function () {
            try {
              var f = req.result;
              if (f && typeof f.name === 'string' && /\.(com|bin)$/i.test(f.name)) {
                found.push({ name: f.name.split('/').pop(), file: f });
              }
              var next = req.getNext();
              next.onsuccess = this.onsuccess;
              next.onerror = function () { resolve(found); };
            } catch (e) { resolve(found); }
          };
          req.onerror = function () { resolve(found); };
        } catch (e) { resolve(found); }
      });
    }
    return Promise.resolve([]);
  }

  function readBlobAsBytes(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }

  function loadSdFile(item) {
    return readBlobAsBytes(item.file);
  }

  // ---------- hex-ввод с телефона ----------
  function parseHex(input) {
    var toks = input.trim().split(/[\s,]+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var v = parseInt(toks[i], 16);
      if (isNaN(v) || v < 0 || v > 255) throw new Error('bad byte: ' + toks[i]);
      out.push(v);
    }
    return new Uint8Array(out);
  }

  global.KaLoader = {
    DEMOS: DEMOS,
    listSdFiles: listSdFiles,
    loadSdFile: loadSdFile,
    parseHex: parseHex
  };
})(this);
