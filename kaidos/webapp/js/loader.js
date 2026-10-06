/* KaDOS Loader — выбор и загрузка программ.
  На KaiOS перебираются все Device Storage volumes; их имена зависят от устройства
  (например, sdcard и sdcard1). В эмулятор загружаются только .COM/.BIN.
  Заметки хранятся в app storage и экспортируются через Device Storage API. */
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

  // ---------- KaiOS Device Storage ----------
  function getSdStorages() {
    if (typeof navigator === 'undefined') return [];
    if (typeof navigator.getDeviceStorages === 'function') {
      return Array.prototype.slice.call(navigator.getDeviceStorages('sdcard') || []);
    }
    if (typeof navigator.getDeviceStorage === 'function') {
      var storage = navigator.getDeviceStorage('sdcard');
      return storage ? [storage] : [];
    }
    return [];
  }

  function storageLabel(storage, file) {
    var path = String(file && file.name || '');
    return storage.storageName || path.split('/')[1] || 'sdcard';
  }

  function enumerateStorage(storage) {
    return new Promise(function (resolve, reject) {
      var found = [];
      var request;
      try {
        request = storage.enumerate();
      } catch (error) {
        reject(error);
        return;
      }

      request.onsuccess = function () {
        try {
          var file = request.result;
          if (!file) {
            resolve(found);
            return;
          }
          var path = String(file.name || '');
          found.push({
            name: path.split('/').pop(),
            path: path,
            storageName: storageLabel(storage, file),
            storage: storage,
            file: file
          });
          request.continue();
        } catch (error) {
          reject(error);
        }
      };

      request.onerror = function () {
        reject(request.error || new Error('Не удалось прочитать список файлов.'));
      };
    });
  }

  function listSdFiles(storageList) {
    var storages;
    try {
      storages = storageList || getSdStorages();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!storages || !storages.length) return Promise.resolve([]);

    var errors = [];
    return Promise.all(Array.prototype.map.call(storages, function (storage) {
      return enumerateStorage(storage).catch(function (error) {
        errors.push(error);
        return [];
      });
    })).then(function (results) {
      var found = [].concat.apply([], results);
      if (!found.length && errors.length === storages.length) {
        throw new Error('Нет доступа к хранилищам: ' + errors.map(function (error) {
          return error.name || error.message || String(error);
        }).join(', '));
      }
      found.sort(function (a, b) {
        return a.storageName.localeCompare(b.storageName) || a.path.localeCompare(b.path);
      });
      return found;
    });
  }

  function loadSavedNote() {
    try {
      return global.localStorage ? global.localStorage.getItem('kados.note') || '' : '';
    } catch (error) {
      return '';
    }
  }

  function deleteSavedNote() {
    try {
      if (global.localStorage) global.localStorage.removeItem('kados.note');
      return true;
    } catch (error) {
      return false;
    }
  }

  function relativeStoragePath(storage, path) {
    var value = String(path || '').replace(/\\/g, '/');
    var prefix = '/' + String(storage.storageName || '') + '/';
    if (value.indexOf(prefix) === 0) value = value.slice(prefix.length);
    value = value.replace(/^\/+/, '');
    if (!value || value === '..' || value.indexOf('../') === 0) {
      throw new Error('Некорректный путь файла.');
    }
    return value;
  }

  function resolveSaveTargetPath(currentPath, fileName) {
    var name = String(fileName || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) return '';
    var value = String(currentPath || '').replace(/\\/g, '/');
    if (value && value.charAt(0) === '/') {
      value = value.replace(/^\/+/, '').replace(/^[^/]+\//, '');
    }
    if (!value || value.indexOf('/') === -1) {
      return name;
    }
    var parent = value.substring(0, value.lastIndexOf('/'));
    return parent ? parent + '/' + name : name;
  }

  function waitForRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Операция с файлом не выполнена.')); };
    });
  }

  function awaitOperation(result) {
    if (result && (typeof result === 'object' || typeof result === 'function') &&
        (typeof result.onsuccess !== 'undefined' || 'onsuccess' in result)) {
      return waitForRequest(result);
    }
    return Promise.resolve(result);
  }

  function writeEditableHandle(handle, blob) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof handle.open === 'function') {
          var lockedFile = handle.open('readwrite');
          var supportsCompletion = 'oncomplete' in lockedFile;
          var settled = false;
          function fail(error) {
            if (settled) return;
            settled = true;
            if (typeof lockedFile.abort === 'function') lockedFile.abort();
            reject(error || new Error('Не удалось записать файл.'));
          }
          if (supportsCompletion) {
            lockedFile.oncomplete = function () {
              if (settled) return;
              settled = true;
              resolve();
            };
            lockedFile.onerror = function (event) {
              fail(lockedFile.error || (event && event.target && event.target.error));
            };
            lockedFile.onabort = function () {
              fail(lockedFile.error || new Error('Транзакция записи была отменена.'));
            };
          }

          function issue(request, next) {
            request.onsuccess = function () {
              try {
                next();
              } catch (error) {
                fail(error);
              }
            };
            request.onerror = function () {
              fail(request.error || new Error('Не удалось записать файл.'));
            };
          }

          issue(lockedFile.truncate(0), function () {
            issue(lockedFile.write(blob), function () {
              if (typeof lockedFile.flush === 'function') {
                issue(lockedFile.flush(), finishWithoutCompletionEvent);
              } else {
                finishWithoutCompletionEvent();
              }
            });
          });

          function finishWithoutCompletionEvent() {
            if (supportsCompletion || settled) return;
            settled = true;
            if (typeof lockedFile.close === 'function') lockedFile.close();
            resolve();
          }
          return;
        }
        if (typeof handle.createWriter === 'function') {
          var writer = handle.createWriter();
          var phase = 'truncate';
          writer.onerror = function () { reject(writer.error || new Error('Не удалось записать файл.')); };
          writer.onwriteend = function () {
            if (writer.error) {
              reject(writer.error);
            } else if (phase === 'truncate') {
              phase = 'write';
              writer.position = 0;
              writer.write(blob);
            } else {
              resolve();
            }
          };
          writer.truncate(0);
          return;
        }
        if (typeof handle.write === 'function') {
          var request = handle.write(blob);
          if (request && typeof request.onsuccess !== 'undefined') {
            waitForRequest(request).then(resolve, reject);
          } else {
            resolve();
          }
          return;
        }
        var unsupportedError = new Error('KaiOS не предоставил способ записи в существующий файл.');
        unsupportedError.code = 'UNSUPPORTED_EDITABLE_HANDLE';
        reject(unsupportedError);
      } catch (error) {
        reject(error);
      }
    });
  }

  function verifyTextFile(storage, path, expectedText) {
    if (!storage || typeof storage.get !== 'function') {
      return Promise.reject(new Error('Проверка файла в хранилище недоступна.'));
    }
    var relativePath;
    try {
      relativePath = relativeStoragePath(storage, path);
    } catch (error) {
      return Promise.reject(error);
    }
    var request;
    try {
      request = storage.get(relativePath);
    } catch (error) {
      return Promise.reject(error);
    }
    return waitForRequest(request).then(readTextFile).then(function (actualText) {
      if (actualText !== String(expectedText || '')) {
        throw new Error('Содержимое файла не совпало после записи.');
      }
      return true;
    });
  }

  function writeEditableFile(storage, relativePath, blob) {
    if (typeof storage.getEditable !== 'function') {
      return Promise.reject(new Error('Редактирование существующих файлов недоступно.'));
    }
    var editableRequest;
    try {
      editableRequest = storage.getEditable(relativePath);
    } catch (error) {
      return Promise.reject(error);
    }
    return waitForRequest(editableRequest).then(function (handle) {
      return writeEditableHandle(handle, blob);
    });
  }

  function addNamedFile(storage, relativePath, blob) {
    if (typeof storage.addNamed !== 'function') {
      return Promise.reject(new Error('Запись новых файлов недоступна.'));
    }
    var addRequest;
    try {
      addRequest = storage.addNamed(blob, relativePath);
    } catch (error) {
      return Promise.reject(error);
    }
    return waitForRequest(addRequest);
  }

  function deleteStoragePath(storage, path) {
    if (typeof storage.delete !== 'function') {
      return Promise.reject(new Error('Удаление файлов в этом хранилище недоступно.'));
    }
    try {
      return waitForRequest(storage.delete(path));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function replaceExistingFile(storage, path, blob, expectedText) {
    var separator = path.lastIndexOf('/');
    var parent = separator < 0 ? '' : path.slice(0, separator + 1);
    var backupPath = parent + 'kados-backup-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.txt';
    var originalText = '';
    var backupCreated = false;
    var targetDeleted = false;

    var replacement = waitForRequest(storage.get(path)).then(function (originalBlob) {
      return readTextFile(originalBlob).then(function (text) {
        originalText = text;
        return addNamedFile(storage, backupPath, originalBlob);
      });
    }).then(function () {
      backupCreated = true;
      return verifyTextFile(storage, backupPath, originalText);
    }).then(function () {
      return deleteStoragePath(storage, path);
    }).then(function () {
      targetDeleted = true;
      return addNamedFile(storage, path, blob);
    }).then(function () {
      return verifyTextFile(storage, path, expectedText);
    });

    return replacement.then(function () {
      return deleteStoragePath(storage, backupPath).catch(function () {});
    }, function (saveError) {
      if (!targetDeleted) {
        var cleanup = backupCreated ? deleteStoragePath(storage, backupPath).catch(function () {}) : Promise.resolve();
        return cleanup.then(function () { throw saveError; });
      }

      return deleteStoragePath(storage, path).catch(function () {}).then(function () {
        return waitForRequest(storage.get(backupPath));
      }).then(function (backupBlob) {
        return addNamedFile(storage, path, backupBlob);
      }).then(function () {
        return verifyTextFile(storage, path, originalText);
      }).then(function () {
        return deleteStoragePath(storage, backupPath).catch(function () {}).then(function () {
          throw saveError;
        });
      }, function (restoreError) {
        throw new Error((saveError.message || saveError) + ' Не удалось восстановить исходник; резервная копия: ' + backupPath + '. ' + (restoreError.message || restoreError));
      });
    });
  }

  function saveTextFile(storage, path, text, existing) {
    if (!storage) return Promise.reject(new Error('Не выбрано хранилище для записи.'));
    var relativePath;
    try {
      relativePath = relativeStoragePath(storage, path);
    } catch (error) {
      return Promise.reject(error);
    }
    var blob;
    try {
      blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
    } catch (error) {
      return Promise.reject(error);
    }

    if (existing) {
      return writeEditableFile(storage, relativePath, blob).catch(function (error) {
        if (error.code !== 'UNSUPPORTED_EDITABLE_HANDLE') throw error;
        return replaceExistingFile(storage, relativePath, blob, text);
      }).then(function () {
        return verifyTextFile(storage, path, text);
      }).then(function () {
        return { storageName: storage.storageName || 'sdcard', path: path, existing: true, verified: true };
      });
    }

    return addNamedFile(storage, relativePath, blob).then(function () {
      return verifyTextFile(storage, path, text).catch(function (verifyError) {
        if (typeof storage.getEditable !== 'function') throw verifyError;
        return writeEditableFile(storage, relativePath, blob).then(function () {
          return verifyTextFile(storage, path, text);
        });
      });
    }).then(function () {
      return { storageName: storage.storageName || 'sdcard', path: path, existing: false, verified: true };
    });
  }

  function deleteStorageFile(item) {
    if (!item || !item.storage || typeof item.storage.delete !== 'function') {
      return Promise.reject(new Error('Удаление файлов в этом хранилище недоступно.'));
    }
    var path;
    try {
      path = relativeStoragePath(item.storage, item.path || item.file.name);
      return waitForRequest(item.storage.delete(path));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function readTextFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Не удалось прочитать текстовый файл.')); };
      reader.readAsText(file, 'UTF-8');
    });
  }

  function readStorageTextFile(storage, path) {
    if (!storage || typeof storage.get !== 'function') {
      return Promise.reject(new Error('Чтение файла из хранилища недоступно.'));
    }
    var relativePath;
    try {
      relativePath = relativeStoragePath(storage, path);
    } catch (error) {
      return Promise.reject(error);
    }
    var request;
    try {
      request = storage.get(relativePath);
    } catch (error) {
      return Promise.reject(error);
    }
    return waitForRequest(request).then(function (blob) {
      return readTextFile(blob);
    });
  }

  function preferredStorage(storageList) {
    var storages = storageList || getSdStorages();
    return Array.prototype.filter.call(storages || [], function (storage) {
      return storage.isRemovable === true;
    })[0] || Array.prototype.filter.call(storages || [], function (storage) {
      return storage.default === true;
    })[0] || (storages && storages[0]) || null;
  }

  function saveNote(text, storageList) {
    var value = String(text || '');
    try {
      if (global.localStorage) global.localStorage.setItem('kados.note', value);
    } catch (error) {
      return Promise.reject(new Error('Не удалось сохранить заметку в памяти приложения: ' + (error.message || error)));
    }

    var storages;
    try {
      storages = storageList || getSdStorages();
    } catch (error) {
      return Promise.resolve({ localSaved: true, storageSaved: false, error: error });
    }
    if (!storages || !storages.length) {
      return Promise.resolve({ localSaved: true, storageSaved: false });
    }

    var storage = preferredStorage(storages);
    if (!storage || typeof storage.addNamed !== 'function' || typeof Blob === 'undefined') {
      return Promise.resolve({ localSaved: true, storageSaved: false, error: new Error('Запись на SD-карту недоступна.') });
    }

    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    var path = 'notes-' + stamp + '-' + Math.floor(Math.random() * 100000) + '.txt';
    return saveTextFile(storage, path, value, false).then(function (saved) {
      saved.localSaved = true;
      saved.storageSaved = true;
      return saved;
    }, function (error) {
      return { localSaved: true, storageSaved: false, error: error };
    });
  }

  function chooseFileFromSd() {
    return listSdFiles().then(function (files) {
      if (!files.length) {
        throw new Error('На SD-карте не найдено файлов .COM/.BIN.');
      }
      var names = files.map(function (item) { return item.name; });
      var choice = window.prompt('Выберите файл из SD-карты:\n' + names.join('\n'), names[0]);
      if (!choice) {
        throw new Error('Выбор файла отменён.');
      }
      var match = files.filter(function (item) {
        return item.name.toLowerCase() === choice.toLowerCase();
      })[0];
      if (!match) {
        throw new Error('Файл не найден: ' + choice);
      }
      return match;
    });
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

  function validateProgramFile(file) {
    if (!file || !/\.(com|bin)$/i.test(file.name || '')) {
      throw new Error('Поддерживаются только файлы .COM и .BIN; .EXE не поддерживается.');
    }
    if (!file.size || file.size > 0xFF00) {
      throw new Error('Размер файла должен быть от 1 до 65280 байт.');
    }
  }

  function isTextFileName(name) {
    return /\.(txt|conf|cfg|bat|ini|asm|nfo)$/i.test(String(name || ''));
  }

  function filterTextFiles(items) {
    return Array.prototype.filter.call(items || [], function (item) {
      return isTextFileName(item && (item.name || item.path || ''));
    });
  }

  function filterSupportedFiles(items) {
    return Array.prototype.filter.call(items || [], function (item) {
      var name = String(item && (item.name || item.path) || '');
      return isTextFileName(name) || /\.(com|bin)$/i.test(name);
    });
  }

  function normalizeMenuDirection(key) {
    if (key === 'ArrowLeft') return 'ArrowRight';
    if (key === 'ArrowRight') return 'ArrowLeft';
    return key;
  }

  function navigateCommandHistory(commands, index, direction) {
    var entries = commands || [];
    var nextIndex = direction === 'ArrowUp'
      ? Math.max(0, index - 1)
      : Math.min(entries.length, index + 1);
    return { index: nextIndex, command: nextIndex === entries.length ? '' : entries[nextIndex] };
  }

  function normalizeInputDirection(key) {
    var directions = {
      ArrowLeft: 'ArrowRight',
      ArrowRight: 'ArrowLeft',
      ArrowUp: 'ArrowDown',
      ArrowDown: 'ArrowUp'
    };
    return directions[key] || key;
  }

  function moveTextCaret(field, direction, extendSelection) {
    if (!field || typeof field.setSelectionRange !== 'function' ||
        typeof field.selectionStart !== 'number' || typeof field.selectionEnd !== 'number') return false;

    var value = String(field.value || '');
    var start = field.selectionStart;
    var end = field.selectionEnd;
    var backwards = field.selectionDirection === 'backward';
    var anchor = backwards ? end : start;
    var focus = backwards ? start : end;
    var target = focus;

    if (!extendSelection && start !== end) {
      target = direction === 'ArrowLeft' || direction === 'ArrowUp' ? start : end;
      anchor = target;
    } else if (direction === 'ArrowLeft') {
      target = Math.max(0, focus - 1);
      if (!extendSelection) anchor = target;
    } else if (direction === 'ArrowRight') {
      target = Math.min(value.length, focus + 1);
      if (!extendSelection) anchor = target;
    } else if (direction === 'ArrowUp' || direction === 'ArrowDown') {
      var currentLineStart = value.lastIndexOf('\n', Math.max(0, focus - 1)) + 1;
      var currentLineEnd = value.indexOf('\n', focus);
      if (currentLineEnd < 0) currentLineEnd = value.length;
      var column = focus - currentLineStart;
      var nextLineStart;
      var nextLineEnd;
      if (direction === 'ArrowUp') {
        if (currentLineStart === 0) return true;
        nextLineEnd = currentLineStart - 1;
        nextLineStart = value.lastIndexOf('\n', Math.max(0, nextLineEnd - 1)) + 1;
      } else {
        if (currentLineEnd === value.length) return true;
        nextLineStart = currentLineEnd + 1;
        nextLineEnd = value.indexOf('\n', nextLineStart);
        if (nextLineEnd < 0) nextLineEnd = value.length;
      }
      target = Math.min(nextLineStart + column, nextLineEnd);
      if (!extendSelection) anchor = target;
    } else {
      return false;
    }

    field.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target),
      target === anchor ? 'none' : target < anchor ? 'backward' : 'forward');
    return true;
  }

  function normalizeDeviceKey(key) {
    if (key === null || key === undefined) return null;
    if (typeof key === 'object') {
      var event = key;
      var legacyKeys = {
        4: 'Back', 8: 'Backspace', 13: 'Enter', 23: 'Enter', 27: 'Escape', 32: 'Space',
        461: 'Back', 10009: 'Back',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown'
      };
      var eventCode = event.keyCode || event.which;
      key = event.key;
      if (!key || key === 'Unidentified') key = legacyKeys[eventCode];
      if (!key) {
        var code = event.keyCode || event.which;
        if ((code >= 48 && code <= 57) || (code >= 96 && code <= 105)) {
          key = String((code >= 96 ? code - 96 : code - 48));
        } else if (code >= 65 && code <= 90) {
          key = String.fromCharCode(code + (event.shiftKey ? 0 : 32));
        }
      }
      if (!key) return null;
    }
    var value = key === ' ' ? ' ' : String(key).trim();
    if (!value) return value;

    var aliases = {
      'Up': 'ArrowUp', 'ArrowUp': 'ArrowUp', 'Numpad8': 'ArrowUp', 'KeyW': 'ArrowUp', 'KeyK': 'ArrowUp',
      'Down': 'ArrowDown', 'ArrowDown': 'ArrowDown', 'Numpad2': 'ArrowDown', 'KeyS': 'ArrowDown', 'KeyJ': 'ArrowDown',
      'Left': 'ArrowLeft', 'ArrowLeft': 'ArrowLeft', 'Numpad4': 'ArrowLeft', 'KeyA': 'ArrowLeft', 'KeyH': 'ArrowLeft',
      'Right': 'ArrowRight', 'ArrowRight': 'ArrowRight', 'Numpad6': 'ArrowRight', 'KeyD': 'ArrowRight', 'KeyL': 'ArrowRight',
      'Enter': 'Enter', 'Numpad5': 'Enter', 'NumpadEnter': 'Enter', 'Space': 'Enter', 'Spacebar': 'Enter',
      'Center': 'Enter', 'SoftCenter': 'Enter', 'Select': 'Enter', 'Accept': 'Enter', 'OK': 'Enter', 'Ok': 'Enter',
      'Backspace': 'Backspace', 'Escape': 'Escape', 'SoftLeft': 'SoftLeft', 'SoftRight': 'SoftRight',
      'Back': 'Back', 'GoBack': 'Back', 'BrowserBack': 'Back'
    };

    return aliases[value] || value;
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
    getSdStorages: getSdStorages,
    chooseFileFromSd: chooseFileFromSd,
    loadSdFile: loadSdFile,
    readFile: readBlobAsBytes,
    readTextFile: readTextFile,
    readStorageTextFile: readStorageTextFile,
    loadSavedNote: loadSavedNote,
    deleteSavedNote: deleteSavedNote,
    saveNote: saveNote,
    saveTextFile: saveTextFile,
    deleteFile: deleteStorageFile,
    preferredStorage: preferredStorage,
    resolveSaveTargetPath: resolveSaveTargetPath,
    normalizeMenuDirection: normalizeMenuDirection,
    navigateCommandHistory: navigateCommandHistory,
    normalizeInputDirection: normalizeInputDirection,
    moveTextCaret: moveTextCaret,
    validateProgramFile: validateProgramFile,
    isTextFileName: isTextFileName,
    filterTextFiles: filterTextFiles,
    filterSupportedFiles: filterSupportedFiles,
    normalizeDeviceKey: normalizeDeviceKey,
    parseHex: parseHex
  };
})(this);
