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
  var terminalHistory = 'KaDOS local terminal\nType HELP for commands.\n';
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
    return t9BufferEl ? t9BufferEl.textContent.replace(/\|$/, '') : terminalLine;
  }

  function t9Render() {
    if (!t9BufferEl || !t9CaretEl) return;
    var text = t9CommittedText();
    var pending = '';
    if (t9Key >= 0) {
      var ch = t9Keys[t9Key][t9Index];
      pending = /[a-z]/.test(ch) && t9Upper ? ch.toUpperCase() : ch;
    }
    t9BufferEl.textContent = text + pending;
    t9BufferEl.appendChild(t9CaretEl);
    if (t9HintEl) {
      var mode = (t9Control ? 'Ctrl ' : '') + (t9Upper ? 'ABC' : 'abc');
      var options = t9Key >= 0 ? t9Keys[t9Key].join(' ') : '';
      t9HintEl.textContent = mode + (options ? ' | ' + options : '');
    }
    terminalLine = text + pending;
    if (terminalInput) terminalInput.value = terminalLine;
  }

  function t9Commit() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    if (t9Key < 0) return;
    var text = t9CommittedText();
    var ch = t9Keys[t9Key][t9Index];
    if (/[a-z]/.test(ch)) {
      if (t9Control) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40);
      else if (t9Upper) ch = ch.toUpperCase();
    }
    text += ch;
    if (t9BufferEl) t9BufferEl.textContent = text;
    t9Key = -1;
    t9Index = 0;
    t9Control = false;
    t9Render();
  }

  function t9PressGroup(groupIndex) {
    if (t9Key === groupIndex) {
      t9Index = (t9Index + 1) % t9Keys[groupIndex].length;
    } else {
      if (t9Key >= 0) t9Commit();
      t9Key = groupIndex;
      t9Index = 0;
    }
    t9Render();
    if (t9Timer) clearTimeout(t9Timer);
    t9Timer = setTimeout(function () { t9Commit(); }, 1000);
  }

  function t9Backspace() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    if (t9Key >= 0) { t9Key = -1; t9Index = 0; t9Render(); return; }
    var text = t9CommittedText();
    if (text.length) {
      if (t9BufferEl) t9BufferEl.textContent = text.slice(0, -1);
      t9Render();
    }
  }

  function t9Submit() {
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    t9Commit();
    var command = t9CommittedText();
    if (t9BufferEl) t9BufferEl.textContent = '';
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

  function renderTerminal() {
    var outputDisplay = document.getElementById('terminal-output');
    if (outputDisplay) {
      var output = (terminalHistory + consoleText).slice(-5000);
      if (outputDisplay.textContent !== output) {
        outputDisplay.textContent = output;
        outputDisplay.scrollTop = outputDisplay.scrollHeight;
      }
    }
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
    terminalLine = '';
    if (terminalInput) terminalInput.value = '';
    if (command.trim()) terminalCommands.push(command);
    terminalHistoryIndex = terminalCommands.length;
    terminalHistoryDraft = '';
    runTerminalCommand(command);
  }

  /* T9-обработчик: возвращает true, если событие перехвачено */
  function handleT9Key(event, key) {
    if (!terminalIsOpen()) return false;
    var digitMatch = /^(?:Digit|Numpad)?([0-9])$/.exec(key || '');
    var num = null;
    if (digitMatch) num = Number(digitMatch[1]);
    else if (key >= '0' && key <= '9') num = Number(key);
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
      if (t9Key >= 0) t9Commit();
      t9Upper = !t9Upper;
      t9Render();
      return true;
    }
    if (key === 'Call') {
      event.preventDefault();
      event.stopPropagation();
      if (t9Key >= 0) t9Commit();
      t9Control = !t9Control;
      t9Render();
      return true;
    }
    if (key === 'SoftLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (t9Key >= 0) t9Commit();
      if (t9BufferEl) t9BufferEl.textContent = t9CommittedText() + ' ';
      t9Render();
      return true;
    }
    return false; // стрелки и прочее — обычная обработка (история команд)
  }

  function terminalHistoryMove(direction) {
    if (!terminalCommands.length) return;
    if (terminalHistoryIndex === terminalCommands.length && direction === 'ArrowUp') {
      terminalHistoryDraft = terminalInput ? terminalInput.value : terminalLine;
    }
    var result = window.KaLoader.navigateCommandHistory(terminalCommands, terminalHistoryIndex, direction);
    terminalHistoryIndex = result.index;
    var command = terminalHistoryIndex === terminalCommands.length ? terminalHistoryDraft : result.command;
    /* показываем выбранную историю прямо в видимый T9-буфер */
    if (t9Timer) { clearTimeout(t9Timer); t9Timer = null; }
    t9Key = -1;
    t9Index = 0;
    if (t9BufferEl) t9BufferEl.textContent = command || '';
    t9Render();
    renderTerminal();
  }

  function runTerminalCommand(command) {
    var source = String(command || '').trim();
    if (!source) return;
    terminalHistory += '> ' + source + '\n';
    var firstSpace = source.indexOf(' ');
    var name = (firstSpace < 0 ? source : source.slice(0, firstSpace)).toUpperCase();
    var argument = firstSpace < 0 ? '' : source.slice(firstSpace + 1).trim();

    if (name === 'HELP') {
      terminalHistory += 'HELP  FILES  RUN <file>  SEND <text>  CLS  EXIT\n';
    } else if (name === 'CLS') {
      terminalHistory = '';
      consoleText = '';
    } else if (name === 'EXIT') {
      closeTerminal();
      return;
    } else if (name === 'SEND') {
      if (!argument) {
        terminalHistory += 'Usage: SEND <text>\n';
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
        if (nonAscii) terminalHistory += 'DOS input accepts ASCII text only.\n';
        else window.KaDOS.pressKey(13);
      }
    } else if (name === 'FILES' || name === 'RUN') {
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
          terminalHistory += 'Usage: RUN <file.com>\n';
          renderTerminal();
          return;
        }
        var requested = argument.toLowerCase();
        var match = programs.filter(function (item) {
          return String(item.name || '').toLowerCase() === requested ||
            String(item.name || '').toLowerCase() === requested + '.com';
        })[0];
        if (!match) {
          terminalHistory += 'Program not found: ' + argument + '\n';
          renderTerminal();
          return;
        }
        try {
          window.KaLoader.validateProgramFile(match.file);
        } catch (error) {
          terminalHistory += (error.message || String(error)) + '\n';
          renderTerminal();
          return;
        }
        window.KaLoader.readFile(match.file).then(function (bytes) {
          setCurrentFile(match, match.name);
          terminalHistory += 'Starting ' + match.name + '\n';
          loadProgram(bytes, match.name);
          renderTerminal();
        }, function (error) {
          terminalHistory += 'Could not read program: ' + (error.message || error) + '\n';
          renderTerminal();
        });
      }, function (error) {
        terminalHistory += 'Storage error: ' + (error.message || error) + '\n';
        renderTerminal();
      });
    } else {
      terminalHistory += 'Unknown command: ' + name + '\n';
    }
    renderTerminal();
  }

  function handleTerminalKey(event, key) {
    if (!terminalIsOpen()) return false;
    /* T9 multi-tap: цифры, Backspace, Enter, #, Call, SoftLeft */
    if (handleT9Key(event, key)) return true;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      terminalHistoryMove(key);
    } else if (key === 'Back' || key === 'Escape' || key === 'SoftRight') {
      closeTerminal();
    } else {
      return false;
    }
    renderTerminal();
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
    // Режим терминала: VM и консоль принадлежат KaDOSTerm — не мешаем.
    if (window.KaDOSTerm) { setTimeout(loop, 250); return; }
    var out = KaDOS.runSlice(BUDGET);
    var s = KaDOS.getConsole();
    if (s) { consoleText += s; mode = 'text'; }
    if (KaDOS.vgaDirtyConsume()) mode = 'vga';
    if (mode === 'vga') drawVga(); else drawText();
    if (terminalIsOpen()) renderTerminal();
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
      mode = 'text';
      programName = name;
      loadError = '';
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
