; hello world через INT 21h AH=09h
MOV DX, msg
MOV AH, 09h
INT 21h
MOV AH, 4Ch
INT 21h
msg: DB 'KADOSH: Fallout not here yet, but CPU works!$'
