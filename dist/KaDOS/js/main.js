/* KaDOS UI-слой: canvas 320x240, консоль 80x25, ввод клавиатуры Nokia.
   Работает и на десктопе (браузер), и на KaiOS. */
(function () {
  'use strict';
  var canvas = document.getElementById('scr');
  var hud = document.getElementById('hud');
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(320, 200);

  // VGA-палитра mode 13h (16 базовых цветов EGA — достаточно для демо)
  var PAL = [
    [0,0,0],[170,0,0],[0,170,0],[170,85,0],[0,0,170],[170,0,170],[0,170,170],[170,170,170],
    [85,85,85],[255,85,85],[85,255,85],[255,255,85],[85,85,255],[255,85,255],[85,255,255],[255,255,255]
  ];

  var consoleText = '';
  var mode = 'text';            // 'text' | 'vga'
  var BUDGET = 3000;            // инструкций на кадр (~адаптивно ниже)

  function drawText() {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#0f0'; ctx.font = '10px monospace';
    var lines = consoleText.split('\n');
    var start = Math.max(0, lines.length - 22);
    for (var i = start; i < lines.length; i++) {
      ctx.fillText(lines[i].slice(0, 42), 4, 12 + (i - start) * 10);
    }
  }

  function drawVga() {
    var buf = window.KaDOS.vgaBuffer();
    var d = img.data;
    for (var i = 0; i < 320 * 200; i++) {
      var c = buf[i] & 15, p = PAL[c];
      var o = i * 4;
      d[o] = p[0]; d[o+1] = p[1]; d[o+2] = p[2]; d[o+3] = 255;
    }
    ctx.putImageData(img, 0, 20);   // центровка 200->240
  }

  function loop() {
    if (!window.KaDOS) { setTimeout(loop, 100); return; }
    var out = KaDOS.runSlice(BUDGET);
    var s = KaDOS.getConsole();
    if (s) { consoleText += s; mode = 'text'; }
    if (KaDOS.vgaDirtyConsume()) mode = 'vga';
    if (mode === 'vga') drawVga(); else drawText();
    if (!out.running) {
      hud.textContent = 'HALT: ' + out.halted + ' (шагов: ' + out.steps + ')';
    } else {
      hud.textContent = 'KaDOS | running | IP=' + KaDOS.regs.ip.toString(16);
    }
    setTimeout(loop, 16);
  }

  // Клавиатура: Nokia T9 -> scancode-like коды; на десктопе обычные клавиши
  document.addEventListener('keydown', function (e) {
    if (!window.KaDOS) return;
    var map = { Enter: 13, Backspace: 8, Escape: 27 };
    if (map[e.key] !== undefined) { KaDOS.pressKey(map[e.key]); e.preventDefault(); return; }
    if (e.key.length === 1) KaDOS.pressKey(e.key.toUpperCase().charCodeAt(0));
    // стрелки: BIOS-коды
    var arrows = { ArrowUp: 0x4800, ArrowDown: 0x5000, ArrowLeft: 0x4B00, ArrowRight: 0x4D00 };
    if (arrows[e.key]) KaDOS.pressKey(arrows[e.key]);
  });

  // Загрузка демо-программы прямо в память (не бинарь с диска):
  // "HELLO $"+INT21/09h, затем INT21/4Ch
  function loadDemo() {
    var code = [
      0xB9, 0x07, 0x00,             // mov cx,7
      0xBA, 0x0C, 0x01,             // mov dx,010Ch  (строка после кода)
      0xB4, 0x09,                   // mov ah,09
      0xCD, 0x21,                   // int 21h
      0xB4, 0x4C, 0xCD, 0x21        // exit
    ];
    var str = 'HELLO $'.split('').map(function (ch) { return ch.charCodeAt(0); });
    // строка должна быть '$'-терминирована
    var total = new Uint8Array(code.length + str.length + 1);
    total.set(code, 0);
    total.set(str, code.length);
    total[code.length + str.length] = 0x24; // '$'
    // поправка: DX должен указывать на смещение строки в памяти COM (0x100 + code.length)
    total[3] = (0x100 + code.length) & 0xFF;
    total[4] = ((0x100 + code.length) >> 8) & 0xFF;
    KaDOS.loadCom(total);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { loadDemo(); loop(); });
  } else { loadDemo(); loop(); }
})();
