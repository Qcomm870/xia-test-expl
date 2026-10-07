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
  var programName = '';
  var loadError = '';
  var dpadDebugMessage = '';
  var dpadDebugToken = 0;
  /* Пустой экран при первом открытии: без баннеров, как в Terminal от Affe Null. */
  var terminalHistory = '';
  var terminalLine = '';
  var terminalInput = document.getElementById('terminal-input');
  var terminalCommands = [];
  var terminalHistoryIndex = 0;
  var terminalHistoryDraft = '';

  /* ===== T9 multi-tap ввод (как в Terminal от Affe Null) ===== */
  var t9Keys = [
    [' ', '0'],
    ['.', ',', '?', '!', '1', ';', ':', '/', '@', '-', '+', '_', '=', '$', '|', '<', '>'],
    ['a', 'b', 'c', '2'],
    ['d', 'e', 'f', '3'],
    ['g', 'h', 'i', '4'],
    ['j', 'k', 'l', '5'],
    ['m', 'n', 'o', '6'],
    ['p', 'q', 'r', 's', '7'],
    ['t', 'u', 'v', '8'],
    ['w', 'x', 'y', 'z', '9']
  ];
  var t9Key = -1;            // индекс текущей клавиши-группы
  var t9Index = 0;           // индекс символа внутри группы
  var t9Timer = null;        // задержка «добора» символа
  var t9Upper = false;       // переключатель регистра (#)
  var t9Control = false;     // режим Ctrl (Call)
  var t9BufferEl = document.getElementById('t9-buffer');
  var t9CaretEl = document.getElementById('t9-caret');
  var t9HintEl = document.getElementById('t9-hint');

  function t9CommittedText() {
    if (!t9BufferEl) return terminalLine;
    /* буфер содержит caret-элемент внутри — берём только текстовые узлы,
       иначе textContent включает '|' и мусор попадает в команду */
    var out = '';
    for (var n = t9BufferEl.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out;
  }

  /* Т9-раскладка Affe Null (terminal от OmniSD) построена по НОМЕРАМ клавиш:
     keys[0]=' ', keys[1]= punct+цифры, keys[2..9] = буквы на клавишах 2..9.
     В оригинале символ выбирается как keys[num][index], где num — цифра клавиши. */
  function t9CharFor(num, index) {
    var group = t9Keys[num];
    if (!group) return String(num);
    return group[index % group.length];
  }

  /* Как в оригинале Terminal от Affe Null: pending-символ печатается В ТОЙ ЖЕ
     ячейке и циклически меняется при повторных нажатиях клавиши. Раньше он
     показывался в скобках "[f]" после текста — выглядело как мусор перед
     подтверждённой буквой. Теперь: committed text + сам символ + '|' каретка. */
  function t9VisiblePending() {
    if (t9Key < 0) return '';
    var ch = t9CharFor(t9Key, t9Index);
    if (/^[a-z]$/.test(ch)) ch = t9Upper ? ch.toUpperCase() : ch;
    return ch;
  }

  /* Рендер строки состояния: Т9-режим + варианты текущей клавиши + буфер.
     ВАЖНО: раньше здесь был ранний return при отсутствии DOM-узлов — если
     index.html не догрузился, НЕ ОБНАРУЖИВАЛОСЬ НИ ВВОДА, НИ ВЫВОДА.
     Теперь узлы опциональны, а состояние всегда дублируется в hud. */
  /* Синхронизация скрытого <input>: на KaiOS без него IME/T9-клавиатура
     телефона не отдаёт события клавиш в window.keydown. Значение поля всегда
     равно подтверждённому тексту буфера — автоподстановка игнорируется
     (источник истины — наш multi-tap, как в Terminal от Affe Null). */
  function syncHiddenInput() {
    if (!terminalInput) return;
    try { terminalInput.value = t9CommittedText(); } catch (error) {}
  }

  function t9Render() {
    /* v0.2.58: терминальный ввод живёт ТОЛЬКО в putChar-сетке (терминальная
       область, как в оригинале Terminal от Affe Null). Строка terminalLine —
       источник истины; нижняя строка t9-buffer/hud показывает её копию, а не
       второй вывод. Pending-группа НЕ показывается отдельным «[f]» — символ
       уже напечатан в сетке и циклически заменяется там же. */
    var visible = terminalLine;
    syncHiddenInput();
    if (t9BufferEl && t9CaretEl) {
      var node = document.createTextNode(visible);
      while (t9BufferEl.firstChild) t9BufferEl.removeChild(t9BufferEl.firstChild);
      t9BufferEl.appendChild(node);
      t9BufferEl.appendChild(t9CaretEl);
    }
    if (t9HintEl) {
      var modeStr = (t9Control ? 'Ctrl ' : '') + (t9Upper ? 'ABC' : 'abc');
      var options = t9Key >= 0 && t9Keys[t9Key] ? t9Keys[t9Key].join(' ') : '';
      t9HintEl.textContent = modeStr + (options ? ' | ' + options : '');
    }
    if (terminalInput) terminalInput.value = terminalLine;
    /* hud-дублирование строки ввода только когда терминал ОТКРЫТ — иначе
       каждый кадр loop() затирал статус эмулятора и «съедал» вывод. */
    if (hud && terminalIsOpen()) hud.textContent = '>' + (visible || ' ') + ' [' +
      (t9Control ? 'CTRL ' : '') + (t9Upper ? 'ABC' : 'abc') + ']';
  }

  function t9SetText(text) {
    terminalLine = text || '';
  }

  /* Принудительное подтверждение pending-символа (Enter/Backspace/#/Call). */
  function t9ForceCommit() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    if (t9Key >= 0) t9Commit();
  }

  /* v0.2.58 — Точный порт модели ввода Terminal от Affe Null (app.js).
     Чему мы научились на реальных прогонах (жалобы «сначала [f], потом f»,
     «нет вывода», «не стирается»): ДВОЙНОЙ рендер строки ввода.
     Раньше символы печатались ОДНОВРЕМЕННО в два места — putChar-сетку
     терминала (эхо) и нижнюю строку t9-buffer. На экране это выглядело как
     мусор: буква в сетке, потом та же буква в буфере, при замене a->b старая
     оставалась в истории и т.п.

     В оригинале есть ЕДИНСТВЕННАЯ область — сетка putChar. Отправка (send)
     происходит мгновенно telnetSend-ом; сервер возвращает echo; повторные
     нажатия заменяют символ через '\b'. У нас роль «сервера» играет локальный
     движок: termSend() печатает символ один раз в сетку, замена — '\b'+ch,
     Backspace по пустому pending шлёт '\b'. t9-buffer остаётся ТОЛЬКО видимой
     копией строки (никакого второго вывода). */
  function t9ApplyCase(ch) {
    if (/^[a-z]$/.test(ch)) {
      if (t9Control) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40);
      else if (t9Upper) ch = ch.toUpperCase();
    }
    return ch;
  }

  /* Единственная точка печати ввода (аналог sock.send в оригинале). */
  function t9SendRaw(ch) {
    termPrint(ch);                       // putChar-сетка — единственный вывод
    if (ch !== '\b') terminalLine += ch; // история строки для Enter/CLS
  }

  /* Подтверждение текущего pending-символа (send() в оригинале). */
  function t9Commit() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    if (t9Key < 0) return;
    var ch = t9ApplyCase(t9CharFor(t9Key, t9Index));
    if (t9PendingSent) {
      /* символ уже напечатан ранее — заменяем его на месте, как оригинал:
         '\b' затирает предыдущий символ, затем печать нового */
      t9SendRaw('\b');
    }
    t9SendRaw(ch);
    t9PendingSent = true;                // теперь pending живёт В СЕТКЕ
    t9Key = -1;
    t9Index = 0;
    t9Control = false;                   // Ctrl одноразовый (как control=false в send())
    t9Render();
  }

  /* groupIndex == номер цифры клавиши (0..9), как в оригинале Affe Null */
  function t9PressGroup(groupIndex) {
    var group = t9Keys[groupIndex] || [String(groupIndex)];
    if (t9Key === groupIndex) {
      /* повторное нажатие той же клавиши: индексируем группу; если символ
         уже был отправлен в сетку — цикл замены произойдёт в t9Commit
         ('\b'+новый), ровно как в оригинале после telnetSend */
      t9Index = (t9Index + 1) % group.length;
      if (t9PendingSent) {
        /* мгновенная замена в сетке (эквивалент send() на каждом нажатии) */
        t9SendRaw('\b');
        t9SendRaw(t9ApplyCase(t9CharFor(groupIndex, t9Index)));
      }
      t9Render();
    } else {
      if (t9Key >= 0) t9Commit();
      t9Key = groupIndex;
      t9Index = 0;
      /* первое нажатие клавиши: символ отправляется СРАЗУ (telnetSend в
         onkeydown оригинала) — пользователь видит букву немедленно, без
         ожидания таймера и без дублей */
      t9SendRaw(t9ApplyCase(t9CharFor(groupIndex, 0)));
      t9PendingSent = true;
      t9Render();
    }
    if (t9Timer) clearTimeout(t9Timer);
    /* в оригинале sendTimeoutId = setTimeout(send, 1000) — у нас коммит
       ничего не меняет визуально (символ уже в сетке), но фиксирует конец
       группы: следующее нажатие другой клавиши не будет «заменять» этот */
    t9Timer = setTimeout(function () { t9Commit(); }, 1000);
  }
  var t9PendingSent = false;   // pending-символ уже напечатан в putChar-сетке

  function t9Backspace() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    if (t9Key >= 0) {
      /* как в оригинале: пока идёт набор группы, Backspace ПРОСТО ОТМЕНЯЕТ
         её (clearTimeout, currentKey=-1) — если символ уже был послан в
         сетку, стираем его '\b' */
      if (t9PendingSent) t9SendRaw('\b');
      t9Key = -1; t9Index = 0; t9PendingSent = false; t9Render(); return;
    }
    /* нет активного pending — отправляем '\b' серверу (терминалу): стирает
       последний символ строки ввода в putChar-сетке */
    if (terminalLine.length) {
      t9SendRaw('\b');
      terminalLine = terminalLine.slice(0, -1);
      t9Render();
    }
  }

  function t9Submit() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    t9Commit();                          // подтвердить pending (без '\b', он уже в сетке)
    var command = terminalLine;          // строка уже набрана эхом в сетке
    terminalLine = '';
    t9PendingSent = false;
    t9Render();
    submitTerminalLine(command);
  }
  var filePanel = document.getElementById('file-panel');
  var fileList = document.getElementById('file-list');
  var fileSelected = -1;
  var fileItems = [];
  var fileButton = null;
  var editButton = document.getElementById('edit-text');
  var actionsButton = document.getElementById('open-actions');
  var editorPanel = document.getElementById('editor-panel');
  var editorText = document.getElementById('editor-textarea');
  var currentFilename = document.getElementById('filename-label');
  var editorFilename = document.getElementById('editor-filename');
  var currentFile = null;
  var saveFormat = '.txt';
  var saveAsReturnButtonId = 'save-as-file';
  var fileFilterMode = 'all';

  function setCurrentFile(item, displayName) {
    currentFile = item || null;
    var name = displayName || (item && item.name) || 'Без имени';
    if (currentFilename) currentFilename.textContent = name;
    if (editorFilename) editorFilename.textContent = name;
  }

  function closePanels() {
    ['file-panel', 'editor-panel', 'actions-panel', 'save-as-panel', 'delete-panel', 'terminal-panel'].forEach(function (id) {
      var panel = document.getElementById(id);
      if (panel) panel.classList.add('hidden');
    });
  }

  function showPanel(panel) {
    closePanels();
    if (panel) panel.classList.remove('hidden');
  }

  function showStatus(message) {
    loadError = message || '';
    if (hud) hud.textContent = loadError;
  }

  function showDpadDebug(event, key, mappedKey, active, beforeStart, beforeEnd) {
    if (active !== editorText && (!active || active.id !== 'saveas-name') &&
        visiblePanel().id !== 'save-as-panel') return;
    var focused = document.activeElement;
    var caret = focused && typeof focused.selectionStart === 'number'
      ? focused.selectionStart + '>' + focused.selectionEnd
      : '-';
    var activeName = active === editorText ? 'edit' : active && active.id === 'saveas-name' ? 'name' : active && active.id || '?';
    var focusedName = focused === editorText ? 'edit' : focused && focused.id === 'saveas-name' ? 'name' : focused && focused.id || '?';
    dpadDebugMessage = 'DP ' + (event.key || event.code || '?') + '#' +
      (event.keyCode || event.which || '?') + '>' + mappedKey + ' ' + activeName + '>' + focusedName + ' ' +
      (beforeStart === null ? '-' : beforeStart) + '>' + (caret === '-' ? '-' : caret);
    var token = ++dpadDebugToken;
    setTimeout(function () {
      if (token === dpadDebugToken) dpadDebugMessage = '';
    }, 5000);
  }

  function terminalIsOpen() {
    var panel = document.getElementById('terminal-panel');
    return panel && !panel.classList.contains('hidden');
  }

  /* ===== Полностью порт движка Terminal от Affe Null (app.js) =====
     Сетка 20x13, putChar/newLine/setChar один-в-один как в оригинале.
     Никаких баннеров («Welcome to KaDOS» убран), вывод появляется сразу,
     строка ввода — отдельный DOM-узел под сеткой (ничего не перекрывает). */
  var TERM_COLS = 20;   // maxx в оригинале (240px / 18px Droid Sans Mono)
  var TERM_ROWS = 13;   // maxy в оригинале
  var termGridEl = null;
  var termChars = [];   // chars[y][x] = span-элементы, как в оригинале
  var termCurX = 0, termCurY = 0;

  function ensureTermGrid() {
    if (!termGridEl) termGridEl = document.getElementById('terminal-output');
    if (termGridEl && !termChars.length) {
      termGridEl.innerHTML = '';
      for (var i = 0; i < TERM_ROWS; i++) {
        var lineEl = document.createElement('span');
        var rowArr = [];
        for (var j = 0; j < TERM_COLS; j++) {
          var chEl = document.createElement('span');
          chEl.textContent = ' ';
          rowArr.push(chEl);
          lineEl.appendChild(chEl);
        }
        termChars.push(rowArr);
        termGridEl.appendChild(lineEl);
        termGridEl.appendChild(document.createElement('br'));
      }
    }
    return termGridEl;
  }

  /* setChar из оригинала: печать символа в ячейку */
  function termSetChar(x, y, ch) {
    var cell = termChars[y] && termChars[y][x];
    if (cell) cell.textContent = ch;
  }

  /* newLine из оригинала: сдвиг экрана вверх, новая пустая строка снизу */
  function termNewLine() {
    var firstLine = termGridEl.firstChild;
    if (firstLine) termGridEl.removeChild(firstLine);           // span строки
    var second = termGridEl.firstChild;
    if (second && second.nodeName === 'BR') termGridEl.removeChild(second);
    termChars.shift();
    var lineEl = document.createElement('span');
    var rowArr = [];
    for (var j = 0; j < TERM_COLS; j++) {
      var chEl = document.createElement('span');
      chEl.textContent = ' ';
      rowArr.push(chEl);
      lineEl.appendChild(chEl);
    }
    termChars.push(rowArr);
    termGridEl.appendChild(lineEl);
    termGridEl.appendChild(document.createElement('br'));
  }

  /* putChar из оригинала: посимвольный рендер с переносом и скроллом.
     ВАЖНО (исправление v0.2.50): в оригинале после \n курсор НЕ сбрасывается
     в X=0 — строки "HELP\nFILES" печатались слитной строкой. У DOS-консоли
     перевод строки = CRLF, поэтому здесь \n делает ещё и termCurX=0. */
  function termPutChar(ch) {
    ensureTermGrid();
    if (!termChars.length) return;
    if (ch === '\n') {
      if (termCurY >= TERM_ROWS - 1) termNewLine();
      else termCurY++;
      termCurX = 0;
      return;
    }
    if (ch === '\r') { termCurX = 0; return; }
    if (ch === '\b') {
      if (termCurX > 0) { termCurX--; termSetChar(termCurX, termCurY, ' '); }
      return;
    }
    if (ch.charCodeAt(0) < 0x20) return;                        // прочие control — игнор
    if (termCurX >= TERM_COLS) {                                // wrap как в оригинале
      termCurX = 0;
      if (termCurY >= TERM_ROWS - 1) termNewLine();
      else termCurY++;
    }
    termSetChar(termCurX, termCurY, ch);
    termCurX++;
  }

  /* putStr из оригинала */
  function termPutStr(str) {
    for (var i = 0; i < str.length; i++) termPutChar(str.charAt(i));
  }

  /* Полный сброс и перерисовка истории (для CLS / FILES и т.п.) */
  function renderTerminal() {
    ensureTermGrid();
    if (!termGridEl) return;
    while (termGridEl.firstChild) termGridEl.removeChild(termGridEl.firstChild);
    termChars = [];
    termCurX = 0; termCurY = 0;
    for (var i = 0; i < TERM_ROWS; i++) termNewLine();
    var text = terminalHistory.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    /* ВАЖНО (исправление v0.2.52): consoleText — это буфер ЭКРАНА эмулятора
       (canvas), а не история терминала. Раньше он допечатывался сюда при
       каждом полном redraw, из-за чего после HELP/FILES экран «засыпался»
       старым выводом HELLO.COM и казалось, что вывода команд нет.
       Вывод программ идёт в терминал только инкрементально через loop(). */
    termPutStr(text);
    /* (v0.2.53) Не очищаем getConsole(): буфер эмулятора уже напечатан
       инкрементально в putChar-сетку; повторный getConsole() здесь крадёт
       ещё не отрендеренные символы («вывода нет»). lastEmuConsoleLength
       больше не используется — синхронизация одна: termPrint -> history+grid. */
    termCharsOk = true;
  }

  /* Инкрементальный вывод без полного redraw (главный путь для loop()).
     Вывод эмулятора печатается ТОЛЬКО новыми символами — иначе каждый кадр
     перепечатывался весь буфер и экран «не двигался».

     ВАЖНО (исправление v0.2.52): раньше эта функция нигде не вызывалась
     («мёртвый код»), поэтому терминал НИЧЕГО не выводил из DOS-программ —
     только ответы команд. Теперь дельта consoleBuf печатается в сетку после
     каждой порции вывода в loop(). */
  var lastEmuConsoleLength = 0;
  var termCharsOk = false;   // сетка реально создана (putChar пишет в DOM)

  function termAppend(text) {
    ensureTermGrid();   /* сетка создаётся лениво: вывод появляется сразу,
                           даже если терминал открыли впервые на этой команде */
    var norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    terminalHistory += norm;
    termPutStr(norm);
  }

  /* Рендер вывода (v0.2.53, как в оригинале Terminal от Affe Null):
     putChar-сетка 12x20 — основной и ЕДИНСТВЕННЫЙ путь для инкрементного
     вывода; <pre id="terminal-output"> больше НЕ заполняется текстом
     (раньше два параллельных рендера конфликтовали). Если DOM-узлы сетки
     ещё не готовы — вывод остаётся в terminalHistory и будет перерисован
     renderTerminal() при открытии терминала. */
  function termPrint(text) {
    if (!text) return;
    var norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    ensureTermGrid();
    if (termChars.length) {
      termCharsOk = true;
      termPutStr(norm);
    } else {
      termCharsOk = false;
    }
    terminalHistory += norm;
  }

  /* Инкрементный вывод дельты эмулятора: через тот же termPrint
     (putChar + история), без второго пути записи. */
  function termPrintEmuDelta(text) {
    termPrint(text);
  }

  function closeTerminal() {
    var panel = document.getElementById('terminal-panel');
    if (panel) {
      panel.classList.add('hidden');
      panel.style.height = '';
    }
    document.body.classList.remove('terminal-mode');
    var appShell = document.querySelector('.app-shell');
    if (appShell) {
      appShell.classList.remove('terminal-mode');
      appShell.style.height = '';
    }
    setTerminalOrientation(false);
    var button = document.getElementById('open-terminal');
    if (button) button.focus();
  }

  function setTerminalOrientation(locked) {
    var screenApi = window.screen;
    if (!screenApi) return;
    try {
      if (locked) {
        var lock = screenApi.mozLockOrientation || screenApi.lockOrientation;
        if (typeof lock === 'function') {
          if (!lock.call(screenApi, 'portrait-primary')) lock.call(screenApi, 'portrait');
        } else if (screenApi.orientation && typeof screenApi.orientation.lock === 'function') {
          var request = screenApi.orientation.lock('portrait');
          if (request && typeof request.catch === 'function') request.catch(function () {});
        }
      } else {
        var unlock = screenApi.mozUnlockOrientation || screenApi.unlockOrientation;
        if (typeof unlock === 'function') unlock.call(screenApi);
        else if (screenApi.orientation && typeof screenApi.orientation.unlock === 'function') screenApi.orientation.unlock();
      }
    } catch (error) {}
  }

  function updateTerminalViewport() {
    var height = window.visualViewport && window.visualViewport.height || window.innerHeight;
    if (height > 0) {
      height = Math.max(120, Math.min(320, Math.floor(height)));
      var panel = document.getElementById('terminal-panel');
      var appShell = document.querySelector('.app-shell');
      if (panel) panel.style.height = height + 'px';
      if (appShell && appShell.classList.contains('terminal-mode')) appShell.style.height = height + 'px';
    }
  }

  function submitTerminalLine(forcedCommand) {
    var command = typeof forcedCommand === 'string' ? forcedCommand
      : (terminalInput ? terminalInput.value : terminalLine);
    if (typeof forcedCommand !== 'string') {
      /* вызов не из T9-пути (например, form.submit с автоподстановкой):
         строка не была напечатана эхом — печатаем '> команда', как telnet-echo */
      termPrint('> ' + command);
    }
    terminalLine = '';
    if (terminalInput) terminalInput.value = '';
    /* ЭХО набранной строки — как в оригинале Terminal от Affe Null: символы
       уже напечатаны в putChar-сетку по мере нажатия клавиш (t9SendRaw),
       поэтому здесь НЕ печатаем "> команда" целиком (иначе дубль).
       Печатаем только перевод строки перед выводом результата. */
    termPrint('\n');
    runTerminalCommand(command, true);
  }

  /* T9-обработчик: возвращает true, если событие перехвачено.
     ВАЖНО (исправление v0.2.52): на Nokia 800 Tough цифры приходят как
     e.key='2' ИЛИ как keyCode=50, а навигационные клавиши D-pad — как
     keyCode 21/22/20 (Legacy Gecko). normalizeDeviceKey превращает их в
     Arrow*, и раньше стрелки «проглатывались» без preventDefault — фокус
     уходил с поля ввода, ввод ломался. Теперь в терминале обрабатываются
     keyCode цифр напрямую, а любая необработанная клавиша гасится. */
  function handleT9Key(event, key) {
    if (!terminalIsOpen()) return false;
    var num = null;
    if (key >= '0' && key <= '9' && key.length === 1) num = Number(key);
    else if (/^Digit[0-9]$/.test(key || '')) num = Number(key.charAt(5));
    else if (/^Numpad[0-9]$/.test(key || '')) num = Number(key.charAt(6));
    if (num === null && typeof event.keyCode === 'number') {
      var kcd = event.keyCode;
      if (kcd >= 48 && kcd <= 57) num = kcd - 48;               // верхний ряд цифр
      else if (kcd >= 96 && kcd <= 105) num = kcd - 96;         // Numpad
    }
    if (num !== null) {
      t9PressGroup(num);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      t9Backspace();
      return true;
    }
    if (key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      t9Submit();
      return true;
    }
    if (key === '#') {
      event.preventDefault();
      event.stopPropagation();
      /* ВАЖНО (исправление v0.2.54): раньше здесь читался t9CommittedText()
         ДО подтверждения pending-символа — строкаHistory перезаписывалась без
       последней буквы, и следующая нажатая клавиша «возвращала» её ([f] -> f).
       Сначала принудительный commit, потом чтение. */
      t9ForceCommit();
      t9Upper = !t9Upper;
      t9Render();
      return true;
    }
    if (key === 'Call') {
      event.preventDefault();
      event.stopPropagation();
      t9ForceCommit();
      t9Control = !t9Control;
      t9Render();
      return true;
    }
    if (key === 'SoftLeft') {
      event.preventDefault();
      event.stopPropagation();
      /* как в оригинале: сначала send() pending-группы, затем печать пробела
         (в Terminal от Affe Null SoftLeft = Tab '\t'; у нас пробел нужнее) */
      t9ForceCommit();
      t9SendRaw(' ');
      t9Render();
      return true;
    }
    return false; // стрелки и прочее — обычная обработка (история команд)
  }

  function terminalHistoryMove(direction) {
    if (!terminalCommands.length) return;
    if (terminalHistoryIndex === terminalCommands.length && direction === 'ArrowUp') {
      terminalHistoryDraft = terminalLine;
    }
    var result = window.KaLoader.navigateCommandHistory(terminalCommands, terminalHistoryIndex, direction);
    terminalHistoryIndex = result.index;
    var command = terminalHistoryIndex === terminalCommands.length ? terminalHistoryDraft : result.command;
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    /* v0.2.58: стираем из сетки всю текущую набранную строку (pending уже
       напечатан в неё), затем перепечатываем выбранную команду истории —
       ровно так, как сервер telnet прислал бы новую строку */
    for (var bi = 0; bi < terminalLine.length; bi++) termPrint('\b');
    if (t9Key >= 0 && t9PendingSent) termPrint('\b');
    t9Key = -1;
    t9Index = 0;
    t9PendingSent = false;
    terminalLine = '';
    termPrint(command || '');
    terminalLine = command || '';
    t9Render();
  }

  /* (v0.2.53) Старый termPrint удалён — единый рендер вывода выше
     (putChar-сетка + terminalHistory). */

  function runTerminalCommand(command, echoAlreadyPrinted) {
    var source = String(command || '').trim();
    /* История команд: раньше push делался только здесь и без дедупа —
       добавляем и последнюю набранную команду из submitTerminalLine. */
    if (source.trim() &&
        terminalCommands[terminalCommands.length - 1] !== source.trim()) {
      terminalCommands.push(source.trim());
    }
    terminalHistoryIndex = terminalCommands.length;
    terminalHistoryDraft = '';
    if (!source) return;
    /* Эхо "> команда" печатает submitTerminalLine (v0.2.53); здесь — только
       если команда вызвана программно (без флага), чтобы не печатать дважды. */
    if (!echoAlreadyPrinted) termPrint('> ' + source + '\n');
    var firstSpace = source.indexOf(' ');
    var name = (firstSpace < 0 ? source : source.slice(0, firstSpace)).toUpperCase();
    var argument = firstSpace < 0 ? '' : source.slice(firstSpace + 1).trim();

    /* Поддержка T9-ошибок Nokia: пробелы внутри слова недопустимы в командах —
       если после имени команды идёт «слипшаяся» строка без пробела (например
       "R UN HELLO" или "RUNHELLO"), пробуем распознать команду по префиксу. */
    if (!['HELP', 'FILES', 'RUN', 'SEND', 'CLS', 'EXIT'].includes(name)) {
      var knownCommands = ['HELP', 'FILES', 'RUN', 'SEND', 'CLS', 'EXIT'];
      for (var ci = 0; ci < knownCommands.length; ci++) {
        var kc = knownCommands[ci];
        if (name.length > kc.length && name.indexOf(kc) === 0) {
          argument = name.slice(kc.length) + (argument ? ' ' + argument : '');
          name = kc;
          break;
        }
      }
    }

    if (name === 'HELP') {
      termPrint('HELP  FILES  RUN <file>  SEND <text>  CLS  EXIT\n');
    } else if (name === 'CLS') {
      terminalHistory = '';
      consoleText = '';
      renderTerminal();
    } else if (name === 'EXIT') {
      closeTerminal();
      return;
    } else if (name === 'SEND') {
      if (!argument) {
        termPrint('Usage: SEND <text>\n');
      } else {
        var nonAscii = false;
        for (var i = 0; i < argument.length; i++) {
          var code = argument.charCodeAt(i);
          if (code > 127) {
            nonAscii = true;
            break;
          }
          window.KaDOS.pressKey(code);
        }
        if (nonAscii) termPrint('DOS input accepts ASCII text only.\n');
        else {
          window.KaDOS.pressKey(13);
          /* подтверждение для пользователя: что именно отправлено в DOS-программу */
          termPrint('Sent to ' + (programName || 'DOS') + ': "' + argument + '"\n');
        }
      }
    } else if (name === 'FILES' || name === 'RUN') {
      /* встроенные демо (HELLO/ECHO/COUNT) ищем сразу — без SD-сканирования;
         на Nokia 800 Tough Device Storage API может быть недоступен,
         а демо зашиты в KaLoader.DEMOS */
      var demoMatch = window.KaLoader && window.KaLoader.DEMOS
        ? window.KaLoader.DEMOS.filter(function (d) {
            var dn = String(d.name).toUpperCase();
            return argument && (dn === argument.toUpperCase() || dn === argument.toUpperCase() + '.COM');
          })[0] : null;
      if (name === 'RUN' && demoMatch) {
        termPrint('Starting ' + demoMatch.name + '\n');
        loadProgram(demoMatch.bytes, demoMatch.name);
        return;
      }
      /* RUN без SD-хранилища: fallback на встроенные демо даже при ошибке API */
      function runFromDemos() {
        var demos = (window.KaLoader && window.KaLoader.DEMOS) || [];
        var found = demos.filter(function (d) {
          var dn = String(d.name).toUpperCase();
          return argument && (dn === argument.toUpperCase() || dn === argument.toUpperCase() + '.COM');
        })[0];
        if (found) {
          termPrint('Starting ' + found.name + ' (built-in)\n');
          loadProgram(found.bytes, found.name);
        } else {
          termPrint('Program not found: ' + argument + '\n');
          termPrint('Built-in: ' + demos.map(function (d) { return d.name; }).join(', ') + '\n');
        }
      }
      if (!window.navigator || (typeof window.navigator.getDeviceStorages !== 'function' &&
          typeof window.navigator.getDeviceStorage !== 'function')) {
        if (name === 'FILES') {
          terminalHistory += ((window.KaLoader && window.KaLoader.DEMOS) || [])
            .map(function (d) { return d.name + ' (built-in)'; }).join('\n') + '\n';
          renderTerminal();
        } else {
          runFromDemos();
        }
        return;
      }
      window.KaLoader.listSdFiles().then(function (items) {
        var programs = items.filter(function (item) { return /\.(com|bin)$/i.test(item.name || item.path || ''); });
        if (name === 'FILES') {
          terminalHistory += programs.length
            ? programs.map(function (item) { return item.name; }).join('\n') + '\n'
            : 'No COM/BIN files found.\n';
          renderTerminal();
          return;
        }
        if (!argument) {
          termPrint('Usage: RUN <file.com>\n');
          return;
        }
        var requested = argument.toLowerCase();
        var match = programs.filter(function (item) {
          return String(item.name || '').toLowerCase() === requested ||
            String(item.name || '').toLowerCase() === requested + '.com';
        })[0];
        if (!match) {
          termPrint('Program not found: ' + argument + '\n');
          return;
        }
        try {
          window.KaLoader.validateProgramFile(match.file);
        } catch (error) {
          termPrint((error.message || String(error)) + '\n');
          return;
        }
        window.KaLoader.readFile(match.file).then(function (bytes) {
          setCurrentFile(match, match.name);
          termPrint('Starting ' + match.name + '\n');
          loadProgram(bytes, match.name);
        }, function (error) {
          termPrint('Could not read program: ' + (error.message || error) + '\n');
        });
      }, function (error) {
        termPrint('Storage error: ' + (error.message || error) + '\n');
      });
    } else {
      termPrint('Unknown command: ' + name + '\n');
    }
  }

  function handleTerminalKey(event, key) {
    if (!terminalIsOpen()) return false;
    /* Fallback на keyCode (как в оригинале app.js): если normalizeKey вернул
       служебное имя вместо символа, восстанавливаем символ из keyCode. */
    if ((!key || key.length > 1) && typeof event.keyCode === 'number') {
      var kc = event.keyCode;
      if (kc >= 48 && kc <= 57) key = String(kc - 48);            // цифры
      else if (kc >= 96 && kc <= 105) key = String(kc - 96);      // Numpad-цифры
      else if (kc >= 65 && kc <= 90) key = String.fromCharCode(kc + 32); // буквы -> нижний регистр
      else if (kc === 13 || kc === 23) key = 'Enter';
      else if (kc === 8) key = 'Backspace';
      else if (kc === 27 || kc === 17 || kc === 461 || kc === 10009) key = 'Back'; // Esc/GoBack на KaiOS
    }
    /* Пробел: e.key=' ' или legacy-алиас 'Enter' от Space — печатаем пробел.
       В терминале Enter это ввод команды, поэтому алиас проверяем по keyCode. */
    if (key === ' ' || (key === 'Enter' && (event.keyCode === 32 || event.code === 'Space'))) {
      if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
      t9Key = -1; t9Index = 0; t9PendingSent = false;
      t9SendRaw(' ');                    // единственный рендер ввода (v0.2.58)
      t9Render();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    /* Буквы с аппаратной клавиатуры KaiOS (e.key = 'h' и т.п.) — пишем в буфер */
    if (key && key.length === 1 && /[a-zа-яё]/i.test(key)) {
      var ch = t9Upper ? key.toUpperCase() : key.toLowerCase();
      if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
      t9Key = -1; t9Index = 0; t9PendingSent = false;
      t9SendRaw(ch);                     // единственный рендер ввода (v0.2.58)
      t9Render();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    /* T9 multi-tap: цифры, Backspace, Enter, #, Call, SoftLeft */
    if (handleT9Key(event, key)) return true;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      terminalHistoryMove(key);
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      /* в терминале боковые стрелки не двигают каретку (буфер однострочный,
         каретка всегда в конце) — гасим, чтобы не сбивать фокус */
    } else if (key === 'Back' || key === 'Escape' || key === 'SoftRight') {
      closeTerminal();
    } else {
      /* Любая остальная клавиша в режиме терминала не должна уходить
         навигации по кнопкам (иначе фокус «теряется» и ввод невозможен). */
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function formatSaveError(prefix, error) {
    var details = [];
    if (error && error.name) details.push(error.name);
    if (error && error.message && error.message !== error.name) details.push(error.message);
    if (!details.length && error) details.push(String(error));
    return prefix + (details.length ? ': ' + details.join(' - ') : '.');
  }

  function showSaveToast(message) {
    var toast = document.getElementById('save-status-panel');
    var label = document.getElementById('save-status-message');
    var button = document.getElementById('save-status-ok');
    if (label) label.textContent = message || 'Файл был сохранен';
    if (toast) {
      toast.classList.remove('hidden');
      showPanel(toast);
    }
    if (button) {
      setTimeout(function () {
        if (button) button.focus();
      }, 0);
    }
  }

  function closeSaveToast() {
    var toast = document.getElementById('save-status-panel');
    if (toast) toast.classList.add('hidden');
    closePanels();
    editButton && editButton.focus();
  }

  function openEditorPanel(text) {
    showPanel(editorPanel);
    if (typeof text === 'string') editorText.value = text;
    if (editorFilename) editorFilename.textContent = currentFile ? currentFile.name : 'Новая заметка.txt';
    if (editorText) editorText.focus();
  }

  function closeEditorPanel() {
    closePanels();
    editButton && editButton.focus();
  }

  function saveCurrentEditor() {
    if (!editorText) return;
    if (currentFile && /\.(com|bin)$/i.test(currentFile.name)) {
      loadError = 'Нельзя сохранять текст поверх бинарного файла.';
      return;
    }
    var targetStorage = currentFile && currentFile.storage ? currentFile.storage : window.KaLoader.preferredStorage();
    var targetPath = currentFile && currentFile.path ? currentFile.path : 'KaDOS/notes.txt';
    if (targetStorage && currentFile && currentFile.storage) {
      window.KaLoader.saveTextFile(targetStorage, targetPath, editorText.value, true).then(function () {
        window.KaLoader.saveNote(editorText.value, []).catch(function () {});
        showStatus('Файл был сохранен');
        showSaveToast('Файл был сохранен');
      }, function (error) {
        var message = formatSaveError('Не удалось сохранить файл', error);
        showStatus(message);
        showSaveToast(message);
      });
      return;
    }
    if (currentFile && !currentFile.storage) {
      beginSaveAs(false);
      return;
    }
    window.KaLoader.saveNote(editorText.value, targetStorage ? [targetStorage] : []).then(function (result) {
      if (result.storageSaved) {
        var name = result.path.split('/').pop();
        setCurrentFile({
          name: name,
          path: result.path,
          storageName: result.storageName,
          storage: targetStorage,
          file: { name: result.path, size: editorText.value.length }
        }, name);
        showStatus('Файл был сохранен');
        showSaveToast('Файл был сохранен');
      } else {
        var saveFailure = result.error
          ? 'Не удалось сохранить файл: ' + (result.error.message || result.error)
          : 'Хранилище недоступно. Черновик сохранен только в приложении; файл не создан.';
        showStatus(saveFailure);
        showSaveToast(saveFailure);
      }
    }, function (error) {
      var message = formatSaveError('Не удалось сохранить заметку', error);
      showStatus(message);
      showSaveToast(message);
    });
  }

  function beginSaveAs(createNewFile) {
    var nameInput = document.getElementById('saveas-name');
    var baseName = createNewFile ? 'note' : (currentFile && currentFile.name ? currentFile.name.replace(/\.[^.]*$/, '') : 'note');
    var confirmButton = document.getElementById('saveas-confirm');
    saveAsReturnButtonId = createNewFile ? 'create-file' : 'save-as-file';
    var formatButtons = document.querySelectorAll('#save-formats [data-format]');
    Array.prototype.forEach.call(formatButtons, function (button) {
      button.classList.toggle('selected', button.dataset.format === saveFormat);
    });
    if (nameInput) nameInput.value = baseName || 'note';
    if (confirmButton) confirmButton.textContent = createNewFile ? 'Создать файл' : 'Сохранить как';
    showPanel(document.getElementById('save-as-panel'));
    if (nameInput) nameInput.focus();
  }

  function saveAsEditorText() {
    var nameInput = document.getElementById('saveas-name');
    var baseName = String(nameInput && nameInput.value || '').trim().replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '-');
    if (!baseName) {
      showStatus('Введите имя файла.');
      if (nameInput) nameInput.focus();
      return;
    }
    var storage = currentFile && currentFile.storage || window.KaLoader.preferredStorage();
    if (!storage) {
      var storageError = 'Нет доступного хранилища для сохранения.';
      showStatus(storageError);
      showSaveToast(storageError);
      return;
    }
    var currentPath = currentFile && currentFile.path ? currentFile.path : '';
    var relativePath = window.KaLoader.resolveSaveTargetPath
      ? window.KaLoader.resolveSaveTargetPath(currentPath, baseName + saveFormat)
      : (baseName + saveFormat);
    var sameCurrentPath = !!(currentFile && currentFile.storage === storage && currentFile.path &&
      window.KaLoader.resolveSaveTargetPath(currentFile.path, currentFile.name) === relativePath);
    var path = sameCurrentPath ? currentFile.path : relativePath;
    window.KaLoader.saveTextFile(storage, path, editorText.value, sameCurrentPath).then(function (saved) {
      setCurrentFile({
        name: baseName + saveFormat,
        path: saved.path,
        storageName: saved.storageName,
        storage: storage,
        file: { name: saved.path, size: editorText.value.length }
      }, baseName + saveFormat);
      window.KaLoader.saveNote(editorText.value, []).catch(function () {});
      showStatus('Файл был сохранен');
      showSaveToast('Файл был сохранен');
    }, function (error) {
      var message = formatSaveError('Не удалось сохранить файл как новый', error);
      showStatus(message);
      showSaveToast(message);
    });
  }

  function confirmDeleteCurrentFile() {
    if (!currentFile) {
      window.KaLoader.deleteSavedNote();
      editorText.value = '';
      loadError = 'Заметка удалена из памяти приложения.';
      setCurrentFile(null, 'Без имени');
      closePanels();
      fileButton && fileButton.focus();
      return;
    }
    if (!currentFile || !currentFile.storage) {
      loadError = 'Выбранный локальный файл нельзя удалить через KaiOS Device Storage.';
      closePanels();
      actionsButton && actionsButton.focus();
      return;
    }
    window.KaLoader.deleteFile(currentFile).then(function () {
      loadError = 'Файл удалён: ' + currentFile.path;
      setCurrentFile(null, 'Без имени');
      editorText.value = '';
      closePanels();
      fileButton && fileButton.focus();
    }, function (error) {
      loadError = 'Не удалось удалить файл: ' + (error.message || error);
      closePanels();
      actionsButton && actionsButton.focus();
    });
  }

  function beginDeleteCurrentFile() {
    var message = document.getElementById('delete-message');
    var confirmButton = document.getElementById('delete-confirm');
    if (message) {
      message.textContent = currentFile
        ? 'Удалить файл «' + (currentFile.name || currentFile.path) + '»?'
        : 'Удалить сохраненную заметку из памяти приложения?';
    }
    showPanel(document.getElementById('delete-panel'));
    if (confirmButton) confirmButton.focus();
  }

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
    /* getConsole() в kados.js ВОЗВРАЩАЕТ И ОЧИЩАЕТ буфер — данные нужно
       брать ровно один раз за кадр. (Раньше здесь вызывалось getConsole()
       дважды: второй вызов возвращал пустую строку, и вывод эмулятора
       терялся целиком — «терминал ничего не выводит».) */
    var s = KaDOS.getConsole();
    if (s) {
      consoleText += s; mode = 'text';
      /* Инкрементальный вывод через putChar-порт (как sock.ondata -> putStr
         в оригинале Terminal от Affe Null): без полного redraw каждый кадр,
        символы появляются сразу. Дельта также попадает в terminalHistory,
        чтобы после CLS/полного redraw вывод программы не терялся. */
      termPrintEmuDelta(s);
    }
    if (KaDOS.vgaDirtyConsume()) mode = 'vga';
    if (mode === 'vga') drawVga(); else drawText();
    if (loadError) {
      hud.textContent = loadError;
    } else if (dpadDebugMessage) {
      hud.textContent = dpadDebugMessage;
    } else if (!out.running) {
      hud.textContent = (programName ? programName + ' | ' : '') + 'HALT: ' + out.halted + ' (шагов: ' + out.steps + ')';
    } else {
      hud.textContent = programName + ' | running | IP=' + KaDOS.regs.ip.toString(16);
    }
    setTimeout(loop, 16);
  }

  function normalizeKey(e) {
    if (!e) return null;
    if (window.KaLoader && typeof window.KaLoader.normalizeDeviceKey === 'function') {
      return window.KaLoader.normalizeDeviceKey(e);
    }
    return e.key || null;
  }

  function visiblePanel() {
    var panels = document.querySelectorAll('.panel:not(.hidden)');
    if (panels.length) return panels[panels.length - 1];
    return document.querySelector('.app-shell');
  }

  function fileListDirectionalKey(key) {
    var panel = visiblePanel();
    if (!panel || !panel.classList || !panel.classList.contains('panel')) return key;
    if (panel.id === 'save-as-panel') return window.KaLoader.normalizeInputDirection(key);
    if (window.KaLoader && typeof window.KaLoader.normalizeMenuDirection === 'function') {
      return window.KaLoader.normalizeMenuDirection(key);
    }
    return key;
  }

  function focusableItems() {
    var root = visiblePanel();
    if (!root) return [];
    var nodes = root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
    return Array.prototype.filter.call(nodes, function (node) {
      return node !== canvas && !node.hidden && node.getClientRects().length > 0;
    });
  }

  function moveFocus(direction) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(direction) < 0) return;
    var items = focusableItems();
    if (!items.length) return;
    var current = document.activeElement;
    var currentIndex = items.indexOf(current);
    if (currentIndex < 0) {
      items[0].focus();
      return;
    }

    var from = current.getBoundingClientRect();
    var fromX = from.left + from.width / 2;
    var fromY = from.top + from.height / 2;
    var vertical = direction === 'ArrowUp' || direction === 'ArrowDown';
    var best = null;
    var bestScore = Infinity;
    items.forEach(function (item) {
      if (item === current) return;
      var rect = item.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var primary = vertical
        ? (direction === 'ArrowDown' ? y - fromY : fromY - y)
        : (direction === 'ArrowRight' ? x - fromX : fromX - x);
      if (primary <= 0) return;
      var secondary = vertical ? Math.abs(x - fromX) : Math.abs(y - fromY);
      var score = primary + secondary * 2;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    });
    if (best) {
      best.focus();
      return;
    }

    var step = (direction === 'ArrowUp' || direction === 'ArrowLeft') ? -1 : 1;
    items[(currentIndex + step + items.length) % items.length].focus();
  }

  function moveSaveAsFocus(direction) {
    if (direction !== 'ArrowUp' && direction !== 'ArrowDown') return false;
    var panel = document.getElementById('save-as-panel');
    if (!panel || panel.classList.contains('hidden')) return false;
    var items = Array.prototype.slice.call(panel.querySelectorAll('#saveas-name, #save-formats [data-format], #saveas-confirm'));
    var currentIndex = items.indexOf(document.activeElement);
    if (currentIndex < 0) return false;
    var offset = direction === 'ArrowDown' ? 1 : -1;
    var nextIndex = currentIndex + offset;
    if (nextIndex >= 0 && nextIndex < items.length) items[nextIndex].focus();
    return true;
  }

  // Keep menu movement, text caret movement, and emulator controls separate.
  function closeToPreviousAction() {
    var panel = visiblePanel();
    if (panel && panel.classList.contains('panel')) {
      if (panel.id === 'save-status-panel') {
        closeSaveToast();
        return true;
      }
      if (panel.id === 'save-as-panel') {
        var saveAsActionsPanel = document.getElementById('actions-panel');
        showPanel(saveAsActionsPanel);
        var saveAsButton = document.getElementById(saveAsReturnButtonId);
        if (saveAsButton) saveAsButton.focus();
        return true;
      }
      closePanels();
      if (panel === filePanel) {
        editButton && editButton.focus();
      } else if (panel.id === 'actions-panel') {
        actionsButton && actionsButton.focus();
      } else if (panel === editorPanel) {
        var actionsPanel = document.getElementById('actions-panel');
        showPanel(actionsPanel);
        var saveFileButton = document.getElementById('save-file');
        if (saveFileButton) saveFileButton.focus();
      } else {
        editButton && editButton.focus();
      }
      return true;
    }
    if (document.activeElement === editorText) {
      var actionsPanel = document.getElementById('actions-panel');
      showPanel(actionsPanel);
      var saveFileButton = document.getElementById('save-file');
      if (saveFileButton) saveFileButton.focus();
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', function (e) {
    var key = normalizeKey(e);
    if (handleTerminalKey(e, key)) return;
    if (terminalIsOpen()) return; // в терминале всё перехватывает T9/история
    var active = document.activeElement;
    var isTextField = active && /^(INPUT|TEXTAREA)$/.test(active.tagName);
    var mappedKey = fileListDirectionalKey(key);

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(key) !== -1) {
      var beforeStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
      var beforeEnd = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
      if (active === editorText || (active && active.id === 'saveas-name' && (key === 'ArrowLeft' || key === 'ArrowRight'))) {
        window.KaLoader.moveTextCaret(active, window.KaLoader.normalizeInputDirection(key), e.shiftKey);
        showDpadDebug(e, key, window.KaLoader.normalizeInputDirection(key), active, beforeStart, beforeEnd);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (active === canvas && window.KaDOS) {
        var scanCodes = { ArrowUp: 0x4800, ArrowDown: 0x5000, ArrowLeft: 0x4D00, ArrowRight: 0x4B00 };
        KaDOS.pressKey(scanCodes[key]);
        e.preventDefault();
        return;
      }
      if (moveSaveAsFocus(mappedKey)) {
        showDpadDebug(e, key, mappedKey, active, beforeStart, beforeEnd);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      moveFocus(mappedKey);
      showDpadDebug(e, key, mappedKey, active, beforeStart, beforeEnd);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && isTextField) {
      return;
    }

    if (key === 'Enter' && active && active.id === 'save-status-ok') {
      closeSaveToast();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (key === 'Escape' || key === 'Back' || key === 'SoftRight') {
      if (closeToPreviousAction()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (key === 'Backspace' && !isTextField) {
      var visible = visiblePanel();
      if (visible && visible.classList.contains('panel')) {
        if (visible.id === 'save-as-panel') {
          var saveAsActionsPanel = document.getElementById('actions-panel');
          showPanel(saveAsActionsPanel);
          document.getElementById(saveAsReturnButtonId).focus();
        } else if (visible === editorPanel) {
          var actionsPanel = document.getElementById('actions-panel');
          showPanel(actionsPanel);
          var saveFileButton = document.getElementById('save-file');
          if (saveFileButton) saveFileButton.focus();
        } else {
          closePanels();
          (visible === filePanel ? fileButton : actionsButton).focus();
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    if (key === 'Enter' && filePanel && !filePanel.classList.contains('hidden') && active && active.parentNode === fileList) {
      chooseSelectedFile();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (key === 'Enter' && active && active.id === 'saveas-name') {
      saveAsEditorText();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (key === 'Enter' && active !== canvas && !isTextField && active && typeof active.click === 'function') {
      active.click();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (key === 'Enter' && active === canvas && window.KaDOS) {
      KaDOS.pressKey(13);
      e.preventDefault();
      return;
    }
    if (active === canvas && window.KaDOS && key && key.length === 1) {
      KaDOS.pressKey(key.toUpperCase().charCodeAt(0));
      e.preventDefault();
    }
    if (key === 'Backspace' && active === canvas && window.KaDOS) {
      KaDOS.pressKey(8);
      e.preventDefault();
    }
  }, true);

  function loadProgram(bytes, name) {
    try {
      KaDOS.loadCom(bytes);
      consoleText = '';
      lastEmuConsoleLength = 0;
      mode = 'text';
      programName = name;
      loadError = '';
      /* экран эмулятора теперь показывает программу — терминал-оверлей
         мешал бы («перекрывает всё собой»), скрываем его автоматически */
      var tp = document.getElementById('terminal-panel');
      if (tp && !tp.classList.contains('hidden')) closeTerminal();
    } catch (e) {
      loadError = e.message;
    }
  }

  function renderFilePanel() {
    if (!fileList) return;
    fileList.innerHTML = '';
    fileItems.forEach(function (item, index) {
      var li = document.createElement('li');
      li.textContent = (item.storageName ? item.storageName + ': ' : '') + (item.path || item.name);
      li.tabIndex = 0;
      if (index === fileSelected) li.className = 'selected';
      li.addEventListener('focus', function () {
        fileSelected = index;
        Array.prototype.forEach.call(fileList.children, function (entry, entryIndex) {
          entry.classList.toggle('selected', entryIndex === index);
        });
      });
      li.addEventListener('click', function () {
        fileSelected = index;
        li.focus();
      });
      fileList.appendChild(li);
    });
    if (!fileItems.length) {
      var empty = document.createElement('li');
      empty.textContent = 'Файлы не найдены';
      fileList.appendChild(empty);
    }
  }

  function closeFilePanel() {
    if (filePanel) filePanel.classList.add('hidden');
  }

  function openFilePanel(mode) {
    fileFilterMode = mode || 'all';
    if (!window.KaLoader || !window.KaLoader.listSdFiles) {
      return;
    }
    window.KaLoader.listSdFiles().then(function (items) {
      var sourceItems = fileFilterMode === 'text' && window.KaLoader.filterTextFiles
        ? window.KaLoader.filterTextFiles(items)
        : fileFilterMode === 'supported' && window.KaLoader.filterSupportedFiles
          ? window.KaLoader.filterSupportedFiles(items)
          : items;
      fileItems = sourceItems || [];
      fileSelected = fileItems.length ? 0 : -1;
      renderFilePanel();
      if (filePanel) filePanel.classList.remove('hidden');
      if (fileItems.length && fileList.firstElementChild) {
        fileList.firstElementChild.focus();
      } else if (!fileItems.length) {
        var storages = window.KaLoader.getSdStorages();
        var names = storages.map(function (storage) { return storage.storageName || 'sdcard'; });
        loadError = fileFilterMode === 'text'
          ? 'На карте нет текстовых файлов (.txt, .cfg, .ini и др.).'
          : fileFilterMode === 'supported'
            ? 'Не найдены поддерживаемые файлы (.COM, .BIN или текстовые форматы).'
          : (names.length
            ? 'На накопителях ' + names.join(', ') + ' файлов нет.'
            : 'KaiOS не вернул SD-хранилища. Проверьте карту и разрешение device-storage:sdcard.');
      }
    }, function (error) {
      loadError = 'Не удалось прочитать SD-карту: ' + (error.message || error);
    });
  }

  function openCurrentFileItem(item) {
    if (!item) return;
    var displayName = item.name || (item.path || '').split('/').pop();
    var readTextPromise = null;
    if (item.file && typeof item.file.text === 'function') {
      readTextPromise = window.KaLoader.readTextFile(item.file);
    } else if (item.storage && item.path && typeof item.storage.get === 'function') {
      readTextPromise = window.KaLoader.readStorageTextFile(item.storage, item.path);
    } else if (item.file && item.file instanceof Blob) {
      readTextPromise = window.KaLoader.readTextFile(item.file);
    }

    if (readTextPromise) {
      readTextPromise.then(function (text) {
        setCurrentFile(item, displayName);
        editorText.value = text;
        showPanel(editorPanel);
        editorFilename.textContent = displayName;
        editorText.focus();
      }, function (error) {
        loadError = 'Не удалось прочитать текстовый файл: ' + (error.message || error);
      });
      return;
    }

    if (item.file && /\.(com|bin)$/i.test(item.name || item.path || '')) {
      try {
        window.KaLoader.validateProgramFile(item.file);
      } catch (e) {
        loadError = e.message;
        return;
      }
      window.KaLoader.readFile(item.file).then(function (bytes) {
        setCurrentFile(item, displayName);
        loadProgram(bytes, displayName);
        closePanels();
      }, function () {
        loadError = 'Не удалось прочитать файл.';
        closePanels();
      });
      return;
    }
    loadError = 'Файл нельзя открыть в редакторе.';
  }

  function chooseSelectedFile() {
    if (!fileItems.length || fileSelected < 0) {
      loadError = 'Файл не выбран.';
      return;
    }
    openCurrentFileItem(fileItems[fileSelected]);
  }

  function initializeControls() {
    var fileInput = document.getElementById('file-input');
    fileButton = null;
    editButton = document.getElementById('edit-text');
    actionsButton = document.getElementById('open-actions');
    var terminalButton = document.getElementById('open-terminal');
    var editorClose = document.getElementById('editor-close');
    var actionsPanel = document.getElementById('actions-panel');
    var saveAsPanel = document.getElementById('save-as-panel');
    var deletePanel = document.getElementById('delete-panel');
    var saveAsName = document.getElementById('saveas-name');
    var formatButtons = Array.prototype.slice.call(document.querySelectorAll('[data-format]'));

    function bindPointerAction(el, fn) {
      if (!el) return;
      el.addEventListener('click', function (event) {
        event.preventDefault();
        fn(event);
      });
    }

    bindPointerAction(editButton, function () {
      if (window.navigator && (typeof navigator.getDeviceStorages === 'function' || typeof navigator.getDeviceStorage === 'function')) {
        openFilePanel('supported');
      } else {
        fileInput.setAttribute('accept', '.com,.bin,.txt,.conf,.cfg,.bat,.ini,.asm,.nfo,text/plain,application/octet-stream');
        fileInput.click();
      }
    });

    bindPointerAction(fileButton, function () {
      if (window.navigator && (typeof navigator.getDeviceStorages === 'function' || typeof navigator.getDeviceStorage === 'function')) {
        openFilePanel('all');
      } else {
        fileInput.setAttribute('accept', '.com,.bin,.txt,.conf,.cfg,.bat,.ini,.asm,.nfo,text/plain,application/octet-stream');
        fileInput.click();
      }
    });

    bindPointerAction(document.getElementById('editor-save'), function () {
      saveCurrentEditor();
    });

    bindPointerAction(editorClose, function () {
      closePanels();
      editButton && editButton.focus();
    });

    function openActions() {
      showPanel(actionsPanel);
      var saveFileButton = document.getElementById('save-file');
      if (saveFileButton) saveFileButton.focus();
    }

    bindPointerAction(actionsButton, openActions);
    bindPointerAction(document.getElementById('editor-actions-open'), openActions);

    bindPointerAction(terminalButton, function () {
      showPanel(document.getElementById('terminal-panel'));
      document.body.classList.add('terminal-mode');
      var appShell = document.querySelector('.app-shell');
      if (appShell) appShell.classList.add('terminal-mode');
      updateTerminalViewport();
      setTerminalOrientation(true);
      renderTerminal();
      t9Render();
      setTimeout(function () {
        /* фокус на скрытом поле: клавиши доходят до window.keydown, IME не мешает */
        if (terminalIsOpen() && terminalInput) {
          try { terminalInput.focus({ preventScroll: true }); } catch (err) { terminalInput.focus(); }
        }
      }, 0);
    });

    bindPointerAction(document.getElementById('terminal-close'), closeTerminal);

    if (terminalInput) {
      /* защита от авто-подстановок браузера: буфер T9 — единственный источник истины */
      terminalInput.addEventListener('input', function () {
        if (t9Key < 0 && terminalInput.value !== terminalLine) {
          terminalInput.value = terminalLine;
        }
      });
    }
    window.addEventListener('resize', updateTerminalViewport);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', updateTerminalViewport);
    var terminalForm = document.getElementById('terminal-form');
    if (terminalForm) {
      terminalForm.addEventListener('submit', function (event) {
        event.preventDefault();
        t9Submit();
      });
    }

    bindPointerAction(document.getElementById('save-file'), function () {
      saveCurrentEditor();
    });

    bindPointerAction(document.getElementById('create-file'), function () {
      beginSaveAs(true);
    });

    bindPointerAction(document.getElementById('save-as-file'), function () {
      beginSaveAs(false);
    });

    bindPointerAction(document.getElementById('delete-file'), beginDeleteCurrentFile);

    bindPointerAction(document.getElementById('open-file-menu'), function () {
      if (currentFile && currentFile.file) {
        openCurrentFileItem(currentFile);
        return;
      }
      openFilePanel('all');
    });

    bindPointerAction(document.getElementById('saveas-confirm'), function () {
      saveAsEditorText();
    });

    bindPointerAction(document.getElementById('save-status-ok'), function () {
      closeSaveToast();
    });

    bindPointerAction(document.getElementById('delete-confirm'), function () {
      confirmDeleteCurrentFile();
    });

    bindPointerAction(document.getElementById('delete-cancel'), function () {
      showPanel(actionsPanel);
      var fallbackButton = document.getElementById('save-file') || document.getElementById('create-file') || actionsButton;
      if (fallbackButton) fallbackButton.focus();
    });

    bindPointerAction(document.getElementById('editor-close'), function () {
      closeEditorPanel();
    });

    formatButtons.forEach(function (button) {
      bindPointerAction(button, function () {
        saveFormat = button.dataset.format;
        formatButtons.forEach(function (formatButton) {
          formatButton.classList.toggle('selected', formatButton === button);
        });
      });
    });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var item = { name: file.name, path: file.name, file: file, storage: null };
      setCurrentFile(item, file.name);
      if (/\.(txt|conf|cfg|bat|ini|asm|nfo)$/i.test(file.name)) {
        window.KaLoader.readTextFile(file).then(function (text) {
          editorText.value = text;
          openEditorPanel(text);
        }, function (error) {
          loadError = 'Не удалось прочитать текстовый файл: ' + (error.message || error);
        });
      } else {
        try {
          window.KaLoader.validateProgramFile(file);
          window.KaLoader.readFile(file).then(function (bytes) { loadProgram(bytes, file.name); }, function () {
            loadError = 'Не удалось прочитать файл.';
          });
        } catch (error) {
          loadError = error.message;
        }
      }
      fileInput.value = '';
    });

    if (window.navigator && typeof navigator.mozSetMessageHandler === 'function') {
      function handleIncomingFileRequest(request) {
        try {
          var activity = request || {};
          var candidate = activity.source && activity.source.files && activity.source.files[0];
          if (!candidate && activity.target && activity.target.files) {
            candidate = activity.target.files[0];
          }
          if (!candidate && activity.file) {
            candidate = activity.file;
          }
          if (!candidate && activity.data && activity.data.file) {
            candidate = activity.data.file;
          }
          if (!candidate) return;
          var item = { name: candidate.name, path: candidate.name, file: candidate, storage: null };
          setCurrentFile(item, candidate.name);
          if (window.KaLoader && window.KaLoader.isTextFileName && window.KaLoader.isTextFileName(candidate.name)) {
            window.KaLoader.readTextFile(candidate).then(function (text) {
              editorText.value = text;
              openEditorPanel(text);
            }, function (error) {
              loadError = 'Не удалось открыть файл: ' + (error.message || error);
            });
            return;
          }
          window.KaLoader.validateProgramFile(candidate);
          window.KaLoader.readFile(candidate).then(function (bytes) {
            loadProgram(bytes, candidate.name);
            closePanels();
          }, function () {
            loadError = 'Не удалось открыть файл.';
          });
        } catch (error) {
          loadError = error.message || String(error);
        }
      }

      navigator.mozSetMessageHandler('activity', handleIncomingFileRequest);
      navigator.mozSetMessageHandler('open', handleIncomingFileRequest);
      navigator.mozSetMessageHandler('pick', handleIncomingFileRequest);
      navigator.mozSetMessageHandler('share', handleIncomingFileRequest);
    }

    closePanels();
    editButton.focus();
    editorText.value = window.KaLoader.loadSavedNote();
    setCurrentFile(null, window.KaLoader.DEMOS[0].name);
    loadProgram(window.KaLoader.DEMOS[0].bytes, window.KaLoader.DEMOS[0].name);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initializeControls(); loop(); });
  } else { initializeControls(); loop(); }
})();
