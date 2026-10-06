/* Автотесты ядра KaDOS-JS (node test/run.js). */
'use strict';
global.window = global;
// в браузере скрипт грузится тегом <script>, там this === window;
// в node эмулируем это через indirect eval (non-strict глобальный scope)
var _geval = eval;
_geval(require('fs').readFileSync(require('path').join(__dirname, '../webapp/js/kados.js'), 'utf8'));
var K = window.KaDOS;   // модуль пишет на `this`, который в node здесь === global === window
var fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) fails++; }

// 1. HELLO через INT 21h/09h
(function () {
  var code = [0xB4, 0x09, 0xBA, 0x00, 0x00, 0xCD, 0x21, 0xB4, 0x4C, 0xCD, 0x21];
  var str = 'HELLO!$'.split('').map(function (c) { return c.charCodeAt(0); });
  var total = new Uint8Array(code.length + str.length);
  total.set(code, 0); total.set(str, code.length);
  total[3] = (0x100 + code.length) & 0xFF; total[4] = (0x100 + code.length) >> 8;
  K.loadCom(total);
  var out = K.runSlice(10000);
  ok('hello exit', out.halted === 'exit');
  ok('hello text', K.getConsole() === 'HELLO!');
})();

// 2. Ожидание клавиши INT 21h/01h
(function () {
  K.loadCom(new Uint8Array([0xB4, 0x01, 0xCD, 0x21, 0xB4, 0x4C, 0xCD, 0x21]));
  var a = K.runSlice(10000);
  ok('waitkey halt', a.halted === 'key');
  K.pressKey(65);
  var b = K.runSlice(10000);
  ok('waitkey resume+exit', b.halted === 'exit' && (K.regs.ax & 0xFF) === 65);
})();

// 3. VGA poke: mov [0xA0000], al (A2 far)
(function () {
  var c = new Uint8Array([
    0xB0, 0x02,                   // mov al,2
    0xA2, 0x00, 0x00, 0x0A, 0x00, // mov [0x000A0000],al -> A000:0
    0xB4, 0x4C, 0xCD, 0x21
  ]);
  K.loadCom(c);
  var out = K.runSlice(10000);
  ok('vga poke ran', out.running === false);
  ok('vga dirty flag', K.vgaDirtyConsume() === true);
  ok('pixel written', K.vgaBuffer()[0] === 2);
})();

// 4. rep stosb: заполнение ES=A000 DI=0 CX=64000 значением 4
(function () {
  var c = new Uint8Array([
    0xB8, 0x00, 0xA0,   // mov ax,0A000h
    0x8E, 0xC0,         // mov es,ax (modrm C0: mod=11 reg=0(es) rm=0(ax))
    0xBF, 0x00, 0x00,   // mov di,0
    0xB9, 0x00, 0xFA,   // mov cx,64000
    0xB0, 0x04,         // mov al,4
    0xF3, 0xAA,         // rep stosb
    0xB4, 0x4C, 0xCD, 0x21
  ]);
  K.loadCom(c);
  var out = K.runSlice(10000);
  var buf = K.vgaBuffer();
  var allFour = true;
  for (var i = 0; i < 64000; i++) if (buf[i] !== 4) { allFour = false; break; }
  ok('stosb exit', out.halted === 'exit');
  ok('stosb fill screen', allFour);
})();

// 5. jmp rel8 петля с бюджетом (не зависает вызывающего)
(function () {
  K.loadCom(new Uint8Array([0xEB, 0xFE])); // jmp -2
  var t0 = Date.now();
  var out = K.runSlice(50000);
  ok('loop budget respected', out.steps <= 50000 && out.running === true && Date.now() - t0 < 2000);
})();

// 6. call/ret
(function () {
  K.loadCom(new Uint8Array([
    0xE8, 0x03, 0x00,   // call +3 -> метка на ret
    0x90,               // nop (после возврата)
    0xF4,               // hlt
    0xC3                // ret (цель call)
  ]));
  var out = K.runSlice(10000);
  ok('call/ret -> halt', out.halted === 'halt');
})();

console.log(fails === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '\nПРОВАЛОВ: ' + fails);
process.exit(fails ? 1 : 0);
