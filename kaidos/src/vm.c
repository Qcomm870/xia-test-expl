/* Каркас x86 real-mode интерпретатора. НЕ покрывает Fallout 2. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MEM_SIZE (1024*1024)          /* 1 МБ real-mode памяти */
uint8_t mem[MEM_SIZE];

struct regs { uint16_t ax,bx,cx,dx,si,di,bp,sp,ip,flags,cs,ds,ss,es; };
static struct regs r;

/* перемещение сегмент:смещение в линейный адрес */
static uint32_t la(uint16_t seg, uint16_t off){ return ((uint32_t)seg<<4)+off; }

int vm_load_com(const uint8_t *img, int len){
    if(len > MEM_SIZE-0x100) return -1;
    memcpy(mem+0x100, img, len);
    memset(&r,0,sizeof r);
    r.sp = r.ip = 0x100;              /* COM-файл: CS=DS=SS, IP=0x100 */
    return 0;
}

void vm_step(void){
    uint32_t p = la(r.cs, r.ip);
    uint8_t op = mem[p & (MEM_SIZE-1)];
    switch(op){
        case 0x90: r.ip++; break;                     /* NOP */
        case 0xEB: r.ip += 2 + (int8_t)mem[(p+1)&(MEM_SIZE-1)]; break; /* jmp short */
        case 0xE9: { int16_t d=*(int16_t*)&mem[(p+1)&(MEM_SIZE-1)]; r.ip+=3+d; } break;
        case 0xB0 ... 0xB7: {                          /* mov r8, imm8 */
            uint8_t v = mem[(p+1)&(MEM_SIZE-1)];
            uint16_t *reg = (uint16_t*)&r;             /* грубо: AL..BH через ax..di */
            ((uint8_t*)reg)[op-0xB0] = v; r.ip+=2; } break;
        case 0xCD: {                                   /* INT n */
            uint8_t n = mem[(p+1)&(MEM_SIZE-1)]; r.ip+=2;
            extern void dos_int(uint8_t num, struct regs *R);
            dos_int(n,&r); } break;
        case 0xF4: r.flags |= 1; break;                /* hlt -> "стоп" */
        default: r.ip++;                               /* неизвестно — пропускаем */
    }
}

uint16_t vm_get_cs_ip(void){ return r.ip; }
uint8_t *vm_mem(void){ return mem; }
