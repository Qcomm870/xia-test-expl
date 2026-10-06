#ifndef CPU_H
#define CPU_H
#include <stdint.h>

/* флаги */
#define F_CF 0x0001
#define F_PF 0x0004
#define F_AF 0x0010
#define F_ZF 0x0040
#define F_SF 0x0080
#define F_TF 0x0100
#define F_IF 0x0200
#define F_DF 0x0400
#define F_OF 0x0800

typedef struct {
    union { uint16_t ax; struct { uint8_t al, ah; }; };
    union { uint16_t cx; struct { uint8_t cl, ch; }; };
    union { uint16_t dx; struct { uint8_t dl, dh; }; };
    union { uint16_t bx; struct { uint8_t bl, bh; }; };
    uint16_t sp,bp;
    union { uint16_t si; struct { uint8_t sil, sih; }; };
    union { uint16_t di; struct { uint8_t dil, dih; }; };
    uint16_t cs,ds,ss,es;
    uint16_t ip;
    uint16_t flags;
    int halted;
    int stopped;          /* INT 21h AH=4Ch — программа завершилась */
} regs_t;

extern regs_t R;

/* 8-битные части регистров (индекс: 0=AL 1=AH 2=CL 3=CH 4=DL 5=DH 6=BL 7=BH) */
#define REG8(i) ((i)==0?R.al:(i)==1?R.ah:(i)==2?R.cl:(i)==3?R.ch: \
                 (i)==4?R.dl:(i)==5?R.dh:(i)==6?R.bl:(i)==7?R.bh:0)
static inline void set_reg8(int i, uint8_t v){
    switch(i){case 0:R.al=v;break;case 1:R.ah=v;break;case 2:R.cl=v;break;case 3:R.ch=v;break;
    case 4:R.dl=v;break;case 5:R.dh=v;break;case 6:R.bl=v;break;case 7:R.bh=v;break;}
}
static inline uint16_t get_reg16(int i){
    switch(i){case 0:return R.ax;case 1:return R.cx;case 2:return R.dx;case 3:return R.bx;
    case 4:return R.sp;case 5:return R.bp;case 6:return R.si;case 7:return R.di;default:return 0;}
}
static inline void set_reg16(int i, uint16_t v){
    switch(i){case 0:R.ax=v;break;case 1:R.cx=v;break;case 2:R.dx=v;break;case 3:R.bx=v;break;
    case 4:R.sp=v;break;case 5:R.bp=v;break;case 6:R.si=v;break;case 7:R.di=v;break;}
}
static inline uint16_t get_seg(int i){
    switch(i){case 0:return R.es;case 1:return R.cs;case 2:return R.ss;default:return R.ds;}
}
static inline void set_seg(int i, uint16_t v){
    switch(i){case 0:R.es=v;break;case 1:R.cs=v;break;case 2:R.ss=v;break;case 3:R.ds=v;break;}
}

extern regs_t R;

void cpu_reset(void);
/* выполнить одну инструкцию; возвращает 0 ok, !=0 код остановки */
int  cpu_step(void);
uint32_t la(uint16_t seg, uint16_t off);

/* хуки BIOS/DOS (реализованы в bios.c / dos.c) */
int hook_int(uint8_t num);   /* 1 = обработано хуком, 0 = идти в таблицу IVT */

#endif
