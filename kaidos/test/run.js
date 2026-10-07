/* Автотесты ядра KaDOS-JS (node test/run.js). */
'use strict';
global.window = global;
// в браузере скрипт грузится тегом <script>, там this === window;
// в node эмулируем это через indirect eval (non-strict глобальный scope)
var _geval = eval;
_geval(require('fs').readFileSync(require('path').join(__dirname, '../webapp/js/kados.js'), 'utf8'));
_geval(require('fs').readFileSync(require('path').join(__dirname, '../webapp/js/loader.js'), 'utf8'));
var K = window.KaDOS;   // модуль пишет на `this`, который в node здесь === global === window
var L = window.KaLoader;
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
    0xE8, 0x02, 0x00,   // call +2 -> метка на ret
    0x90,               // nop (после возврата)
    0xF4,               // hlt
    0xC3                // ret (цель call)
  ]));
  var out = K.runSlice(10000);
  ok('call/ret -> halt', out.halted === 'halt');
})();

// 7. Валидация пользовательских файлов
(function () {
  var valid = true;
  try { L.validateProgramFile({ name: 'game.COM', size: 100 }); } catch (e) { valid = false; }
  ok('file picker accepts COM', valid);

  var rejectsExe = false;
  try { L.validateProgramFile({ name: 'fallout.exe', size: 100 }); } catch (e) { rejectsExe = /EXE/.test(e.message); }
  ok('file picker rejects EXE with explanation', rejectsExe);

  var rejectsOversize = false;
  try { L.validateProgramFile({ name: 'large.bin', size: 0xFF01 }); } catch (e) { rejectsOversize = true; }
  ok('file picker rejects oversized COM image', rejectsOversize);
})();

