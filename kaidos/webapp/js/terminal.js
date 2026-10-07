/* Terminal application for KaiOS — verbatim port of Affe Null's Terminal
 * (terminal-omnisd.zip / app.js, Copyright (C) 2020 Affe Null).
 * The telnet socket is replaced with a local command handler so the code can
 * be embedded into KaDOS. putChar/newLine/setChar/ANSI logic and the multi-tap
 * T9 key handling are kept EXACTLY as in the original.
 */
(function(){
'use strict';

/* Т9-раскладка — дословно из оригинального app.js (Affe Null):
   группы включают цифры в конце, символ виден мгновенно, повторные
   нажатия циклически заменяют его на месте, фиксация таймером 1000 мс. */
var keys = [
        [' ', '0'],
        ['.', ',', '?', '!', '1', ';', ':', '/', '@', '-', '+', '_',
                '=', '$', '|', '<', '>'],
        ['a', 'b', 'c', '2'],
        ['d', 'e', 'f', '3'],
        ['g', 'h', 'i', '4'],
        ['j', 'k', 'l', '5'],
        ['m', 'n', 'o', '6'],
        ['p', 'q', 'r', 's', '7'],
        ['t', 'u', 'v', '8'],
        ['w', 'x', 'y', 'z', '9']
];

var specialCharacters = {
        "a": "\u2592", "b": "\u2409", "c": "\u240c", "d": "\u240d",
        "e": "\u240a", "f": "\u00b0", "g": "\u00b1", "h": "\u24a4",
        "i": "\u240b", "j": "\u2518", "k": "\u2510", "l": "\u250c",
        "m": "\u2514", "n": "\u253c", "o": "\u23ba", "p": "\u23bb",
        "q": "\u2500", "r": "\u23bc", "s": "\u23bd", "t": "\u251c",
        "u": "\u2524", "v": "\u2534", "w": "\u252c", "x": "\u2502",
        "y": "\u2264", "z": "\u2265", "`": "\u25c6", "~": "\u00b7"
};

var fgColor = "#ffffff";
var bgColor = "#000000";

var elTerm;
var chars = [];
var curx = 0, cury = 0;
var numindex, num, esc = false; var esc_bracket = false,
        esc_paren_open = false, esc_question = false,
        lineDrawing = false, cursorKeys = false;
var textattrs = {
        "bold": false,
        "inverse": false,
        "color": fgColor,
        "backgroundColor": bgColor
};
var ignoreChars = 0;
const maxx = 20;
const maxy = 13;
var currentKey = -1;
var currentKeyIndex = 0;
var sendTimeoutId = 0;
var control = false, uc = false;

var started = false;
var commandHandler = null;   /* function(line){...} -> returns output string */
var promptText = "root@kaios:~# ";
var inputLine = "";          /* confirmed characters of the current line */
var pendingCh = null;        /* currently selected char of the active group */
var closeCb = null;
var historyCb = null;      /* v0.2.69: стрелки Up/Down -> история команд хоста */

function process_attrs(code){
        if(code == 1){
                textattrs.bold = true;
        }
        else if(code == 7){
                textattrs.inverse = true;
        }
        else if(code == 21){
                textattrs.bold = false;
        }
        else if(code == 27){
                textattrs.inverse = false;
        }
        else if(!code){
                textattrs.bold = false;
                textattrs.inverse = false;
                textattrs.color = fgColor;
                textattrs.backgroundColor = bgColor;
        }
        else {
                const map_code_to_color = {
                        30: "black",
                        31: "#900",
                        32: "#090",
                        33: "#f90",
                        34: "#009",
                        35: "#909",
                        36: "#099",
                        37: "#999",
                        90: "#444",
                        91: "#f44",
                        92: "#4f4",
                        93: "#ff4",
                        94: "#44f",
                        95: "#f4f",
                        96: "#4ff",
                        97: "white"
                };
                if((code >= 40 && code < 48) ||
                        (code >= 100 && code < 108))
                {
                        textattrs.backgroundColor = map_code_to_color[
                                code - 10
                        ];
                }
                else if((code >= 30 && code < 38) ||
                        (code >= 90 && code < 98))
                {
                        textattrs.color = map_code_to_color[code];
                }
                else if(code == 39){
                        textattrs.color = fgColor;
                }
                else if(code == 49){
                        textattrs.backgroundColor = bgColor;
                }
        }
}

function setChar(x, y, ch){
        if(textattrs.bold) chars[y][x].style.fontWeight =
                "bold";
        else chars[y][x].style.fontWeight =
                "normal";
        if(textattrs.inverse){
                chars[y][x].style.color =
                        textattrs.backgroundColor;
                chars[y][x].style.backgroundColor =
                        textattrs.color;
        }
        else {
                chars[y][x].style.color =
                        textattrs.color;
                chars[y][x].style.backgroundColor =
                        textattrs.backgroundColor;
        }
        chars[y][x].textContent = lineDrawing ?
                (specialCharacters.hasOwnProperty(ch) ?
                        specialCharacters[ch] : ch) : ch;
}

function ctrl(ch){
        return String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40);
}

function putChar(ch, noCursorUpdate){
        if(ch == "\x1b"){
                esc = true;
                return;
        }
        else if(esc){
                if(ch == "["){
                        esc_bracket = true;
                        num = Array();
                        numindex = 0;
                }
                else if(ch == "("){
                        esc_paren_open = true;
                }
                esc = false;
        }
        else if(esc_paren_open){
                esc_paren_open = false;
                if(ch == "0") lineDrawing = true;
                else if(ch == "B") lineDrawing = false;
        }
        else if(esc_question){
                if(isNaN(ch)){
                        esc_question = false;
                        if(num[0] == 1){
                                cursorKeys = (ch == "h");
                        }
                }
                else {
                        if(num[0]){
                                num[0] *= 10;
                                num[0] += Number(ch);
                        }
                        else {
                                num[0] = Number(ch);
                        }
                }
        }
        else if(esc_bracket){
                esc_bracket = false;
                if(!isNaN(ch)){
                        if(num[numindex]){
                                num[numindex] *= 10;
                                num[numindex] += Number(ch);
                        }
                        else {
                                num[numindex] = Number(ch);
                        }
                        esc_bracket = true;
                }
                else if(ch == ";"){
                        numindex++;
                        esc_bracket = true;
                }
                else {
                        var val = num[0] ? num[0] : 1;
                        switch(ch){
                        case "?":
                                esc_question = true;
                                break;
                        case "B":
                                if(cury + val < maxy) cury += val;
                                break;
                        case "A":
                                if(cury - val >= 0) cury -= val;
                                break;
                        case "C":
                                if(curx + val < maxx) curx += val;
                                break;
                        case "D":
                                if(curx - val >= 0) curx -= val;
                                break;
                        case "d":
                                cury = num[0] ? num[0]-1 : 0;
                                if(cury >= maxy) cury = maxy-1;
                                break;
                        case "@":
                                for(var i = 0; i < val; i++){
                                        for(var j = maxx-2;
                                                j >= curx; j--)
                                        {
                                                chars[cury][j+1].
                                                        innerHTML =
                                                chars[cury][j].
                                                        innerHTML;
                                                chars[cury][j+1].
                                                        style.color =
                                                chars[cury][j].
                                                        style.color;
                                                chars[cury][j+1].style.
                                                        backgroundColor=
                                                chars[cury][j].style.
                                                        backgroundColor;
                                                chars[cury][j+1].style.
                                                        fontWeight =
                                                chars[cury][j].style.
                                                        fontWeight;
                                        }
                                        setChar(curx, cury, " ");
                                }
                                break;
                        case "P":
                                for(var i = 0; i < val; i++){
                                        for(var j = curx;
                                                j < maxx-1; j++)
                                        {
                                                chars[cury][j].
                                                        innerHTML =
                                                chars[cury][j+1].
                                                        innerHTML;
                                                chars[cury][j].
                                                        style.color =
                                                chars[cury][j+1].
                                                        style.color;
                                                chars[cury][j].style.
                                                        backgroundColor=
                                                chars[cury][j+1].style.
                                                        backgroundColor;
                                                chars[cury][j].style.
                                                        fontWeight =
                                                chars[cury][j+1].style.
                                                        fontWeight;
                                        }
                                        setChar(maxx-1, cury, " ");
                                }
                                break;
                        case "L":
                                newLineAt(cury);
                                break;
                        case "M":
                                removeLineAt(cury);
                                break;
                        case "H":
                        case "f":
                                cury = num[0] ? num[0]-1 : 0;
                                curx = num[1] ? num[1]-1 : 0;
                                if(cury >= maxy) cury = maxy-1;
                                if(curx >= maxx) curx = maxx-1;
                                break;
                        case "J":
                                var i = cury, end = chars.length;
                                var j = curx, line_end = maxx;
                                if(num[0]){
                                        i = 0;
                                        j = 0;
                                }
                                if(num[0] == 1){
                                        end = cury;
                                        line_end = curx-1;
                                }
                                for(; i < end; i++){
                                        for(; j < line_end; j++){
                                                setChar(j, i, " ");
                                        }
                                        j = 0;
                                        line_end = maxx;
                                }
                                break;
                        case "K":
                                var i = curx, end = maxx;
                                if(num[0]) i = 0;
                                if(num[0] == 1) end = curx;
                                for(; i < end; i++){
                                        setChar(i, cury, " ");
                                }
                                break;
                        case "m":
                                for(var i = 0; i < num.length; i++)
                                        process_attrs(
                                                num[i]
                                        );
                                if(num.length == 0)
                                        process_attrs(
                                                0
                                        );
                                break;
                        }
                }
        }
        else if(ch == "\n"){
                cury++;
                if(cury == maxy){
                        newLine();
                        cury--;
                }
        }
        else if(ch == "\r") curx = 0;
        else if(ch == "\b" && curx != 0){
                curx--;
                chars[cury][curx].textContent = " ";
        }
        else if(ch.charCodeAt(0) < 0x20) return;
        else {
                if(curx == maxx){
                        cury++;
                        curx = 0;
                        if(cury == maxy){
                                newLine();
                                cury--;
                        }
                }
                setChar(curx, cury, ch);
                curx++;
        }
}

function newLineAt(line){
        if(!chars[line+1]){
                return;
        }
        var elCurrentLine = chars[line][0].parentElement;
        chars = chars.slice(0, line).concat([[]]).
                concat(chars.slice(line));
        chars.pop();
        var elNewLine = document.createElement("span");
        for(var j = 0; j < maxx; j++){
                var newch =
                        document.createElement("span");
                newch.textContent = "";
                chars[line].push(newch);
                elNewLine.appendChild(newch);
        }
        elTerm.insertBefore(elNewLine, elCurrentLine);
        elTerm.insertBefore(document.createElement("br"),
                elCurrentLine);
        var oldcurx = curx, oldcury = cury;
        cury = line;
        curx = 0;
        putStr("                    ");
        curx = oldcurx;
        cury = oldcury;
        elTerm.removeChild(elTerm.lastChild);
        elTerm.removeChild(elTerm.lastChild);
}

function removeLineAt(line){
        var elCurrentLine = chars[line][0].parentElement;
        chars = chars.slice(0, line).
                concat(chars.slice(line+1, maxy));
        chars.push([]);
        var elNewLine = document.createElement("span");
        for(var j = 0; j < maxx; j++){
                var newch =
                        document.createElement("span");
                newch.textContent = "";
                chars[chars.length-1].push(newch);
                elNewLine.appendChild(newch);
        }
        elTerm.appendChild(elNewLine);
        elTerm.appendChild(document.createElement("br"));
        var oldcurx = curx, oldcury = cury;
        cury = maxy-1;
        curx = 0;
        putStr("                    ");
        curx = oldcurx;
        cury = oldcury;
        elTerm.removeChild(elCurrentLine.nextSibling);
        elTerm.removeChild(elCurrentLine);
}

/* Append a new line to the terminal and rotate if necessary. */
function newLine(){
        chars.push([]);
        if(cury == maxy){
                chars.shift();
        }
        var elNewLine = document.createElement("span");
        for(var j = 0; j < maxx; j++){
                var newch =
                        document.createElement("span");
                newch.textContent = "";
                chars[chars.length-1].push(newch);
                elNewLine.appendChild(newch);
        }
        var oldcurx = curx, oldcury = cury;
        cury = chars.length-1;
        curx = 0;
        putStr("                    ");
        curx = oldcurx;
        cury = oldcury;
        if(cury == maxy){
                elTerm.removeChild(elTerm.firstChild);
                elTerm.removeChild(elTerm.firstChild);
        }
        elTerm.appendChild(elNewLine);
        elTerm.appendChild(document.createElement("br"));
}

function putStr(str){
        for(var i = 0; i < str.length; i++) putChar(str[i]);
}

/* ---------- local shell replacement (was telnetSend/sock.ondata) ---------- */

function backspaceGrid(n){
        for(var i = 0; i < n; i++) putChar("\b");
}

/* В оригинале сервер по telnet-эху сам перерисовывал позицию при смене
   символа группы: backspace + печать нового. Здесь эхо локальное, поэтому
   замена pending-символа — это '\b' (каретка назад) и повторная печать
   в ту же ячейку через putChar (как sock.send в onkeydown оригинала). */
function replacePending(ch){
        if(pendingCh !== null){
                /* putChar('\b'): curx-- и затирка ячейки; затем печать нового
                   символа в ту же позицию — точная модель эха telnet-сервера */
                putChar("\b");
        }
        putChar(ch);
        pendingCh = ch;
}

function redrawInput(){
        /* nothing else uses this; keep API */
}

function commitPending(){
        if(currentKey >= 0){
                pendingCh = null;
                currentKeyIndex = 0;
                currentKey = -1;
                sendTimeoutId && clearTimeout(sendTimeoutId);
                sendTimeoutId = 0;
        }
}

function echoAndSend(ch){
        /* ch is the character that would have gone over telnet */
        if(ch === "\x7f" || ch === "\b"){
                if(inputLine.length > 0){
                        inputLine = inputLine.slice(0, -1);
                        putChar("\b");     /* каретка назад, как \x08 в bash */
                        return;
                }
                return;
        }
        if(ch === "\n"){
                putChar("\n");
                var line = inputLine;
                inputLine = "";
                runCommand(line);
                return;
        }
        if(ch === "\t"){
                putChar("    ");
                inputLine += "    ";
                return;
        }
        if(ch.charCodeAt(0) < 0x20){
                /* other control chars (ctrl-key combos): pass to grid */
                return;
        }
        putChar(ch);
        inputLine += ch;
}

function putPromptIfEmpty(){
        if(inputLine.length === 0 && pendingCh === null){
                putStr(promptText);
        }
}

function runCommand(line){
        var out = "";
        if(commandHandler){
                try { out = commandHandler(line) || ""; }
                catch(e){ out = "error: " + e.message; }
        }
        if(out) putStr(out.replace(/\n/g, "\r\n"));
        putStr(promptText);
}

/* ---------- keyboard handling, exactly as original window.onkeydown ------- */

function onKeydown(e){
        function send(){
                if(control){
                        control = false;
                        echoAndSend(ctrl(keys[currentKey][currentKeyIndex]));
                }
                else {
                        echoAndSend(uc ? keys[currentKey]
                                [currentKeyIndex].toUpperCase()
                                : keys[currentKey][currentKeyIndex]);
                }
                pendingCh = null;
                currentKeyIndex = 0;
                currentKey = -1;
        }
        /* normalize keyCode: KaiOS sometimes gives only keyCode 48..57 */
        var digitNum = -1;
        if(e.keyCode >= 48 && e.keyCode <= 57) digitNum = e.keyCode - 48;
        else if(e.keyCode >= 96 && e.keyCode <= 105) digitNum = e.keyCode - 96;

        if(digitNum >= 0){
                e.preventDefault();
                var num = digitNum;
                if(currentKey == num){
                        currentKeyIndex =
                                (currentKeyIndex + 1) %
                                keys[num].length;
                }
                else {
                        if(currentKey >= 0) send();
                        currentKey = num;
                        currentKeyIndex = 0;
                }
                /* символ виден МГНОВЕННО; повторные нажатия заменяют его на
                   месте через backspace — ровно как telnetSend + эхо сервера
                   в оригинальном app.js */
                var sel = uc ? keys[num][currentKeyIndex].toUpperCase()
                        : keys[num][currentKeyIndex];
                replacePending(sel);
                sendTimeoutId && clearTimeout(sendTimeoutId);
                sendTimeoutId = setTimeout(function(){
                        if(currentKey >= 0){
                                pendingCh = null;   /* уже напечатан — просто закрываем группу */
                                currentKey = -1;
                                currentKeyIndex = 0;
                                sendTimeoutId = 0;
                        }
                }, 1000);
                return;
        }
        if(e.key == "Backspace" || e.keyCode === 8){
                e.preventDefault();
                if(currentKey >= 0){
                        /* User was typing something, clear it */
                        sendTimeoutId && clearTimeout(sendTimeoutId);
                        sendTimeoutId = 0;
                        if(pendingCh !== null){
                                putChar("\b");
                                pendingCh = null;
                        }
                        currentKeyIndex = 0;
                        currentKey = -1;
                }
                else echoAndSend("\b");
                return;
        }
        if(e.key == "Enter" || e.keyCode === 13 || e.keyCode === 23){
                e.preventDefault();
                if(currentKey >= 0){
                        /* символ уже напечатан в сетке — просто закрываем группу,
                           в inputLine pending НЕ входит (он ещё не «отправлен») */
                        sendTimeoutId && clearTimeout(sendTimeoutId);
                        sendTimeoutId = 0;
                        if(pendingCh !== null){
                                /* pending ещё не в inputLine: добавляем как отправленный */
                                inputLine += pendingCh;
                                pendingCh = null;
                        }
                        currentKey = -1;
                        currentKeyIndex = 0;
                }
                echoAndSend("\n");
                return;
        }
        if(e.key == "Call"){
                /* Toggle control */
                if(currentKey >= 0) send();
                control = !control;
                return;
        }
        if(e.key == "SoftLeft"){
                /* Tab */
                if(currentKey >= 0) send();
                echoAndSend("\t");
                return;
        }
        if(e.key == "#" || e.keyCode === 35){
                /* Toggle uppercase */
                if(currentKey >= 0){
                        /* меняем регистр прямо на месте: затереть pending,
                           напечатать верхний регистр той же позиции */
                        if(pendingCh !== null){
                                var pc = uc ? pendingCh.toUpperCase() : pendingCh.toLowerCase();
                                putChar("\b");
                                putChar(pc);
                                pendingCh = pc;
                        }
                        else { inputLine += pendingCh; send(); }
                }
                uc = !uc;
                return;
        }
        if(/Arrow.*/.test(e.key)){
                if(currentKey >= 0) send();
                /* v0.2.69: локальная shell-замена ANSI-стрелок оригинала —
                   хост (KaDOS main.js) листает историю команд через
                   terminalHistoryMove и сам перерисовывает строку ввода */
                if(historyCb){
                        historyCb(e.key);
                        e.preventDefault();
                }
                return;
        }
        if(e.key == "Back" || e.key == "Escape" || e.keyCode === 27 ||
                e.keyCode === 17 || e.key == "SoftRight"){
                if(closeCb) closeCb();
                return;
        }
        /* physical keyboard letters (emulators/desktop test) */
        if(e.key && e.key.length === 1 && /[a-zA-Z !"#$%&'()*+,\-.\/:;=?@[\]^_`{|}~<>]/.test(e.key)){
                e.preventDefault();
                if(currentKey >= 0){
                        if(pendingCh !== null){ inputLine += pendingCh; pendingCh = null; }
                        currentKey = -1; currentKeyIndex = 0;
                        sendTimeoutId && clearTimeout(sendTimeoutId);
                        sendTimeoutId = 0;
                }
                echoAndSend(e.key);
                return;
        }
}

/* --------------------------- public API ---------------------------------- */

window.Terminal = {
        init: function(opts){
                opts = opts || {};
                elTerm = document.getElementById(opts.elementId || "term-text");
                if(!elTerm) throw new Error("Terminal element not found");
                elTerm.style.backgroundColor = bgColor;
                commandHandler = opts.commandHandler || null;
                closeCb = opts.onClose || null;
                historyCb = opts.onHistory || null;
                if(!started){
                        for(var i = 0; i < maxy; i++) newLine();
                        started = true;
                }
        },
        open: function(){
                document.addEventListener("keydown", onKeydown, true);
                /* v0.2.69: очистка состояния ввода при открытии (было только
                   в close() — а host KaDOS закрытие делает через closeTerminal(),
                   который эту функцию не вызывает; из-за этого inputLine мог
                   остаться с прошлого сеанса) */
                commitPending();
                sendTimeoutId && clearTimeout(sendTimeoutId);
                sendTimeoutId = 0;
                pendingCh = null;
                inputLine = "";
                control = false; uc = false;
                /* fresh prompt line */
                putStr("\r\n" + promptText);
        },
        close: function(){
                document.removeEventListener("keydown", onKeydown, true);
                commitPending();
                sendTimeoutId && clearTimeout(sendTimeoutId);
                sendTimeoutId = 0;
                pendingCh = null;
                inputLine = "";
        },
        /* v0.2.68: точка входа для host-приложения (KaDOS). Возвращает true,
           если событие обработано движком. В отличие от оригинала, где
           keydown слушался всегда, здесь ввод активен только когда терминал
           открыт (host вызывает handleKey из своего window-keydown capture). */
        handleKey: function(e){
                if(!started) return false;
                onKeydown(e);
                return true;
        },
        write: function(str){
                putStr(str);
        },
        reset: function(){
                /* clear screen */
                elTerm.innerHTML = "";
                chars = [];
                curx = 0; cury = 0;
                for(var i = 0; i < maxy; i++) newLine();
        },
        putStr: putStr,
        /* v0.2.68: каретка движка (для визуального '_' в host-приложении) */
        getCursor: function(){ return { x: curx, y: cury }; },
        cellAt: function(x, y){
                if(!chars[y] || !chars[y][x]) return null;
                return chars[y][x];
        },
        /* v0.2.68: затирка ячейки ПЕРЕД кареткой (curx-- + пробел).
           В оригинале telnet-сервер сам присылал "\b \b"; локальному
           shell'у KaDOS нужна явная затирка для multi-tap замены и
           backspace — иначе старый символ остаётся под новым. */
        eraseBack: function(){
                if(curx > 0) curx--;
                setChar(curx, cury, " ", textattrs);
        }
};
})();
