/* KaDOS-JS — минимальный x86 real-mode интерпретатор + DOS-слой на чистом JS.
   Пишется под ограничение: Nokia 800 Tough, KaiOS 2.5.2 (Gecko, без JIT).
   Честный охват: COM-файлы до ~64 КБ, INT 21h (дисплей/клавиатура/EXIT),
   VGA mode 13h через прямой доступ к сегменту A000. Fallout 2 НЕ запустит
   (тот требует 32-bit protected mode + DINK-движок) — это демонстрация ядра. */
(function (global) {
  'use strict';

  var MEMSIZE = 0x110000; // 1 МБ + хвост
  var mem = new Uint8Array(MEMSIZE);
  var regs = {
    ax: 0, bx: 0, cx: 0, dx: 0, si: 0, di: 0, bp: 0, sp: 0,
    ip: 0, cs: 0, ds: 0, ss: 0, es: 0, flags: 0x0202
  };
  var running = false, halted = false;
  var keyQueue = [];           // коды клавиш для INT 16h / 21h (элемент: ASCII-код)
  var scanQueue = [];          // параллельные скан-коды для расширенных клавиш
  var pendingKey = null;       // байт, возвращённый предыдущим INT 21h/01h (для повтора)
  var vgaDirty = false;        // помечать при записи в A000
  var consoleBuf = '';         // вывод text-mode (INT 21h fn 09h/02h)

  var MEM_SIZE_MASK = MEMSIZE - 1;
  function la(seg, off) { return ((seg << 4) + off) & MEM_SIZE_MASK; }
  function rb(a) { return mem[a & MEM_SIZE_MASK]; }
  function rw(a) { return mem[a & MEM_SIZE_MASK] | (mem[(a + 1) & MEM_SIZE_MASK] << 8); }
  function wb(a, v) { mem[a & MEM_SIZE_MASK] = v & 0xFF; }
  function ww(a, v) { a &= MEM_SIZE_MASK; mem[a] = v & 0xFF; mem[(a + 1) & MEM_SIZE_MASK] = (v >> 8) & 0xFF; }

  // флаги: только CF/ZF/SF нужны большинству простых программ
  function setZS(v) { regs.flags = (regs.flags & ~0x8040) | (v === 0 ? 0x40 : 0) | ((v & 0x8000) ? 0x80 : 0); }

  /* ---------- загрузка .COM ---------- */
  function loadCom(bytes) {
    if (bytes.length > 0xFF00) throw new Error('COM too big (>64K)');
    mem.fill(0, 0, MEMSIZE);
    mem.set(bytes, 0x100);
    regs.cs = regs.ds = regs.es = regs.ss = 0;
    regs.ip = 0x100; regs.sp = 0xFFFE; regs.flags = 0x0202;
    regs.ax = regs.bx = regs.cx = regs.dx = 0;
    ww(0, 0x00CD);              // пиратский инт-вектор 0 -> ret-ish stub
    halted = false; running = true; consoleBuf = '';
  }

  /* ---------- прерывания ---------- */
  function int21() {
    var f = regs.ax >> 8;
    switch (f) {
      case 0x02: putChar(regs.dl & 0xFF); break;                 // DL = char
      case 0x09: {                                               // DS:DX = '$'-terminated
        var p = la(regs.ds, regs.dx);
        for (;;) { var c = rb(p++); if (c === 0x24) break; putChar(c); }
        break; }
      case 0x01: case 0x08: {                                    // read char (wait)
        if (!keyQueue.length) { halted = 'key'; break; }         // выход в цикл событий JS
        var k = keyQueue.shift();                                // забираем клавишу
        pendingKey = k;
        regs.ax = ((k & 0xFF) << 8) | (k & 0xFF); break; }       // AL=ASCII, AH=скан-код
      case 0x0B: regs.ax = keyQueue.length ? 0xFF01 : 0x00; break; // check input
      case 0x4C: case 0x00: running = false; halted = 'exit'; break; // terminate
      case 0x44: regs.ax = 0x0080; break;                        // ioctl: char device
      case 0x2F: regs.ax = 0x0320; break;                        // version DOS 3.2? (2.0)
      default: regs.flags |= 1; break;                           // не поддерживается -> CF
    }
  }
  function int16() {                                             // BIOS keyboard
    var f = regs.ah;
    if (f === 0 || f === 1) {
      var has = f === 0 ? true : keyQueue.length > 0;
      if (f === 1 && !has) { regs.zx = 0; regs.flags = (regs.flags & ~0x40) | 0x40; return; }
      var k = keyQueue.shift();
      if (k === undefined) { halted = 'key'; return; }
      regs.ax = k < 0x100 ? k : ((k >> 8) << 8 | (k & 0xFF));
      regs.flags &= ~0x40;
    } else if (f === 2) { regs.ax = 0; }                         // shift states
  }
  function int10() {
    if (regs.ax === 0x13) {                                      // tty-like string out
      var p = la(regs.es, regs.bp), n = regs.cx & 0xFFFF;
      for (var i = 0; i < n; i++) putChar(rb(p + i));
    }
  }
  function intXX(n) {                                            // векторы из таблицы IVT
    var v = rw(n * 4); var seg = rw(n * 4 + 2);
    if (v === 0 && seg === 0) { regs.flags |= 1; return; }       // нет обработчика -> CF
    ww(la(regs.ss, regs.sp) - 0, 0);                             // (упрощённо не реализуем стек-вызов)
    regs.flags |= 1;
  }

  function putChar(c) {
    if (c === 13) return;
    if (c === 10 || c === 0) consoleBuf += '\n';
    else consoleBuf += String.fromCharCode(c);
  }

  /* ---------- шаг интерпретатора ---------- */
  function fetchB() { var v = rb(la(regs.cs, regs.ip)); regs.ip = (regs.ip + 1) & 0xFFFF; return v; }
  function fetchW() { var v = rw(la(regs.cs, regs.ip)); regs.ip = (regs.ip + 2) & 0xFFFF; return v; }

  var R8 = ['al', 'cl', 'dl', 'bl'];
  function getR8(r) { return (regs[['ax', 'cx', 'dx', 'bx'][r]] >> ((r & 1) * 8)) & 0xFF; }
  function setR8(r, v) {
    var full = ['ax', 'cx', 'dx', 'bx'][r];
    regs[full] = (regs[full] & (r & 1 ? 0x00FF : 0xFF00)) | ((v & 0xFF) << ((r & 1) * 8));
  }

  function step() {
    if (!running) return false;
    var op = fetchB();
    switch (op) {
      case 0x90: break;                                           // NOP
      case 0xEB: regs.ip = (regs.ip + (fetchB() << 24 >> 24)) & 0xFFFF; break; // jmp rel8
      case 0xE9: regs.ip = (regs.ip + (fetchW() << 16 >> 16)) & 0xFFFF; break; // jmp rel16
      case 0xE8: {                                                // call rel16
        var d = fetchW() << 16 >> 16;
        regs.sp = (regs.sp - 2) & 0xFFFF; ww(la(regs.ss, regs.sp), regs.ip);
        regs.ip = (regs.ip + d) & 0xFFFF; break; }
      case 0xC3: regs.ip = rw(la(regs.ss, regs.sp)); regs.sp = (regs.sp + 2) & 0xFFFF; break; // ret
      case 0xCD: {
        var n = fetchB();
        if (n === 0x21) int21();
        else if (n === 0x16) int16();
        else if (n === 0x10) int10();
        else intXX(n);
        break; }
      case 0xF4: running = false; halted = 'halt'; break;         // hlt
      case 0xB4: regs.ax = (regs.ax & 0x00FF) | (fetchB() << 8); break; // mov ah,imm8 — отдельный случай (AH не входит в ax/cx/dx/bx-таблицу)
      case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB5: case 0xB6: case 0xB7:
        regs[['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][op - 0xB0]] =
          (regs[['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][op - 0xB0]] & 0xFF00) | fetchB();
        break;                                                    // mov r8, imm8 (al/cl/dl/bl/ch/cl... грубо — младшие байты ax..di)
      case 0xB8: case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF:
        regs[['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][op - 0xB8]] = fetchW(); break; // mov r16,imm16
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
        regs.sp = (regs.sp - 2) & 0xFFFF; ww(la(regs.ss, regs.sp), regs[['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][op - 0x50]]); break; // push
      case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F:
        regs[['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][op - 0x58]] = rw(la(regs.ss, regs.sp)); regs.sp = (regs.sp + 2) & 0xFFFF; break; // pop
      case 0x26: case 0x2E: case 0x36: case 0x3E: break;          // префиксы сегментов — игнор (flat)
      case 0x88: {                                               // mov r/m8, r8
        var m = fetchB();
        if ((m & 0xC0) === 0x00 && (m & 0x07) === 0x06) {         // mod=00 rm=110 -> direct [disp16]
          var a = la(regs.ds, fetchW()); wb(a, getR8((m >> 3) & 7)); markVga(a);
        } else if ((m & 0xC0) === 0xC0) { setR8(m & 7, getR8((m >> 3) & 7)); }
        else if ((m & 0xC0) === 0x00 && (m & 0x38) !== 0x30) {    // reg-direct memory: [bx][si][di][bp]+displ
          var base = regs[['bx','bx','bp','bp','si','di','bp','bx'][(m & 7)]];
          var disp = 0;
          if ((m & 0xC0) === 0x40) disp = fetchB() << 24 >> 24;
          else if ((m & 0xC0) === 0x80) disp = fetchW() << 16 >> 16;
          var addr = la(regs.ds, (base + disp) & 0xFFFF);
          wb(addr, getR8((m >> 3) & 7)); markVga(addr);
        }
        else { running = false; halted = 'modrm:' + m.toString(16); }
        break; }
      case 0x8E: {                                               // mov sr, r16 (modrm reg=seg)
        var m = fetchB();
        var src = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'][(m >> 3) & 7];
        var dst = ['es', 'cs', 'ss', 'ds'][m & 7];
        if ((m & 0xC0) === 0xC0) regs[dst] = regs[src];
        else { running = false; halted = 'modrm:' + m.toString(16); }
        break; }
      case 0xA3: { var a = fetchW() | (fetchW() << 16); ww(a, regs.ax); markVga(a); break; } // mov m16,ax far
      case 0xA2: {                                                 // mov m8,al far: A2 + off16 + seg16
        var off = fetchW(), seg = fetchW(); wb(la(seg, off), regs.ax & 0xFF); markVga(la(seg, off)); break; }
      case 0xA0: { var off = fetchW(), seg = fetchW(); regs.ax = (regs.ax & 0xFF00) | rb(la(seg, off)); break; } // mov al,m far
      case 0xA1: { var off = fetchW(), seg = fetchW(); regs.ax = rw(la(seg, off)); break; }                     // mov ax,m far
      case 0xAA: { var a = la(regs.es, regs.di); wb(a, regs.ax & 0xFF); markVga(a); regs.di = (regs.di + 1) & 0xFFFF; break; } // stosb
      case 0xAB: { var a = la(regs.es, regs.di); ww(a, regs.ax); markVga(a); regs.di = (regs.di + 2) & 0xFFFF; break; }         // stosw
      case 0xF3: {                                       // rep prefix: stosb/stosw/movsb/cmovne
        var sub = fetchB();
        if (sub === 0xAA) {                             // rep stosb
          var a = la(regs.es, regs.di), v = regs.ax & 0xFF;
          for (var i = 0; i < regs.cx; i++) wb(a + i, v);
          markVga(a); regs.di = (regs.di + regs.cx) & 0xFFFF; regs.cx = 0;
        } else if (sub === 0xAB) {                      // rep stosw
          var a2 = la(regs.es, regs.di), v2 = regs.ax;
          for (var j = 0; j < regs.cx; j++) ww(a2 + j * 2, v2);
          markVga(a2); regs.di = (regs.di + regs.cx * 2) & 0xFFFF; regs.cx = 0;
        } else { running = false; halted = 'rep:' + sub.toString(16); }
        break; }
      case 0xE4: regs.ax = (regs.ax & 0xFF00) | fetchB(); break;  // in al,imm (заглушка: 0-порт)
      case 0xE6: fetchB(); break;                                 // out imm,al — проглатываем
      case 0x2C: regs.al = (getR8(0) - fetchB()) & 0xFF; setZS(regs.al); break; // sub al,imm8
      case 0x04: regs.al = (getR8(0) + fetchB()) & 0xFF; setZS(regs.al); break; // add al,imm8
      case 0xFE: {                                               // inc/dec byte [reg-based simple]
        var modrm = fetchB(); if ((modrm & 0xC7) === 0x06) { var a = la(regs.ds, fetchW()); var v = rb(a) + (modrm & 0x38 ? -1 : 1); wb(a, v); setZS(v); } else regs.ip += 0; break; }
      default:
        // неизвестный код: считаем «не эмулируется» и останавливаемся с диагностикой,
        // чтобы не крутить CPU впустую на 800 Tough
        running = false; halted = 'unknown:' + op.toString(16);
    }
    return running;
  }

  /* ---------- VGA mode 13h: детект записи в A000 ---------- */
  // Прямые poke'ы в память делает сама программа через mov -> мы ловим по адресу.
  function markVga(addr) { if (addr >= 0xA0000 && addr < 0xAFFFF) vgaDirty = true; }

  function runSlice(budget) {                       // бюджет инструкций на кадр
    var n = 0;
    while (running && n < budget) {
      if (halted === 'key') {                        // VM ждёт ввода из JS
        if (!keyQueue.length) break;                 // ничего нет — выходим, не крутим CPU
        halted = null;                               // клавиша пришла: int21 заберёт её сам
      }
      step(); n++;
    }
    return { running: running, halted: halted, steps: n };
  }

  /* ---------- API для main.js ---------- */
  global.KaDOS = {
    loadCom: loadCom,
    runSlice: runSlice,
    pressKey: function (code) { keyQueue.push(code); },
    getConsole: function () { var s = consoleBuf; consoleBuf = ''; return s; },
    vgaBuffer: function () { return mem.subarray(0xA0000, 0xA0000 + 320 * 200); },
    vgaDirtyConsume: function () { var d = vgaDirty; vgaDirty = false; return d; },
    regs: regs, mem: mem
  };
})(this);
