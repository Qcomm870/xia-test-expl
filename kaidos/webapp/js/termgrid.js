/* Terminal grid engine — точный порт движка putChar/newLine/setChar из
 * оригинального приложения "Terminal" для KaiOS (Affe Null, 2020, MIT).
 * Убраны только telnet-сокеты: вместо sock.send() вызывается onSend(ch),
 * который KaDOS подключает к своей DOS-консоли. Сетка 20x13 как в оригинале.
 */
(function () {
  'use strict';

  function createTermGrid(elTerm, opts) {
    opts = opts || {};
    var chars = [];
    var curx = 0, cury = 0;
    var numindex, num, esc = false, esc_bracket = false,
      esc_paren_open = false, esc_question = false,
      lineDrawing = false, cursorKeys = false;
    var textattrs = { bold: false, inverse: false, color: '#9f9', backgroundColor: '#000' };
    var ignoreChars = 0;
    const maxx = 20;
    const maxy = 13;
    var specialCharacters = {}; // line-drawing не используется в DOS-демо

    function process_attrs(code) {
      if (code == 1) textattrs.bold = true;
      else if (code == 7) textattrs.inverse = true;
      else if (code == 21) textattrs.bold = false;
      else if (code == 27) textattrs.inverse = false;
      else if (!code) {
        textattrs.bold = false;
        textattrs.inverse = false;
        textattrs.color = '#9f9';
        textattrs.backgroundColor = '#000';
      }
    }

    function setChar(x, y, ch) {
      var cell = chars[y] && chars[y][x];
      if (!cell) return;
      cell.style.fontWeight = textattrs.bold ? 'bold' : 'normal';
      if (textattrs.inverse) {
        cell.style.color = textattrs.backgroundColor;
        cell.style.backgroundColor = textattrs.color;
      } else {
        cell.style.color = textattrs.color;
        cell.style.backgroundColor = textattrs.backgroundColor;
      }
      cell.textContent = lineDrawing
        ? (specialCharacters.hasOwnProperty(ch) ? specialCharacters[ch] : ch)
        : ch;
    }

    function putChar(ch, noCursorUpdate) {
      if (ch == '\x1b') { esc = true; return; }
      else if (esc) {
        if (ch == '[') { esc_bracket = true; num = Array(); numindex = 0; }
        else if (ch == '(') esc_paren_open = true;
        esc = false;
      }
      else if (esc_paren_open) {
        esc_paren_open = false;
        if (ch == '0') lineDrawing = true;
        else if (ch == 'B') lineDrawing = false;
      }
      else if (esc_question) {
        if (isNaN(ch)) {
          esc_question = false;
          if (num[0] == 1) cursorKeys = (ch == 'h');
        } else {
          if (num[0]) { num[0] *= 10; num[0] += Number(ch); }
          else num[0] = Number(ch);
        }
      }
      else if (esc_bracket) {
        esc_bracket = false;
        if (!isNaN(ch)) {
          if (num[numindex]) { num[numindex] *= 10; num[numindex] += Number(ch); }
          else num[numindex] = Number(ch);
          esc_bracket = true;
        } else if (ch == ';') { numindex++; esc_bracket = true; }
        else {
          var val = num[0] ? num[0] : 1;
          switch (ch) {
            case '?': esc_question = true; break;
            case 'B': if (cury + val < maxy) cury += val; break;
            case 'A': if (cury - val >= 0) cury -= val; break;
            case 'C': if (curx + val < maxx) curx += val; break;
            case 'D': if (curx - val >= 0) curx -= val; break;
            case 'd': cury = num[0] ? num[0] - 1 : 0; if (cury >= maxy) cury = maxy - 1; break;
            case 'H':
            case 'f':
              cury = num[0] ? num[0] - 1 : 0;
              curx = num[1] ? num[1] - 1 : 0;
              if (cury >= maxy) cury = maxy - 1;
              if (curx >= maxx) curx = maxx - 1;
              break;
            case 'J': {
              var i = cury, end = chars.length, j = curx, line_end = maxx;
              if (num[0]) { i = 0; j = 0; }
              if (num[0] == 1) { end = cury; line_end = curx - 1; }
              for (; i < end; i++) {
                for (; j < line_end; j++) setChar(j, i, ' ');
                j = 0; line_end = maxx;
              }
              break;
            }
            case 'K': {
              var ii = curx, ee = maxx;
              if (num[0]) ii = 0;
              if (num[0] == 1) ee = curx;
              for (; ii < ee; ii++) setChar(ii, cury, ' ');
              break;
            }
            case 'm':
              for (var mi = 0; mi < num.length; mi++) process_attrs(num[mi]);
              if (num.length == 0) process_attrs(0);
              break;
          }
        }
      }
      else if (ch == '\n') {
        /* В оригинальном Terminal за сервером telnet перевод строки всегда
         * идёт как CRLF ("\r\n"), поэтому после '\n' курсор НЕ сбрасывался
         * по X. У нас вывод DOS-консоли приходит с голым '\n' — если X не
         * сбрасывать, каждая следующая строка печатается со старой позиции
         * и экран выглядит пустым/смятым. Это и был баг «нет вывода». */
        curx = 0;
        cury++;
        if (cury == maxy) { newLine(); cury--; }
      }
      else if (ch == '\r') curx = 0;
      else if (ch == '\b' && curx != 0) {
        curx--;
        chars[cury][curx].textContent = ' ';
      }
      else if (ch.charCodeAt(0) < 0x20) return;
      else {
        if (curx == maxx) {
          cury++;
          curx = 0;
          if (cury == maxy) { newLine(); cury--; }
        }
        setChar(curx, cury, ch);
        curx++;
      }
    }

    /* Стирание символа перед кареткой: '\b' в putChar оригинала сдвигает
     * каретку назад, но НЕ затирает ячейку (стирание делает telnet-эхо
     * сервера). У KaDOS эха нет — для multi-tap замены (a->b->c) и Backspace
     * нужна явная затирка. Возвращает true, если что-то было стёрто. */
    function eraseBack() {
      if (curx === 0) return false;
      curx--;
      setChar(curx, cury, ' ');
      return true;
    }

    function newLineAt(line) {
      if (!chars[line + 1]) return;
      var elCurrentLine = chars[line][0].parentElement;
      chars = chars.slice(0, line).concat([[]]).concat(chars.slice(line));
      chars.pop();
      var elNewLine = document.createElement('span');
      for (var j = 0; j < maxx; j++) {
        var newch = document.createElement('span');
        newch.textContent = '';
        chars[line].push(newch);
        elNewLine.appendChild(newch);
      }
      elTerm.insertBefore(elNewLine, elCurrentLine);
      elTerm.insertBefore(document.createElement('br'), elCurrentLine);
      var oldcurx = curx, oldcury = cury;
      cury = line; curx = 0;
      putStr('                    ');
      curx = oldcurx; cury = oldcury;
      elTerm.removeChild(elTerm.lastChild);
      elTerm.removeChild(elTerm.lastChild);
    }

    function removeLineAt(line) {
      var elCurrentLine = chars[line][0].parentElement;
      chars = chars.slice(0, line).concat(chars.slice(line + 1, maxy));
      chars.push([]);
      var elNewLine = document.createElement('span');
      for (var j = 0; j < maxx; j++) {
        var newch = document.createElement('span');
        newch.textContent = '';
        chars[chars.length - 1].push(newch);
        elNewLine.appendChild(newch);
      }
      elTerm.appendChild(elNewLine);
      elTerm.appendChild(document.createElement('br'));
      var oldcurx = curx, oldcury = cury;
      cury = maxy - 1; curx = 0;
      putStr('                    ');
      curx = oldcurx; cury = oldcury;
      elTerm.removeChild(elCurrentLine.nextSibling);
      elTerm.removeChild(elCurrentLine);
    }

    /* Append a new line to the terminal and rotate if necessary. */
    function newLine() {
      chars.push([]);
      if (cury == maxy) chars.shift();
      var elNewLine = document.createElement('span');
      for (var j = 0; j < maxx; j++) {
        var newch = document.createElement('span');
        newch.textContent = '';
        chars[chars.length - 1].push(newch);
        elNewLine.appendChild(newch);
      }
      var oldcurx = curx, oldcury = cury;
      cury = chars.length - 1; curx = 0;
      putStr('                    ');
      curx = oldcurx; cury = oldcury;
      if (cury == maxy) {
        elTerm.removeChild(elTerm.firstChild);
        elTerm.removeChild(elTerm.firstChild);
      }
      elTerm.appendChild(elNewLine);
      elTerm.appendChild(document.createElement('br'));
    }

    function putStr(str) {
      for (var i = 0; i < str.length; i++) putChar(str[i]);
    }

    function reset() {
      while (elTerm.firstChild) elTerm.removeChild(elTerm.firstChild);
      chars = [];
      curx = 0; cury = 0;
      for (var i = 0; i < maxy; i++) newLine();
    }

    /* Инициализация терминала — ровно как в оригинале */
    reset();

    return {
      putChar: putChar,
      putStr: putStr,
      reset: reset,
      clear: reset,
      eraseBack: eraseBack,
      getCursor: function () { return { x: curx, y: cury }; },
      MAXX: maxx,
      MAXY: maxy
    };
  }

  window.TermGrid = { create: createTermGrid };
})();
