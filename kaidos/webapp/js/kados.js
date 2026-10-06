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
  function setZS8(v) { regs.flags = (regs.flags & ~0x8040) | (v === 0 ? 0x40 : 0) | ((v & 0x80) ? 0x80 : 0); }
  // флаги после sub: CF (borrow), ZF, SF. size=8 или 16
  function flagsSub(a, b, size) {
    var m = size === 8 ? 0xFF : 0xFFFF;
    var r = (a - b) & m;
    regs.flags = (regs.flags & ~0x8140) | (r === 0 ? 0x40 : 0) | ((size === 8 ? (r & 0x80) : (r & 0x8000)) ? 0x80 : 0) | (((a & m) < (b & m)) ? 1 : 0);
    return r;
  }
  function flagsAdd(a, b, size) {
    var m = size === 8 ? 0xFF : 0xFFFF;
    var r = (a + b) & m;
    regs.flags = (regs.flags & ~0x8140) | (r === 0 ? 0x40 : 0) | ((size === 8 ? (r & 0x80) : (r & 0x8000)) ? 0x80 : 0) | (((a & m) + (b & m)) > m ? 1 : 0);
    return r;
  }
  var R16NAMES = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
  var SEG_NAMES = ['es', 'cs', 'ss', 'ds'];
  // effective address для modrm (mod!=11). Возвращает линейный адрес или null.
  function rmAddr(m, defSeg) {
    var mod = (m >> 6) & 3, rm = m & 7;
    if (mod === 3) return null;
    var disp = 0;
    if (mod === 0 && rm === 6) disp = fetchW();
    else if (mod === 1) disp = fetchB() << 24 >> 24;
    else if (mod === 2) disp = fetchW() << 16 >> 16;
    var base = 0;
    if (!(mod === 0 && rm === 6)) {
      var tbl = [regs.bx, regs.bx, regs.bp, regs.bp, regs.si, regs.di, regs.bp, regs.bx];
      base = tbl[rm];
      if (rm === 4) base = (m & 0x10) ? regs.si : 0; // simple [si]/[di] без индексов — грубо
    }
    var seg = (defSeg === undefined) ? (rm === 5 ? regs.ss : regs.ds) : defSeg;
    return la(seg, (base + disp) & 0xFFFF);
  }

  /* ---------- загрузка .COM ---------- */
  function loadCom(bytes) {
    if (bytes.length > 0xFF00) throw new Error('COM too big (>64K)');
    mem.fill(0, 0, MEMSIZE);
    mem.set(bytes, 0x100);
    regs.cs = regs.ds = regs.es = regs.ss = 0;
    regs.ip = 0x100; regs.sp = 0xFFFE; regs.flags = 0x0202;
    regs.ax = regs.bx = regs.cx = regs.dx = 0;
    halted = null; running = true; consoleBuf = ''; vgaDirty = false;
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
      if (f === 1 && !has) { regs.flags = (regs.flags & ~0x40) | 0x40; return; }
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
  function intXX(n) {
    // неизвестное прерывание: как настоящий DOS с нулевой IVT -> iret-заглушка, не убиваем VM
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

  // reg index 0..7 = AL,CL,DL,BL,AH,CH,DH,BH
  var R8FULL = ['ax', 'cx', 'dx', 'bx', 'ax', 'cx', 'dx', 'bx'];
  var R8HI = [0, 0, 0, 0, 1, 1, 1, 1];
  function getR8(r) { return (regs[R8FULL[r]] >> (R8HI[r] ? 8 : 0)) & 0xFF; }
  function setR8(r, v) {
    var full = R8FULL[r], hi = R8HI[r];
    regs[full] = (regs[full] & (hi ? 0x00FF : 0xFF00)) | ((v & 0xFF) << (hi ? 8 : 0));
  }

  function step(prevIp, n) {
    if (!running) return false;
    var op = fetchB();
    switch (op) {
      case 0x90: break;                                           // NOP
      case 0xEB: regs.ip = (regs.ip + (fetchB() << 24 >> 24)) & 0xFFFF; break; // jmp rel8
      case 0xE9: regs.ip = (regs.ip + (fetchW() << 16 >> 16)) & 0xFFFF; break; // jmp rel16
      case 0xE8: {                                                // call rel16
        var d = fetchW() << 16 >> 16;
        regs.sp = (regs.sp - 2) & 0xFFFF; ww(la(regs.ss, regs.sp), regs.ip);
        regs.ip = (regs.ip + d - 3) & 0xFFFF; break; }            // цель = IP до call + d
      case 0xC3: regs.ip = rw(la(regs.ss, regs.sp)); regs.sp = (regs.sp + 2) & 0xFFFF; break; // ret
      case 0xCD: {
        var n = fetchB();
        if (n === 0x21) int21();
        else if (n === 0x16) int16();
        else if (n === 0x10) int10();
        else { regs.flags |= 1; }   // неизвестное прерывание: CF, не останавливаем VM
        break; }
      case 0xF4: running = false; halted = 'halt'; break;         // hlt
      case 0xB4: regs.ax = (regs.ax & 0x00FF) | (fetchB() << 8); break; // mov ah,imm8
      case 0xB0: setR8(0, fetchB()); break;  // mov al,imm8
      case 0xB1: setR8(1, fetchB()); break;  // mov cl,imm8
      case 0xB2: setR8(2, fetchB()); break;  // mov dl,imm8
      case 0xB3: setR8(3, fetchB()); break;  // mov bl,imm8
      case 0xB5: { var t = fetchB(); regs.cx = (regs.cx & 0x00FF) | ((t & 0xFF) << 8); break; } // mov ch,imm8
      case 0xB6: { var t = fetchB(); regs.dx = (regs.dx & 0x00FF) | ((t & 0xFF) << 8); break; } // mov dh,imm8
      case 0xB7: { var t = fetchB(); regs.bx = (regs.bx & 0x00FF) | ((t & 0xFF) << 8); break; } // mov bh,imm8
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
      case 0xA3: { var off = fetchW(), seg = fetchW(); var a = la(seg, off); ww(a, regs.ax); markVga(a); break; } // mov m16,ax far (off,seg)
      case 0xA2: { var off = fetchW(), seg = fetchW(); var a = la(seg, off); wb(a, regs.ax & 0xFF); markVga(a); break; } // mov m8,al far
      case 0xA0: { var off = fetchW(), seg = fetchW(); setR8(0, rb(la(seg, off))); break; } // mov al,[far]
      case 0xA1: { var off = fetchW(), seg = fetchW(); regs.ax = rw(la(seg, off)); break; } // mov ax,[far]
      case 0xAA: { var a = la(regs.es, regs.di); wb(a, regs.ax & 0xFF); markVga(a); regs.di = (regs.di + 1) & 0xFFFF; break; } // stosb
      case 0xAB: { var a = la(regs.es, regs.di); ww(a, regs.ax); markVga(a); regs.di = (regs.di + 2) & 0xFFFF; break; }         // stosw
      case 0xF3: {                                       // rep prefix: stosb/stosw/movsb/cmovne
        var sub = fetchB();
        if (sub === 0xAA) {                             // rep stosb
          var cnt = regs.cx & 0xFFFF;
          var a = la(regs.es, regs.di), v = regs.ax & 0xFF;
          for (var i = 0; i < cnt; i++) wb((a + i) & MEM_SIZE_MASK, v);
          markVga(a); regs.di = (regs.di + cnt) & 0xFFFF; regs.cx = 0;
        } else if (sub === 0xAB) {                      // rep stosw
          var cnt2 = regs.cx & 0xFFFF;
          var a2 = la(regs.es, regs.di), v2 = regs.ax;
          for (var j = 0; j < cnt2; j++) ww((a2 + j * 2) & MEM_SIZE_MASK, v2);
          markVga(a2); regs.di = (regs.di + cnt2 * 2) & 0xFFFF; regs.cx = 0;
        } else { running = false; halted = 'rep:' + sub.toString(16); }
        break; }
      case 0xE4: regs.ax = (regs.ax & 0xFF00) | fetchB(); break;  // in al,imm (заглушка: 0-порт)
      case 0xE6: fetchB(); break;                                 // out imm,al — проглатываем
      case 0x2C: regs.al = (getR8(0) - fetchB()) & 0xFF; setZS(regs.al); break; // sub al,imm8
      case 0x04: regs.al = (getR8(0) + fetchB()) & 0xFF; setZS(regs.al); break; // add al,imm8
      case 0xFE: {                                               // inc/dec byte [reg-based simple]
        var modrm = fetchB(); if ((modrm & 0xC7) === 0x06) { var a = la(regs.ds, fetchW()); var v = rb(a) + (modrm & 0x38 ? -1 : 1); wb(a, v); setZS(v); } else regs.ip += 0; break; }
      case 0x8A: {                                               // mov r8, r/m8
        var m = fetchB();
        if ((m & 0xC0) === 0xC0) setR8((m >> 3) & 7, getR8(m & 7));
        else { var a = rmAddr(m); setR8((m >> 3) & 7, rb(a)); }
        break; }
      case 0x8B: {                                               // mov r16, r/m16
        var m = fetchB();
        if ((m & 0xC0) === 0xC0) regs[R16NAMES[(m >> 3) & 7]] = regs[R16NAMES[m & 7]];
        else { var a = rmAddr(m); regs[R16NAMES[(m >> 3) & 7]] = rw(a); }
        break; }
      case 0x89: {                                               // mov r/m16, r16
        var m = fetchB();
        if ((m & 0xC0) === 0xC0) regs[R16NAMES[m & 7]] = regs[R16NAMES[(m >> 3) & 7]];
        else { var a = rmAddr(m); ww(a, regs[R16NAMES[(m >> 3) & 7]]); markVga(a); }
        break; }
      case 0x8C: {                                               // mov r/m16, sr
        var m = fetchB();
        var sv = regs[SEG_NAMES[((m >> 3) & 3)]];
        if ((m & 0xC0) === 0xC0) regs[R16NAMES[m & 7]] = sv;
        else { var a = rmAddr(m); ww(a, sv); markVga(a); }
        break; }
      case 0x8D: {                                               // lea r16, [m]
        var m = fetchB();
        if ((m & 0xC0) !== 0xC0) {
          var mod = (m >> 6) & 3, rm = m & 7, disp = 0;
          if (mod === 0 && rm === 6) disp = fetchW();
          else if (mod === 1) disp = fetchB() << 24 >> 24;
          else if (mod === 2) disp = fetchW() << 16 >> 16;
          var tbl = [regs.bx, regs.bx, regs.bp, regs.bp, regs.si, regs.di, regs.bp, regs.bx];
          var base = (mod === 0 && rm === 6) ? 0 : tbl[rm];
          regs[R16NAMES[(m >> 3) & 7]] = (base + disp) & 0xFFFF;
        }
        break; }
      case 0x3C: setZS8(flagsSub(getR8(0), fetchB(), 8)); break;  // cmp al,imm8
      case 0x3D: setZS(flagsSub(regs.ax, fetchW(), 16)); break;   // cmp ax,imm16
      case 0x3A: case 0x3B: {                                     // cmp r, r/m
        var m = fetchB();
        if (op === 0x3A) {
          var v = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          setZS8(flagsSub(getR8((m >> 3) & 7), v, 8));
        } else {
          var v2 = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          setZS(flagsSub(regs[R16NAMES[(m >> 3) & 7]], v2, 16));
        }
        break; }
      case 0xF7: {                                               // test/not/neg/mul/div r/m16 (частично)
        var m = fetchB();
        var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
        var reg = (m >> 3) & 7;
        if (reg === 0) {                                          // TEST imm16 follows? F7 /0 = test
          var t = fetchW(); setZS(regs[R16NAMES[m & 7] === undefined ? 'ax' : R16NAMES[m & 7]] & t); setZS(flagsSub(regs[R16NAMES[(m>>3)&7]] & t, 0, 16));
        } else if (reg === 2) { regs[R16NAMES[m & 7]] = (~src) & 0xFFFF; }
        else if (reg === 3) { regs[R16NAMES[m & 7]] = (-src) & 0xFFFF; setZS(regs[R16NAMES[m & 7]]); }
        else if (reg === 4) { var p = regs.ax * src; regs.ax = p & 0xFFFF; regs.dx = (p >> 16) & 0xFFFF; if (p > 0xFFFF) regs.flags |= 1; else regs.flags &= ~1; }
        else if (reg === 6 && src !== 0) { var q = Math.floor(((regs.dx << 16) | regs.ax) / src); regs.ax = q & 0xFFFF; regs.dx = ((regs.dx << 16 | regs.ax) % src) & 0xFFFF; }
        break; }
      case 0xF6: {                                               // test/not neg mul div byte
        var m = fetchB();
        var src = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
        var reg = (m >> 3) & 7;
        if (reg === 2) setR8(m & 7, (~src) & 0xFF);
        else if (reg === 3) { setR8(m & 7, (-src) & 0xFF); setZS8(getR8(m & 7)); }
        else if (reg === 4) { var p = (regs.ax & 0xFF) * src; regs.ax = (regs.ax & 0xFF00) | (p & 0xFF); regs.ax = (regs.ax & 0x00FF) | (((p >> 8) & 0xFF) << 8); }
        break; }
      case 0xD1: {                                               // shl/shr r/m16 by 1 (via /4,/5)
        var m = fetchB();
        var isReg = (m & 0xC0) === 0xC0;
        var dst = isReg ? R16NAMES[m & 7] : null;
        var addr = isReg ? null : rmAddr(m);
        var v = isReg ? regs[dst] : rw(addr);
        var w = ((m >> 3) & 7);
        if (w === 4) { regs.flags = (v >> 15) & 1; v = (v << 1) & 0xFFFF; }
        else if (w === 5) { regs.flags = v & 1; v = (v >> 1) & 0xFFFF; }
        if (isReg) regs[dst] = v; else { ww(addr, v); markVga(addr); }
        setZS(v);
        break; }
      case 0xE2: {                                               // loop rel8
        var rel = fetchB() << 24 >> 24;
        regs.cx = (regs.cx - 1) & 0xFFFF;
        if (regs.cx !== 0) regs.ip = (regs.ip + rel) & 0xFFFF;
        break; }
      case 0xE3: { var rel = fetchB() << 24 >> 24; if (regs.cx === 0) regs.ip = (regs.ip + rel) & 0xFFFF; break; } // jcxz
      case 0xE0: { var rel = fetchB() << 24 >> 24; if (regs.cx !== 0 && !(regs.flags & 1)) regs.ip = (regs.ip + rel) & 0xFFFF; break; } // loopne
      case 0x29: case 0x2B: {                                     // sub r/m16,r16 / sub r16,r/m16
        var m = fetchB();
        if (op === 0x2B) {
          var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          var d = R16NAMES[(m >> 3) & 7];
          regs[d] = flagsSub(regs[d], src, 16);
        } else {
          var s2 = regs[R16NAMES[(m >> 3) & 7]];
          if ((m & 0xC0) === 0xC0) { var t2 = R16NAMES[m & 7]; regs[t2] = flagsSub(regs[t2], s2, 16); }
          else { var a = rmAddr(m); ww(a, flagsSub(rw(a), s2, 16)); markVga(a); }
        }
        break; }
      case 0x28: case 0x2A: {                                     // sub r/m8,r8 / sub r8,r/m8
        var m = fetchB();
        if (op === 0x2A) {
          var src = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          setR8((m >> 3) & 7, flagsSub(getR8((m >> 3) & 7), src, 8));
        } else {
          var s2 = getR8((m >> 3) & 7);
          if ((m & 0xC0) === 0xC0) setR8(m & 7, flagsSub(getR8(m & 7), s2, 8));
          else { var a = rmAddr(m); wb(a, flagsSub(rb(a), s2, 8)); markVga(a); }
        }
        break; }
      case 0x01: case 0x03: {                                     // add r/m16,r16 / add r16,r/m16
        var m = fetchB();
        if (op === 0x03) {
          var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          var d = R16NAMES[(m >> 3) & 7];
          regs[d] = flagsAdd(regs[d], src, 16);
        } else {
          var s2 = regs[R16NAMES[(m >> 3) & 7]];
          if ((m & 0xC0) === 0xC0) { var t2 = R16NAMES[m & 7]; regs[t2] = flagsAdd(regs[t2], s2, 16); }
          else { var a = rmAddr(m); ww(a, flagsAdd(rw(a), s2, 16)); markVga(a); }
        }
        break; }
      case 0x00: case 0x02: {                                     // add r/m8,r8 / add r8,r/m8
        var m = fetchB();
        if (op === 0x02) {
          var src = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          setR8((m >> 3) & 7, flagsAdd(getR8((m >> 3) & 7), src, 8));
        } else {
          var s2 = getR8((m >> 3) & 7);
          if ((m & 0xC0) === 0xC0) setR8(m & 7, flagsAdd(getR8(m & 7), s2, 8));
          else { var a = rmAddr(m); wb(a, flagsAdd(rb(a), s2, 8)); markVga(a); }
        }
        break; }
      case 0x05: regs.ax = flagsAdd(regs.ax, fetchW(), 16); break;   // add ax,imm16
      case 0x0D: regs.ax = flagsAdd(regs.ax, fetchW(), 16); break;   // or stub (or ax,imm) — близко по длине
      case 0x09: case 0x0B: case 0x08: case 0x0A: case 0x19: case 0x1B: case 0x18: case 0x1A: {
        // or/adc/sbb basic: трактуем or как add-only логически (для демо допустимо), sbb/adc -> CF игнор
        var m = fetchB();
        if (op === 0x0B || op === 0x09 || op === 0x1B || op === 0x19) {
          var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          if (op === 0x0B || op === 0x1B) { var d = R16NAMES[(m >> 3) & 7]; regs[d] = (op & 0x10) ? flagsSub(regs[d], src, 16) : (regs[d] | src); }
          else { if ((m & 0xC0) === 0xC0) { var t2 = R16NAMES[m & 7]; regs[t2] = (op & 0x10) ? flagsSub(regs[t2], src, 16) : (regs[t2] | src); } else { var a = rmAddr(m); var v = (op & 0x10) ? flagsSub(rw(a), src, 16) : (rw(a) | src); ww(a, v); markVga(a); } }
        } else {
          var src8 = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          if (op === 0x0A || op === 0x1A) { setR8((m >> 3) & 7, (op & 0x10) ? flagsSub(getR8((m >> 3) & 7), src8, 8) : (getR8((m >> 3) & 7) | src8)); }
          else { if ((m & 0xC0) === 0xC0) setR8(m & 7, (op & 0x10) ? flagsSub(getR8(m & 7), src8, 8) : (getR8(m & 7) | src8)); else { var a = rmAddr(m); var v = (op & 0x10) ? flagsSub(rb(a), src8, 8) : (rb(a) | src8); wb(a, v); markVga(a); } }
        }
        break; }
      case 0x21: case 0x23: case 0x20: case 0x22: {               // and variants
        var m = fetchB();
        if (op === 0x23 || op === 0x21) {
          var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          if (op === 0x23) { var d = R16NAMES[(m >> 3) & 7]; regs[d] = regs[d] & src; setZS(regs[d]); }
          else if ((m & 0xC0) === 0xC0) { var t2 = R16NAMES[m & 7]; regs[t2] = regs[t2] & src; setZS(regs[t2]); }
          else { var a = rmAddr(m); var v = rw(a) & src; ww(a, v); markVga(a); setZS(v); }
        } else {
          var src8 = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          if (op === 0x22) { var rr = (m >> 3) & 7; setR8(rr, getR8(rr) & src8); setZS8(getR8(rr)); }
          else if ((m & 0xC0) === 0xC0) { setR8(m & 7, getR8(m & 7) & src8); setZS8(getR8(m & 7)); }
          else { var a = rmAddr(m); var v = rb(a) & src8; wb(a, v); markVga(a); setZS8(v); }
        }
        break; }
      case 0x31: case 0x33: case 0x30: case 0x32: {               // xor variants
        var m = fetchB();
        if (op === 0x33 || op === 0x31) {
          var src = ((m & 0xC0) === 0xC0) ? regs[R16NAMES[m & 7]] : rw(rmAddr(m));
          if (op === 0x33) { var d = R16NAMES[(m >> 3) & 7]; regs[d] = (regs[d] ^ src) & 0xFFFF; setZS(regs[d]); }
          else if ((m & 0xC0) === 0xC0) { var t2 = R16NAMES[m & 7]; regs[t2] = (regs[t2] ^ src) & 0xFFFF; setZS(regs[t2]); }
          else { var a = rmAddr(m); var v = (rw(a) ^ src) & 0xFFFF; ww(a, v); markVga(a); setZS(v); }
        } else {
          var src8 = ((m & 0xC0) === 0xC0) ? getR8(m & 7) : rb(rmAddr(m));
          if (op === 0x32) { var rr = (m >> 3) & 7; setR8(rr, getR8(rr) ^ src8); setZS8(getR8(rr)); }
          else if ((m & 0xC0) === 0xC0) { setR8(m & 7, getR8(m & 7) ^ src8); setZS8(getR8(m & 7)); }
          else { var a = rmAddr(m); var v = rb(a) ^ src8; wb(a, v); markVga(a); setZS8(v); }
        }
        break; }
      case 0x06: case 0x0E: case 0x16: case 0x1E:                 // push es/ss/ds
        regs.sp = (regs.sp - 2) & 0xFFFF; ww(la(regs.ss, regs.sp), regs[SEG_NAMES[(op >> 3) & 3]]); break;
      case 0x07: case 0x17: case 0x1F:                             // pop es/ss/ds (pop cs 0x1F? нет: 0x1F=pop ds)
        regs[SEG_NAMES[[0x07,0x0F,0x17,0x1F].indexOf(op) >= 0 ? ([0x07,0x0F,0x17,0x1F].indexOf(op)) : 0]] = rw(la(regs.ss, regs.sp));
        regs.sp = (regs.sp + 2) & 0xFFFF; break;
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F: {   // jcc rel8
        var rel = fetchB() << 24 >> 24;
        var F = regs.flags;
        var take = [F & 1, !(F & 1), F & 1, !(F & 1), F & 0x40, !(F & 0x40), F & 1 || F & 0x40, !(F & 1 || F & 0x40),
                    F & 0x80, !(F & 0x80), F & 1, !(F & 1), (F & 0x40) !== ((F >> 7) & 1) ? 1 : 0, (F & 0x40) === ((F >> 7) & 1) ? 1 : 0,
                    ((F & 0x40) && !((F >> 7) & 1)) || (!(F & 0x40) && ((F >> 7) & 1)) ? 1 : 0,
                    !(((F & 0x40) && !((F >> 7) & 1)) || (!(F & 0x40) && ((F >> 7) & 1))) ? 1 : 0][op - 0x70];
        if (take) regs.ip = (regs.ip + rel) & 0xFFFF;
        break; }
      case 0x0F: {                                                // двухбайтовые jcc rel16 (0F 80..8F)
        var o2 = fetchB();
        if (o2 >= 0x80 && o2 <= 0x8F) {
          var rel = fetchW() << 16 >> 16;
          var F = regs.flags;
          var cnd = o2 & 0xF;
          var take = (cnd === 0 ? (F & 1) : cnd === 1 ? !(F & 1) : cnd === 2 ? (F & 1) : cnd === 3 ? !(F & 1) :
                     cnd === 4 ? (F & 0x40) : cnd === 5 ? !(F & 0x40) : cnd === 6 ? (F & 1 || F & 0x40) : cnd === 7 ? !(F & 1 || F & 0x40) :
                     cnd === 8 ? (F & 0x80) : cnd === 9 ? !(F & 0x80) : cnd === 0xA ? (F & 1) : cnd === 0xB ? !(F & 1) :
                     cnd === 0xC ? !!((F & 0x40) !== ((F >> 7) & 1)) : cnd === 0xD ? !((F & 0x40) !== ((F >> 7) & 1)) :
                     cnd === 0xE ? !!(((F & 0x40) && !((F >> 7) & 1)) || (!(F & 0x40) && ((F >> 7) & 1))) :
                     !!!(((F & 0x40) && !((F >> 7) & 1)) || (!(F & 0x40) && ((F >> 7) & 1)))) ? true : false;
          if (take) regs.ip = (regs.ip + rel) & 0xFFFF;
        } else { running = false; halted = 'unknown:0f' + o2.toString(16); }
        break; }
      case 0xEA: { var off = fetchW(), seg = fetchW(); regs.ip = off; regs.cs = seg; break; }  // jmp far
      case 0x9B: break;                                          // wait — nop
      case 0xC2: { fetchW(); regs.ip = rw(la(regs.ss, regs.sp)); regs.sp = (regs.sp + 2) & 0xFFFF; break; } // ret imm16
      case 0xC0: case 0xC1: case 0xD0: case 0xD2: {              // сдвиги с imm/cl — грубо только shl/shr by count
        var m = fetchB();
        var isReg = (m & 0xC0) === 0xC0;
        var addr = isReg ? null : rmAddr(m);
        var wide = op === 0xC1 || op === 0xD1 || op === 0xD3 || op === 0xC1;
        var v = isReg ? regs[R16NAMES[m & 7]] : (wide ? rw(addr) : rb(addr));
        var cnt = (op === 0xC0 || op === 0xC1) ? (fetchB() & 0x1F) : (regs.cx & 0x1F);
        var wsel = ((m >> 3) & 7);
        if (wsel === 4) v = (v << cnt) & (wide ? 0xFFFF : 0xFF);
        else if (wsel === 5) v = (v >> cnt) & (wide ? 0xFFFF : 0xFF);
        else if (wsel === 7) v = (v >> cnt) & (wide ? 0xFFFF : 0xFF);
        if (isReg) regs[R16NAMES[m & 7]] = v; else if (wide) { ww(addr, v); markVga(addr); } else wb(addr, v);
        setZS(wide ? v : v & 0xFF);
        break; }
      case 0xD8: case 0xD9: case 0xDA: case 0xDB: case 0xDC: case 0xDD: case 0xDE: case 0xDF:
        fetchB(); break;                                          // x87 — глотаем modrm (демо-программы не используют сопроцессор)
      case 0xCC: running = false; halted = 'int3'; break;         // breakpoint
      case 0xCB: case 0xCF: break;                               // retf/iret — упрощённо nop (стеки не трогаем)
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
        halted = null;                               // клавиша пришла: повторим int, он заберёт её сам
        regs.ip = (regs.ip - 2) & 0xFFFF;            // откат IP на CD xx (прерывание ещё нужно выполнить)
      }
      var prevIp = regs.ip;
      step(prevIp, n); n++;
      if (halted === 'selfloop') break;              // tight-петля: отдаём управление UI (main.js продолжит slice)
      // страховка: IP вернулся туда же и цикл без прерываний — тоже считаем плотной петлёй
      if (n > 1 && halted === null && regs.ip === prevIp) { halted = 'selfloop'; break; }
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
