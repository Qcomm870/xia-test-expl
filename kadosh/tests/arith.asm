; арифметика + вывод числа побайтно через INT 21h AH=02h
CLD
MOV BX, 0
loop1:
ADD BL, 1
CMP BL, 3
JNE cont
MOV AH, 02h
MOV DL, 'X'
INT 21h
MOV AH, 02h
MOV DL, '!'
INT 21h
MOV AH, 4Ch
INT 21h
cont:
CMP BL, 2
JNE loop1
MOV AH, 02h
MOV DL, '*'
INT 21h
JMP loop1