// 8. KaiOS D-pad / keypad compatibility
(function () {
  var map = L.normalizeDeviceKey;
  ok('all dpad directions normalized', map('ArrowUp') === 'ArrowUp' && map('ArrowDown') === 'ArrowDown' && map('ArrowLeft') === 'ArrowLeft' && map('ArrowRight') === 'ArrowRight');
  ok('legacy dpad keycodes normalized', map({ keyCode: 38 }) === 'ArrowUp' && map({ keyCode: 40 }) === 'ArrowDown' && map({ keyCode: 37 }) === 'ArrowLeft' && map({ keyCode: 39 }) === 'ArrowRight');
  ok('menu dpad layout matches KaiOS orientation', L.normalizeMenuDirection('ArrowLeft') === 'ArrowRight' && L.normalizeMenuDirection('ArrowRight') === 'ArrowLeft' && L.normalizeMenuDirection('ArrowUp') === 'ArrowUp' && L.normalizeMenuDirection('ArrowDown') === 'ArrowDown');
  var olderCommand = L.navigateCommandHistory(['HELP', 'FILES'], 2, 'ArrowUp');
  var newerCommand = L.navigateCommandHistory(['HELP', 'FILES'], olderCommand.index, 'ArrowDown');
  ok('terminal command history navigates with up and down', olderCommand.command === 'FILES' && newerCommand.command === '');
  ok('input dpad directions invert all four axes', L.normalizeInputDirection('ArrowLeft') === 'ArrowRight' && L.normalizeInputDirection('ArrowRight') === 'ArrowLeft' && L.normalizeInputDirection('ArrowUp') === 'ArrowDown' && L.normalizeInputDirection('ArrowDown') === 'ArrowUp');
  var textInput = {
    value: 'abcd',
    selectionStart: 2,
    selectionEnd: 2,
    selectionDirection: 'none',
    setSelectionRange: function (start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    }
  };
  L.moveTextCaret(textInput, L.normalizeInputDirection('ArrowLeft'), false);
  ok('left dpad moves text caret right on device', textInput.selectionStart === 3 && textInput.selectionEnd === 3);
  L.moveTextCaret(textInput, L.normalizeInputDirection('ArrowRight'), false);
  ok('right dpad moves text caret left on device', textInput.selectionStart === 2 && textInput.selectionEnd === 2);
  var multilineInput = {
    value: 'abc\ndefg\nhi',
    selectionStart: 6,
    selectionEnd: 6,
    selectionDirection: 'none',
    setSelectionRange: textInput.setSelectionRange
  };
  L.moveTextCaret(multilineInput, L.normalizeInputDirection('ArrowUp'), false);
  ok('up dpad moves textarea caret down a line on device', multilineInput.selectionStart === 11);
  ok('save targets keep original folder when creating new files', L.resolveSaveTargetPath('/sdcard1/KaDOS/old.txt', 'new.txt') === 'KaDOS/new.txt' && L.resolveSaveTargetPath('/sdcard1/old.txt', 'new.txt') === 'new.txt');
  ok('save-as keeps the current file path when the name is unchanged', L.resolveSaveTargetPath('/sdcard1/KaDOS/current.txt', 'current.txt') === 'KaDOS/current.txt');
  ok('center key normalized', map('Enter') === 'Enter' && map('Numpad5') === 'Enter' && map('Spacebar') === 'Enter' && map('Center') === 'Enter' && map('Select') === 'Enter' && map({ keyCode: 23 }) === 'Enter' && map({ key: 'Unidentified', keyCode: 23 }) === 'Enter');
  ok('numeric characters preserved', ['2', '4', '5', '6', '8'].every(function (key) { return map(key) === key; }));
  ok('legacy text keycodes normalized', map({ keyCode: 50 }) === '2' && map({ keyCode: 65 }) === 'a');
  ok('back button aliases normalized', map('SoftRight') === 'SoftRight' && map('Back') === 'Back' && map('BrowserBack') === 'Back' && map('GoBack') === 'Back' && map({ keyCode: 4 }) === 'Back' && map({ keyCode: 10009 }) === 'Back');
  ok('text files recognized by extension filter', L.isTextFileName('notes.txt') && L.isTextFileName('config.conf') && !L.isTextFileName('HELLO.COM'));
  ok('text filter strips non-text files', L.filterTextFiles([{ name: 'HELLO.COM' }, { name: 'notes.txt' }, { name: 'config.conf' }, { name: 'game.bin' }]).map(function (item) { return item.name; }).join(',') === 'notes.txt,config.conf');
  ok('supported file filter includes DOS programs and text', L.filterSupportedFiles([{ name: 'HELLO.COM' }, { name: 'game.bin' }, { name: 'notes.txt' }, { name: 'game.exe' }]).map(function (item) { return item.name; }).join(',') === 'HELLO.COM,game.bin,notes.txt');
  var manifest = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../webapp/manifest.webapp'), 'utf8'));
  ok('manifest exposes open and share activities', !!manifest.activities && !!manifest.activities.open && !!manifest.activities.share);
  var styles = require('fs').readFileSync(require('path').join(__dirname, '../webapp/css/style.css'), 'utf8');
  ok('save-as panel hidden on startup', /#save-as-panel\.hidden\s*\{\s*display\s*:\s*none\s*;?\s*\}/.test(styles));
  var markup = require('fs').readFileSync(require('path').join(__dirname, '../webapp/index.html'), 'utf8');
  ok('terminal uses native input without an on-screen keypad', /<input id="terminal-input" type="text"/.test(markup) && !/id="terminal-keypad"/.test(markup));
  ok('terminal has visible T9 buffer and hint line', /id="t9-buffer"/.test(markup) && /id="t9-hint"/.test(markup));
  ok('terminal output is a fixed 20x13 grid window (Affe Null port, no scroll)', /#terminal-output\{position:absolute;top:28px/.test(styles) && /overflow:hidden/.test(styles) && !/overflow-y:scroll/.test(styles));
  ok('terminal fills the screen in portrait, compatible with KaiOS 2.5 Gecko', /#terminal-panel\{position:fixed;top:0;left:0;right:auto;bottom:auto;width:100%;height:100%/.test(styles) && !/\binset:/.test(styles));
})();

function fakeStorage(storageName, paths) {
  var storedFiles = Object.create(null);
  return {
    storageName: storageName,
    storedFiles: storedFiles,
    isRemovable: storageName !== 'sdcard',
    default: storageName === 'sdcard',
    enumerate: function () {
      var index = 0;
      var request = {
        result: paths.length ? { name: paths[0], size: 10 } : null,
        continue: function () {
          index++;
          request.result = paths[index] ? { name: paths[index], size: 10 } : null;
          setTimeout(function () { request.onsuccess(); }, 0);
        }
      };
      setTimeout(function () { request.onsuccess(); }, 0);
      return request;
    },
    addNamed: function (blob, path) {
      var request = {};
      request.blob = blob;
      request.path = path;
      setTimeout(function () {
        if (storedFiles[path]) {
          request.error = new Error('File already exists.');
          request.onerror();
          return;
        }
        if (path.indexOf('/') !== -1) {
          request.error = new Error('Parent directory does not exist.');
          request.onerror();
          return;
        }
        storedFiles[path] = blob;
        request.result = path;
        request.onsuccess();
      }, 0);
      return request;
    },
    get: function (path) {
      var request = {};
      setTimeout(function () {
        if (!storedFiles[path]) {
          request.error = new Error('File not found.');
          request.onerror();
          return;
        }
        request.result = storedFiles[path];
        request.onsuccess();
      }, 0);
      return request;
    },
    getEditable: function (path) {
      this.editablePath = path;
      var request = {};
      setTimeout(function () {
        request.result = {
          open: function (mode) {
            cardStorage.openMode = mode;
            return {
              truncate: function () { return successfulRequest(); },
              write: function (blob) {
                cardStorage.writtenBlob = blob;
                storedFiles[path] = blob;
                return successfulRequest();
              },
              flush: successfulRequest,
              close: function () { cardStorage.closed = true; }
            };
          }
        };
        request.onsuccess();
      }, 0);
      return request;
    },
    delete: function (path) {
      this.deletedPath = path;
      return successfulRequest(path);
    }
  };
}

function successfulRequest(result) {
  var request = { onsuccess: null, onerror: null };
  setTimeout(function () {
    request.result = result;
    request.onsuccess();
  }, 0);
  return request;
}

global.FileReader = function () {};
global.FileReader.prototype.readAsText = function (blob) {
  var reader = this;
  blob.text().then(function (text) {
    reader.result = text;
    reader.onload();
  }, function (error) {
    reader.error = error;
    reader.onerror();
  });
};

var repairStorage = {
  storageName: 'sdcard3',
  savedBlob: null,
  editableWrites: 0,
  addNamed: function () {
    this.savedBlob = new Blob([], { type: 'text/plain;charset=utf-8' });
    return successfulRequest('repair.txt');
  },
  get: function () {
    return successfulRequest(this.savedBlob);
  },
  getEditable: function () {
    var storage = this;
    return successfulRequest({
      open: function () {
        return {
          truncate: function () { return successfulRequest(); },
          write: function (blob) {
            storage.savedBlob = blob;
            storage.editableWrites++;
            return successfulRequest();
          },
          flush: successfulRequest,
          close: function () {}
        };
      }
    });
  }
};

var transactionStorage = {
  storageName: 'sdcard4',
  savedBlob: null,
  get: function () {
    return successfulRequest(this.savedBlob);
  },
  getEditable: function () {
    var storage = this;
    return successfulRequest({
      open: function () {
        var callbackActive = false;
        var lockedFile = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          truncate: function () {
            var request = { onsuccess: null, onerror: null };
            setTimeout(function () {
              callbackActive = true;
              request.onsuccess();
              callbackActive = false;
            }, 0);
            return request;
          },
          write: function (blob) {
            if (!callbackActive) throw new Error('LockedFile transaction is no longer active.');
            var request = { onsuccess: null, onerror: null };
            setTimeout(function () {
              callbackActive = true;
              storage.savedBlob = blob;
              request.onsuccess();
              callbackActive = false;
              setTimeout(function () { lockedFile.oncomplete(); }, 0);
            }, 0);
            return request;
          }
        };
        return lockedFile;
      }
    });
  }
};

var unsupportedHandleStorage = {
  storageName: 'sdcard5',
  files: {
    'existing.txt': new Blob(['old content'], { type: 'text/plain' }),
    'blocked.txt': new Blob(['keep this content'], { type: 'text/plain' })
  },
  get: function (path) {
    var request = {};
    setTimeout(function () {
      if (!this.files[path]) {
        request.error = new Error('File not found.');
        request.onerror();
        return;
      }
      request.result = this.files[path];
      request.onsuccess();
    }.bind(this), 0);
    return request;
  },
  getEditable: function () {
    return successfulRequest({ name: 'unsupported-file-handle' });
  },
  delete: function (path) {
    var storage = this;
    var request = {};
    setTimeout(function () {
      if (!storage.files[path]) {
        request.error = new Error('File not found.');
        request.onerror();
        return;
      }
      delete storage.files[path];
      request.result = path;
      request.onsuccess();
    }, 0);
    return request;
  },
  addNamed: function (blob, path) {
    var storage = this;
    var request = {};
    blob.text().then(function (text) {
      setTimeout(function () {
        if (storage.files[path] || (path === 'blocked.txt' && text === 'replacement that fails')) {
          request.error = new Error('File already exists or write was rejected.');
          request.onerror();
          return;
        }
        storage.files[path] = blob;
        request.result = path;
        request.onsuccess();
      }, 0);
    });
    return request;
  }
};

var internalStorage = fakeStorage('sdcard', ['/sdcard/readme.txt']);
var cardStorage = fakeStorage('sdcard1', ['/sdcard1/Games/HELLO.COM']);
L.listSdFiles([internalStorage, cardStorage]).then(function (files) {
  ok('files enumerated from all storages', files.length === 2);
  ok('sdcard1 path and label visible', files.some(function (file) {
    return file.storageName === 'sdcard1' && file.path === '/sdcard1/Games/HELLO.COM';
  }));
  ok('non-program files remain visible', files.some(function (file) { return file.name === 'readme.txt'; }));

  var saved = {};
  global.localStorage = {
    setItem: function (key, value) { saved[key] = value; },
    getItem: function (key) { return saved[key] || null; },
    removeItem: function (key) { delete saved[key]; }
  };
  return L.saveNote('persistent note', [cardStorage]);
}).then(function (result) {
  ok('note written and verified on SD storage root', result.storageSaved && result.verified && result.storageName === 'sdcard1' && /^notes-/.test(result.path));
  ok('note restored from local storage', L.loadSavedNote() === 'persistent note');
  return L.saveTextFile(cardStorage, 'created.txt', 'named file', false);
}).then(function (result) {
  ok('create action writes and verifies a named file', result.path === 'created.txt' && result.existing === false && result.verified && !!cardStorage.storedFiles['created.txt']);
  return L.saveTextFile(cardStorage, 'created.txt', 'collision text', false).then(function () {
    ok('addNamed does not replace an existing file', false);
  }, function () {
    return cardStorage.storedFiles['created.txt'].text().then(function (text) {
      ok('addNamed collision leaves existing contents unchanged', text === 'named file');
    });
  });
}).then(function () {
  return L.saveTextFile(repairStorage, 'repair.txt', 'restored content', false);
}).then(function (result) {
  ok('empty addNamed result repaired through editable writer', result.verified && repairStorage.editableWrites === 1);
  return L.saveTextFile(cardStorage, '/sdcard1/KaDOS/config.conf', 'updated config', true);
}).then(function (result) {
  ok('existing file opened for readwrite', cardStorage.editablePath === 'KaDOS/config.conf' && cardStorage.openMode === 'readwrite');
  ok('existing file truncated, written, flushed and verified', cardStorage.closed === true && cardStorage.writtenBlob.size > 0 && result.verified);
  ok('existing save keeps storage-qualified path', result.path === '/sdcard1/KaDOS/config.conf' && result.existing === true);
  return L.saveTextFile(transactionStorage, 'transaction.txt', 'committed content', true);
}).then(function (result) {
  ok('existing save waits for LockedFile commit before readback', result.verified && transactionStorage.savedBlob.size > 0);
  return L.saveTextFile(unsupportedHandleStorage, 'existing.txt', 'replacement content', true);
}).then(function (result) {
  ok('unsupported FileHandle replaced safely with verified content', result.verified && Object.keys(unsupportedHandleStorage.files).length === 2);
  return unsupportedHandleStorage.files['existing.txt'].text();
}).then(function (text) {
  ok('unsupported FileHandle replacement persisted content', text === 'replacement content');
  return L.saveTextFile(unsupportedHandleStorage, 'blocked.txt', 'replacement that fails', true).then(function () {
    ok('failed replacement must report an error', false);
  }, function () {
    return unsupportedHandleStorage.files['blocked.txt'].text().then(function (restoredText) {
      ok('failed replacement restores the original file', restoredText === 'keep this content');
    });
  });
}).then(function () {
  return L.deleteFile({ storage: cardStorage, path: '/sdcard1/KaDOS/config.conf' });
}).then(function () {
  ok('delete uses relative storage path', cardStorage.deletedPath === 'KaDOS/config.conf');
  ok('removable storage preferred', L.preferredStorage([internalStorage, cardStorage]) === cardStorage);
  ok('saved note can be deleted', L.deleteSavedNote() && L.loadSavedNote() === '');
  console.log(fails === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '\nПРОВАЛОВ: ' + fails);
  process.exitCode = fails ? 1 : 0;
}, function (error) {
  console.error('FAIL  storage integration: ' + (error.message || error));
  process.exitCode = 1;
});
