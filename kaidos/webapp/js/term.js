/* KaDOS Terminal v0.2.5 — видимый ввод (Т9), вывод, портретная ориентация.
   1) Набранная строка всегда видна: "> текст|" с курсором.
   2) Подсказки Т9 показаны отдельной строкой над вводом.
   3) После каждой команды вывод автопрокручивается к последней строке.

   Управление Nokia 800 Tough (KaiOS): цифры 2-9 = буквы T9,
   * = переключение словаря (ABC->abc->123), # = регистр,
   Backspace = C, OK/Enter = отправка, мягкие клавиши = выбор слова. */
(function () {
  'use strict';

  var KEYS = {
    // цифра -> возможные буквы (раскладка ITU-T, ru+en)
    '2': ['a', 'b', 'c', 'а', 'б', 'в', 'г'],
    '3': ['d', 'e', 'f', 'д', 'е', 'ж', 'з'],
    '4': ['g', 'h', 'i', 'и', 'й', 'к', 'л'],
    '5': ['j', 'k', 'l', 'м', 'н', 'о', 'п'],
    '6': ['m', 'n', 'o', 'р', 'с', 'т', 'у'],
    '7': ['p', 'q', 'r', 's', 'ф', 'х', 'ц', 'ч'],
    '8': ['t', 'u', 'v', 'ш', 'щ', 'э', 'ю', 'я'],
    '9': ['w', 'x', 'y', 'z', 'ъ', 'ь', '-', '.']
  };

  function TermApp() {
    this.canvas = document.getElementById('scr');
    this.hud = document.getElementById('hud');
    this.ctx = this.canvas.getContext('2d');
    this.lines = [];            // вывод консоли (массив строк)
    this.input = '';            // подтверждённый текст
    this.pending = null;        // {digit, idx} незавершённый Т9-символ
    this.t9mode = 'lower';      // 'upper' | 'lower' | 'num'
    this.history = [];
    this.histIdx = -1;
    this.maxLines = 18;         // 320x240 portrait: ~18 строк по 12px + инфо-строки
    this.bindKeys();
    this.printBanner();
  }

  /* ---------- рендер ---------- */

  TermApp.prototype.render = function () {
    if (this.emuRunning) return;   // VGA-буфер main.js — не перерисовывать поверх эмулятора
    var c = this.ctx, W = 320, H = 240;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.font = '12px monospace';

    var y = 12;
    // шапка
    c.fillStyle = '#0af';
    c.fillText('KaDOS TERM  [T9:' + this.t9mode.toUpperCase() + ']', 4, y); y += 14;

    // строка вывода (автопрокрутка: последние maxLines-3 строк)
    c.fillStyle = '#0f0';
    var budget = this.maxLines - 3;
    var start = Math.max(0, this.lines.length - budget);
    for (var i = start; i < this.lines.length; i++) {
      c.fillText(this.lines[i].slice(0, 36), 4, y); y += 12;
    }

    // Т9-подсказка (видимая!)
    if (this.pending) {
      var opts = KEYS[this.pending.digit] || [];
      c.fillStyle = '#ff0';
      c.fillText('T9 ' + this.pending.digit + ': ' + opts.join(' '), 4, y); y += 12;
    }

    // строка ввода с видимым текстом и курсором
    c.fillStyle = '#fff';
    var shown = this.input + (this.pending ? '[' + (KEYS[this.pending.digit] || [])[this.pending.idx % ((KEYS[this.pending.digit] || []).length || 1)] + ']' : '');
    var caret = this.t9mode === 'num' ? '|' : '|';
    c.fillText('> ' + shown + caret, 4, y); y += 12;

    // подсказка управления
    c.fillStyle = '#888';
    c.fillText('OK-run  C-del  *=mode  #=case', 4, H - 4);

    if (this.hud) this.hud.textContent = '';
  };

  TermApp.prototype.print = function (text) {
    var s = String(text).split('\n');
    for (var i = 0; i < s.length; i++) this.lines.push(s[i]);
    while (this.lines.length > 200) this.lines.shift();
    this.render();
  };

  TermApp.prototype.printBanner = function () {
    this.lines.push('KaDOS terminal v0.2.5');
    this.lines.push('type HELP + Enter');
    this.render();
  };

  /* ---------- Т9 ---------- */

  TermApp.prototype.commitPending = function () {
    if (!this.pending) return;
    var opts = KEYS[this.pending.digit];
    var ch = opts ? opts[this.pending.idx % opts.length] : this.pending.digit;
    if (this.t9mode === 'upper') ch = ch.toUpperCase();
    this.input += ch;
    this.pending = null;
  };

  TermApp.prototype.onDigit = function (d) {
    if (this.t9mode === 'num') { this.input += d; this.render(); return; }
    if (!KEYS[d]) { this.input += d; this.render(); return; }
    if (this.pending && this.pending.digit === d) {
      this.pending.idx++;                 // циклический выбор буквы
    } else {
      this.commitPending();               // новая цифра — фиксируем предыдущую
      this.pending = { digit: d, idx: 0 };
    }
    this.render();
  };

  /* ---------- команды ---------- */

  TermApp.prototype.emuActive = function () {
    if (!window.KaDOS) return false;
    var out = window.KaDOS.runSlice(300);          // квант на кадр терминала
    var s = window.KaDOS.getConsole();
    if (s) this.print(s);
    this.emuRunning = out.running;                 // флаг для маршрутизации клавиш
    if (!out.running && !this._exitReported) {     // программа завершилась — вернуть управление
      this.print('[program ' + out.halted + ', steps=' + out.steps + ']');
      this._exitReported = true;
      return false;
    }
    return out.running;
  };

  TermApp.prototype.runCommand = function () {
    this.commitPending();
    var cmd = this.input.trim();
    this.input = '';
    if (cmd) { this.history.push(cmd); }
    this.histIdx = this.history.length;
    this.print('C:\\> ' + cmd);
    var lower = cmd.toLowerCase();
    if (!cmd) { /* пусто — просто новая строка */ }
    else if (lower === 'help') {
      this.print('HELP DIR RUN <name>');
      this.print('DEMO HELLO|ECHO|COUNT');
      this.print('CLS CLEAR  VER');
    } else if (lower === 'cls' || lower === 'clear') {
      this.lines = [];
    } else if (lower === 'ver') {
      this.print('KaDOS 0.2.5 (Nokia 800 Tough)');
    } else if (lower === 'dir') {
      this.print(' HELLO.COM  ECHO.COM  COUNT.COM');
    } else if (lower.indexOf('demo ') === 0) {
      var name = cmd.split(' ')[1].toUpperCase();
      if (window.KaDOS && window.KaDOS.loadDemoByName) {
        this._exitReported = false;
        var ok = window.KaDOS.loadDemoByName(name);
        this.print(ok ? 'running ' + name + '...' : 'unknown demo');
      } else {
        this.print('emulator not ready');
      }
    } else {
      this.print('Bad command: ' + cmd);
    }
    // гарантированная прокрутка к последней строке
    var budget = this.maxLines - 3;
    if (this.lines.length > budget) this.lines = this.lines.slice(-budget);
    this.render();
  };

  /* ---------- клавиатура ---------- */

  TermApp.prototype.bindKeys = function () {
    var self = this;
    // Цикл терминала: если запущена эмулируемая программа — крутим VM квантами,
    // нажатые клавиши идут в KaDOS.pressKey (INT 21h/01h их заберёт).
    this._tick = setInterval(function () {
      if (self.emuActive()) self.render();
    }, 60);

    document.addEventListener('keydown', function (e) {
      var k = e.key;
      // во время работы эмулируемой программы все символы уходят прямо в VM
      if (self.emuRunning && window.KaDOS) {
        var map = { Enter: 13, Backspace: 8, Escape: 27 };
        if (map[k] !== undefined) { KaDOS.pressKey(map[k]); }
        else if (/^[0-9a-z ]$/i.test(k) || /^[а-яА-ЯёЁ]$/.test(k)) { KaDOS.pressKey(k.toUpperCase().charCodeAt(0)); }
        var arrows = { ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4B, ArrowRight: 0x4D };
        if (arrows[k]) KaDOS.pressKey(arrows[k]);
        e.preventDefault(); return;
      }
      // цифры T9
      if (/^[0-9]$/.test(k)) { self.onDigit(k); e.preventDefault(); return; }
      switch (k) {
        case 'Enter': self.runCommand(); e.preventDefault(); break;
        case 'Backspace':
          if (self.pending) self.pending = null;
          else self.input = self.input.slice(0, -1);
          self.render(); e.preventDefault(); break;
        case '*':
          self.t9mode = self.t9mode === 'lower' ? 'upper' : (self.t9mode === 'upper' ? 'num' : 'lower');
          self.commitPending(); self.render(); e.preventDefault(); break;
        case '#':
          self.commitPending();
          if (self.input.length) {
            var last = self.input.slice(-1);
            self.input = self.input.slice(0, -1) + (last === last.toUpperCase() ? last.toLowerCase() : last.toUpperCase());
          }
          self.render(); e.preventDefault(); break;
        default:
          // десктоп: обычные буквы пишутся напрямую
          if (k.length === 1 && !/^[0-9*#]$/.test(k)) { self.commitPending(); self.input += k; self.render(); }
      }
    });
    // KaiOS softkey/выбор слова Т9: левая мягкая = подтвердить текущую букву
    window.addEventListener('kaios-t9-confirm', function () { self.commitPending(); self.render(); });
  };

  window.KaDOS = window.KaDOS || {};
  // Интеграция с терминалом: KaDOS.loadDemoByName('HELLO') -> запуск демо из loader.
  (function () {
    var K = window.KaDOS;
    K.loadDemoByName = function (name) {
      var demos = (window.KaLoader && window.KaLoader.DEMOS) || null;
      if (!demos || !K.loadCom) return false;
      name = String(name).toUpperCase();
      for (var i = 0; i < demos.length; i++) {
        var d = demos[i];
        if (d.name.toUpperCase() === name || d.name.toUpperCase() === name + '.COM') {
          K.loadCom(d.bytes);
          K.resetHalt && K.resetHalt();
          return true;
        }
      }
      return false;
    };
  })();

  window.KaDOSTerm = new TermApp();
})();
