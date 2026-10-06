/* KADOSH cpu.c — интерпретатор x86 real mode.
 * Покрывает набор инструкций, достаточный для COM-программ эпохи DOS 1980-х:
 * арифметика/логика с флагами, modrm-адресация, все условные переходы,
 * строковые ops c rep-префиксами, mul/div/idiv, pusha/popa, enter/leave,
 * int/iret, hlt и т.д.
 */
#include "cpu.h"
#include "mem.h"
#include <string.h>
#include <stdio.h>

regs_t R;

uint32_t la(uint16_t seg, uint16_t off){ return (((uint32_t)seg)<<4) + off; }

void cpu_reset(void){
    memset(&R,0,sizeof R);
    R.flags = F_IF | F_ZF;
    R.sp = 0xFFFE;
}

static uint8_t fetch8(void){ uint8_t v = mem_read8(la(R.cs,R.ip)); R.ip++; return v; }
static uint16_t fetch16(void){ uint16_t v = mem_read16(la(R.cs,R.ip)); R.ip+=2; return v; }

static void set_pf(uint8_t v){
    int bits=0; for(int i=0;i<8;i++) if(v&(1<<i)) bits++;
    R.flags = (R.flags & ~F_PF) | ((bits&1)?0:F_PF);
}
static void sz8(uint8_t r){ R.flags=(R.flags&~(F_ZF|F_SF))|((r==0)?F_ZF:0)|((r&0x80)?F_SF:0); set_pf(r); }
static void sz16(uint16_t r){ R.flags=(R.flags&~(F_ZF|F_SF))|((r==0)?F_ZF:0)|((r&0x8000)?F_SF:0); set_pf((uint8_t)(r^(r>>8))); }

#define TESTF(f) ((R.flags&(f))!=0)

static void push16(uint16_t v){ R.sp-=2; mem_write16(la(R.ss,R.sp),v); }
static uint16_t pop16(void){ uint16_t v=mem_read16(la(R.ss,R.sp)); R.sp+=2; return v; }

typedef struct { int mod,reg,rm; uint16_t ea; int has_mem; } rm_t;

static rm_t decode_rm(void){
    rm_t x; uint8_t b=fetch8();
    x.mod=b>>6; x.reg=(b>>3)&7; x.rm=b&7; x.has_mem=0; x.ea=0;
    if(x.mod==3) return x;
    x.has_mem=1;
    if(x.mod==0 && x.rm==6){ x.ea=fetch16(); return x; } /* [disp16] */
    switch(x.rm){
        case 0: x.ea=(uint16_t)(R.bx+R.si); break;
        case 1: x.ea=(uint16_t)(R.bx+R.di); break;
        case 2: x.ea=(uint16_t)(R.bp+R.si); break;
        case 3: x.ea=(uint16_t)(R.bp+R.di); break;
        case 4: x.ea=R.si; break;
        case 5: x.ea=R.di; break;
        case 6: x.ea=R.bp; break;
        case 7: x.ea=R.bx; break;
    }
    if(x.mod==1) x.ea=(uint16_t)(x.ea+(int8_t)fetch8());
    if(x.mod==2) x.ea=(uint16_t)(x.ea+fetch16());
    return x;
}

static uint32_t rm_linear(rm_t *x){
    if(!x->has_mem) return 0;
    uint16_t seg = R.ds;
    int bp_based = (x->mod==0 && (x->rm==2||x->rm==3)) ||
                   (x->mod!=0 && (x->rm==2||x->rm==3||x->rm==6&&x->mod==0));
    if(x->mod!=0 && (x->rm==2||x->rm==3)) bp_based=1;
    if(bp_based) seg=R.ss;
    return la(seg,x->ea);
}

static uint8_t  read_rm8(rm_t*x){ if(!x->has_mem) return REG8(x->rm); return mem_read8(rm_linear(x)); }
static uint16_t read_rm16(rm_t*x){ if(!x->has_mem) return get_reg16(x->rm); return mem_read16(rm_linear(x)); }
static void write_rm8(rm_t*x,uint8_t v){ if(!x->has_mem){set_reg8(x->rm,v);return;} mem_write8(rm_linear(x),v); }
static void write_rm16(rm_t*x,uint16_t v){ if(!x->has_mem){set_reg16(x->rm,v);return;} mem_write16(rm_linear(x),v); }

static const int rfmap[8]={0,2,4,6,1,3,5,7}; /* reg field 8bit -> our index */
static uint8_t get_rf8(int rf){ return REG8(rfmap[rf]); }
static void set_rf8(int rf,uint8_t v){ set_reg8(rfmap[rf],v); }

static uint8_t op_add8(uint8_t a,uint8_t b){
    uint16_t s=a+b;
    R.flags&=~(F_CF|F_AF|F_OF);
    if(s>0xFF) R.flags|=F_CF;
    if(((a&0xF)+(b&0xF))>0xF) R.flags|=F_AF;
    if((~(a^b)&(a^(uint8_t)s))&0x80) R.flags|=F_OF;
    sz8((uint8_t)s);
    return (uint8_t)s;
}
static uint16_t op_add16(uint16_t a,uint16_t b){
    uint32_t s=a+b;
    R.flags&=~(F_CF|F_AF|F_OF);
    if(s>0xFFFF) R.flags|=F_CF;
    if(((a&0xF)+(b&0xF))>0xF) R.flags|=F_AF;
    if((~(a^b)&(a^(uint16_t)s))&0x8000) R.flags|=F_OF;
    sz16((uint16_t)s);
    return (uint16_t)s;
}
static uint8_t op_sub8(uint8_t a,uint8_t b){
    uint16_t s=(uint16_t)a-(uint16_t)b;
    R.flags&=~(F_CF|F_AF|F_OF);
    if(a<b) R.flags|=F_CF;
    if((a&0xF)<(b&0xF)) R.flags|=F_AF;
    if(((a^b)&(a^(uint8_t)s))&0x80) R.flags|=F_OF;
    sz8((uint8_t)s);
    return (uint8_t)s;
}
static uint16_t op_sub16(uint16_t a,uint16_t b){
    uint32_t s=(uint32_t)a-(uint32_t)b;
    R.flags&=~(F_CF|F_AF|F_OF);
    if(a<b) R.flags|=F_CF;
    if((a&0xF)<(b&0xF)) R.flags|=F_AF;
    if(((a^b)&(a^(uint16_t)s))&0x8000) R.flags|=F_OF;
    sz16((uint16_t)s);
    return (uint16_t)s;
}
static uint8_t op_adc8(uint8_t a,uint8_t b){ uint16_t cf=R.flags&F_CF; return op_add8(op_add8(a,b),(uint8_t)cf); }
static uint16_t op_adc16(uint16_t a,uint16_t b){ uint16_t cf=R.flags&F_CF; return op_add16(op_add16(a,b),cf); }
static uint8_t op_sbb8(uint8_t a,uint8_t b){ uint16_t cf=R.flags&F_CF; return op_sub8(a,(uint8_t)(b+cf)); }
static uint16_t op_sbb16(uint16_t a,uint16_t b){ uint16_t cf=R.flags&F_CF; return op_sub16(a,(uint16_t)(b+cf)); }

static uint8_t op_and8(uint8_t a,uint8_t b){ uint8_t r=a&b; R.flags&=~(F_CF|F_OF|F_AF); sz8(r); return r; }
static uint16_t op_and16(uint16_t a,uint16_t b){ uint16_t r=a&b; R.flags&=~(F_CF|F_OF|F_AF); sz16(r); return r; }
static uint8_t op_or8(uint8_t a,uint8_t b){ uint8_t r=a|b; R.flags&=~(F_CF|F_OF|F_AF); sz8(r); return r; }
static uint16_t op_or16(uint16_t a,uint16_t b){ uint16_t r=a|b; R.flags&=~(F_CF|F_OF|F_AF); sz16(r); return r; }
static uint8_t op_xor8(uint8_t a,uint8_t b){ uint8_t r=a^b; R.flags&=~(F_CF|F_OF|F_AF); sz8(r); return r; }
static uint16_t op_xor16(uint16_t a,uint16_t b){ uint16_t r=a^b; R.flags&=~(F_CF|F_OF|F_AF); sz16(r); return r; }

static uint8_t op_inc8(uint8_t a){ uint16_t cf=R.flags&F_CF; uint8_t r=op_add8(a,1); R.flags=(R.flags&~F_CF)|cf; return r; }
static uint16_t op_inc16(uint16_t a){ uint16_t cf=R.flags&F_CF; uint16_t r=op_add16(a,1); R.flags=(R.flags&~F_CF)|cf; return r; }
static uint8_t op_dec8(uint8_t a){ uint16_t cf=R.flags&F_CF; uint8_t r=op_sub8(a,1); R.flags=(R.flags&~F_CF)|cf; return r; }
static uint16_t op_dec16(uint16_t a){ uint16_t cf=R.flags&F_CF; uint16_t r=op_sub16(a,1); R.flags=(R.flags&~F_CF)|cf; return r; }
static uint8_t op_neg8(uint8_t a){ R.flags&=~(F_CF|F_AF|F_OF); if(a)R.flags|=F_CF; if((a&0xF)!=0)R.flags|=F_AF; if(a==0x80)R.flags|=F_OF; uint8_t r=(uint8_t)(0-a); sz8(r); return r; }
static uint16_t op_neg16(uint16_t a){ R.flags&=~(F_CF|F_AF|F_OF); if(a)R.flags|=F_CF; if((a&0xF)!=0)R.flags|=F_AF; if(a==0x8000)R.flags|=F_OF; uint16_t r=(uint16_t)(0-a); sz16(r); return r; }
static uint8_t op_not8(uint8_t a){ return (uint8_t)~a; }
static uint16_t op_not16(uint16_t a){ return (uint16_t)~a; }
static void op_test8(uint8_t a,uint8_t b){ uint8_t r=a&b; R.flags&=~(F_CF|F_OF|F_AF); sz8(r); }
static void op_test16(uint16_t a,uint16_t b){ uint16_t r=a&b; R.flags&=~(F_CF|F_OF|F_AF); sz16(r); }

static void shl8(uint8_t*v,int n){ for(;n>0;n--){ int c=*v&0x80; *v=(uint8_t)(*v<<1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} if(n==0&&(*v&0x80)){/*cf last*/} sz8(*v); }
static void shr8(uint8_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint8_t)(*v>>1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz8(*v); }
static void sar8(uint8_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint8_t)(((int8_t)*v)>>1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz8(*v); }
static void rol8(uint8_t*v,int n){ for(;n>0;n--){ int c=*v&0x80; *v=(uint8_t)((*v<<1)|(c?1:0)); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz8(*v); }
static void ror8(uint8_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint8_t)((*v>>1)|(c?0x80:0)); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz8(*v); }
static void shl16(uint16_t*v,int n){ for(;n>0;n--){ int c=*v&0x8000; *v=(uint16_t)(*v<<1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz16(*v); }
static void shr16(uint16_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint16_t)(*v>>1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz16(*v); }
static void sar16(uint16_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint16_t)(((int16_t)*v)>>1); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz16(*v); }
static void rol16(uint16_t*v,int n){ for(;n>0;n--){ int c=*v&0x8000; *v=(uint16_t)((*v<<1)|(c?1:0)); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz16(*v); }
static void ror16(uint16_t*v,int n){ for(;n>0;n--){ int c=*v&1; *v=(uint16_t)((*v>>1)|(c?0x8000:0)); R.flags=(R.flags&~F_CF)|(c?F_CF:0);} sz16(*v); }

extern int hook_int(uint8_t num);
static void do_int(uint8_t n){
    push16(R.flags); push16(R.cs); push16(R.ip);
    R.flags &= ~(F_TF|F_IF);
    if(hook_int(n)) return;
    uint32_t ivt = (uint32_t)n*4;
    R.ip = mem_read16(ivt+0);
    R.cs = mem_read16(ivt+2);
}

static int cond_taken(uint8_t op){
    switch(op){
        case 0x70: return TESTF(F_OF);
        case 0x71: return !TESTF(F_OF);
        case 0x72: return TESTF(F_CF);
        case 0x73: return !TESTF(F_CF);
        case 0x74: return TESTF(F_ZF);
        case 0x75: return !TESTF(F_ZF);
        case 0x76: return TESTF(F_CF)||TESTF(F_ZF);
        case 0x77: return !(TESTF(F_CF)||TESTF(F_ZF));
        case 0x78: return TESTF(F_SF);
        case 0x79: return !TESTF(F_SF);
        case 0x7A: return TESTF(F_PF);
        case 0x7B: return !TESTF(F_PF);
        case 0x7C: return TESTF(F_SF)!=TESTF(F_OF);
        case 0x7D: return TESTF(F_SF)==TESTF(F_OF);
        case 0x7E: return TESTF(F_ZF)||TESTF(F_SF)!=TESTF(F_OF);
        case 0x7F: return !TESTF(F_ZF)&&TESTF(F_SF)==TESTF(F_OF);
    }
    return 0;
}

/* rep-состояние: 0 none, 1 REPE/REPZ (F3), 2 REPNE (F2) */
static int rep_mode=0;

static void string_op(uint8_t op){
    int wide=(op==0xA5||op==0xA7||op==0xAF||op==0xA9||op==0xAB||op==0xAD);
    int st=(R.flags&F_DF)?(-wide):(wide);
    uint16_t cnt = rep_mode ? R.cx : 1;
    while(cnt){
        uint32_t dsi=la(R.ds,R.si), edi=la(R.es,R.di);
        int stop=0;
        switch(op){
            case 0xA4: mem_write8(edi,mem_read8(dsi)); break;
            case 0xA5: mem_write16(edi,mem_read16(dsi)); break;
            case 0xA6: op_sub8(mem_read8(dsi),mem_read8(edi)); if(rep_mode==1)stop=!TESTF(F_ZF); if(rep_mode==2)stop=TESTF(F_ZF); break;
            case 0xA7: op_sub16(mem_read16(dsi),mem_read16(edi)); if(rep_mode==1)stop=!TESTF(F_ZF); if(rep_mode==2)stop=TESTF(F_ZF); break;
            case 0xAA: mem_write8(edi,R.al); break;
            case 0xAB: mem_write16(edi,R.ax); break;
            case 0xAC: R.al=mem_read8(dsi); break;
            case 0xAD: R.ax=mem_read16(dsi); break;
            case 0xAE: op_sub8(R.al,mem_read8(edi)); if(rep_mode==1)stop=!TESTF(F_ZF); if(rep_mode==2)stop=TESTF(F_ZF); break;
            case 0xAF: op_sub16(R.ax,mem_read16(edi)); if(rep_mode==1)stop=!TESTF(F_ZF); if(rep_mode==2)stop=TESTF(F_ZF); break;
        }
        if(op>=0xA4&&op<=0xA7){ R.si=(uint16_t)(R.si+st); R.di=(uint16_t)(R.di+st); }
        else if(op>=0xAC&&op<=0xAD){ R.si=(uint16_t)(R.si+st); }
        else { R.di=(uint16_t)(R.di+st); }
        if(rep_mode){ R.cx--; cnt=R.cx; if(stop) cnt=0; }
        else cnt=0;
    }
    rep_mode=0;
}

int cpu_step(void){
    if(R.stopped) return 1;
    if(R.halted) return 0;
    rep_mode=0;
    uint8_t op=fetch8();

    if(op==0xF2||op==0xF3){ rep_mode=(op==0xF3)?1:2; op=fetch8();
        /* rep имеет смысл только со строковыми ops; иначе игнорируем */
        if(!(op>=0xA4&&op<=0xAF)) rep_mode=0;
    }

    switch(op){
    case 0xB0 ... 0xB7: set_reg8(op-0xB0, fetch8()); break;
    case 0xB8 ... 0xBF: set_reg16(op-0xB8, fetch16()); break;
    case 0xC6:{ rm_t m=decode_rm(); write_rm8(&m,fetch8()); } break;
    case 0xC7:{ rm_t m=decode_rm(); write_rm16(&m,fetch16()); } break;
    case 0x88:{ rm_t m=decode_rm(); write_rm8(&m,get_rf8(m.reg)); } break;
    case 0x89:{ rm_t m=decode_rm(); write_rm16(&m,get_reg16(m.reg)); } break;
    case 0x8A:{ rm_t m=decode_rm(); set_rf8(m.reg,read_rm8(&m)); } break;
    case 0x8B:{ rm_t m=decode_rm(); set_reg16(m.reg,read_rm16(&m)); } break;
    case 0xA0: R.al=mem_read8(la(R.ds,fetch16())); break;
    case 0xA1: R.ax=mem_read16(la(R.ds,fetch16())); break;
    case 0xA2: mem_write8(la(R.ds,fetch16()),R.al); break;
    case 0xA3: mem_write16(la(R.ds,fetch16()),R.ax); break;
    case 0x8C:{ rm_t m=decode_rm(); write_rm16(&m,get_seg(m.reg&3)); } break;
    case 0x8E:{ rm_t m=decode_rm(); set_seg(m.reg&3,read_rm16(&m)); } break;
    case 0x8D:{ rm_t m=decode_rm(); set_reg16(m.reg, (uint16_t)m.ea); } break; /* lea offset */

    case 0x50 ... 0x57: push16(get_reg16(op-0x50)); break;
    case 0x58 ... 0x5F: set_reg16(op-0x58,pop16()); break;
    case 0x06: push16(R.es); break;
    case 0x07: R.es=pop16(); break;
    case 0x0E: push16(R.cs); break;
    case 0x1F: R.ds=pop16(); break;
    case 0x16: push16(R.ss); break;
    case 0x17: R.ss=pop16(); break;
    case 0x60:{ uint16_t t=R.sp; push16(R.ax);push16(R.cx);push16(R.dx);push16(R.bx);
                push16(t);push16(R.bp);push16(R.si);push16(R.di); } break;
    case 0x61:{ R.di=pop16();R.si=pop16();R.bp=pop16();pop16();R.sp=pop16();
                R.bx=pop16();R.dx=pop16();R.cx=pop16();R.ax=pop16(); } break;

    case 0x00:{ rm_t m=decode_rm(); write_rm8(&m,op_add8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x01:{ rm_t m=decode_rm(); write_rm16(&m,op_add16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x02:{ rm_t m=decode_rm(); set_rf8(m.reg,op_add8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x03:{ rm_t m=decode_rm(); set_reg16(m.reg,op_add16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x04: R.al=op_add8(R.al,fetch8()); break;
    case 0x05: R.ax=op_add16(R.ax,fetch16()); break;
    case 0x08:{ rm_t m=decode_rm(); write_rm8(&m,op_or8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x09:{ rm_t m=decode_rm(); write_rm16(&m,op_or16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x0A:{ rm_t m=decode_rm(); set_rf8(m.reg,op_or8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x0B:{ rm_t m=decode_rm(); set_reg16(m.reg,op_or16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x0C: R.al=op_or8(R.al,fetch8()); break;
    case 0x0D: R.ax=op_or16(R.ax,fetch16()); break;
    case 0x10:{ rm_t m=decode_rm(); write_rm8(&m,op_adc8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x11:{ rm_t m=decode_rm(); write_rm16(&m,op_adc16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x12:{ rm_t m=decode_rm(); set_rf8(m.reg,op_adc8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x13:{ rm_t m=decode_rm(); set_reg16(m.reg,op_adc16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x14: R.al=op_adc8(R.al,fetch8()); break;
    case 0x15: R.ax=op_adc16(R.ax,fetch16()); break;
    case 0x18:{ rm_t m=decode_rm(); write_rm8(&m,op_sbb8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x19:{ rm_t m=decode_rm(); write_rm16(&m,op_sbb16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x1A:{ rm_t m=decode_rm(); set_rf8(m.reg,op_sbb8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x1B:{ rm_t m=decode_rm(); set_reg16(m.reg,op_sbb16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x1C: R.al=op_sbb8(R.al,fetch8()); break;
    case 0x1D: R.ax=op_sbb16(R.ax,fetch16()); break;
    case 0x20:{ rm_t m=decode_rm(); write_rm8(&m,op_and8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x21:{ rm_t m=decode_rm(); write_rm16(&m,op_and16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x22:{ rm_t m=decode_rm(); set_rf8(m.reg,op_and8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x23:{ rm_t m=decode_rm(); set_reg16(m.reg,op_and16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x24: R.al=op_and8(R.al,fetch8()); break;
    case 0x25: R.ax=op_and16(R.ax,fetch16()); break;
    case 0x28:{ rm_t m=decode_rm(); write_rm8(&m,op_sub8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x29:{ rm_t m=decode_rm(); write_rm16(&m,op_sub16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x2A:{ rm_t m=decode_rm(); set_rf8(m.reg,op_sub8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x2B:{ rm_t m=decode_rm(); set_reg16(m.reg,op_sub16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x2C: R.al=op_sub8(R.al,fetch8()); break;
    case 0x2D: R.ax=op_sub16(R.ax,fetch16()); break;
    case 0x30:{ rm_t m=decode_rm(); write_rm8(&m,op_xor8(read_rm8(&m),get_rf8(m.reg))); } break;
    case 0x31:{ rm_t m=decode_rm(); write_rm16(&m,op_xor16(read_rm16(&m),get_reg16(m.reg))); } break;
    case 0x32:{ rm_t m=decode_rm(); set_rf8(m.reg,op_xor8(get_rf8(m.reg),read_rm8(&m))); } break;
    case 0x33:{ rm_t m=decode_rm(); set_reg16(m.reg,op_xor16(get_reg16(m.reg),read_rm16(&m))); } break;
    case 0x34: R.al=op_xor8(R.al,fetch8()); break;
    case 0x35: R.ax=op_xor16(R.ax,fetch16()); break;
    case 0x38:{ rm_t m=decode_rm(); op_test8(read_rm8(&m),get_rf8(m.reg)); } break;
    case 0x39:{ rm_t m=decode_rm(); op_test16(read_rm16(&m),get_reg16(m.reg)); } break;
    case 0x3A:{ rm_t m=decode_rm(); op_test8(get_rf8(m.reg),read_rm8(&m)); } break;
    case 0x3B:{ rm_t m=decode_rm(); op_test16(get_reg16(m.reg),read_rm16(&m)); } break;
    case 0x3C: op_test8(R.al,fetch8()); break;
    case 0x3D: op_test16(R.ax,fetch16()); break;

    case 0x3E: R.flags&=~F_CF; break; /* не опкод, но не используем */

    case 0x40 ... 0x47: set_reg16(op-0x40,op_inc16(get_reg16(op-0x40))); break;
    case 0x48 ... 0x4F: set_reg16(op-0x48,op_dec16(get_reg16(op-0x48))); break;

    case 0x70 ... 0x7F:{ int8_t d=(int8_t)fetch8(); if(cond_taken(op)) R.ip=(uint16_t)(R.ip+d); } break;
    case 0x90: break;
    case 0xEB:{ int8_t d=(int8_t)fetch8(); R.ip=(uint16_t)(R.ip+d); } break;
    case 0xE9:{ int16_t d=(int16_t)fetch16(); R.ip=(uint16_t)(R.ip+d); } break;
    case 0xE8:{ int16_t d=(int16_t)fetch16(); push16(R.ip); R.ip=(uint16_t)(R.ip+d); } break;
    case 0xEA:{ uint16_t off=fetch16(); uint16_t seg=fetch16(); R.cs=seg; R.ip=off; } break;
    case 0x9A:{ uint16_t off=fetch16(); uint16_t seg=fetch16(); push16(R.cs);push16(R.ip); R.cs=seg;R.ip=off; } break;
    case 0xCB:{ pop16(); pop16(); R.sp=(uint16_t)(R.sp+fetch16()); } break;
    case 0xCA:{ pop16(); pop16(); /* retf imm: освободить args от вызывающего — упрощённо */ } break;
    case 0xC2:{ R.ip=pop16(); R.sp=(uint16_t)(R.sp+fetch16()); } break;
    case 0xC3: R.ip=pop16(); break;
    case 0xDB:{ rm_t m=decode_rm(); uint32_t lin=rm_linear(&m); push16(R.cs);push16(R.ip); R.ip=mem_read16(lin);R.cs=mem_read16(lin+2);} break;
    case 0xCF: R.ip=pop16(); R.cs=pop16(); R.flags=pop16(); break;

    case 0xE0:{ int8_t d=(int8_t)fetch8(); R.cx--; if(R.cx && !TESTF(F_ZF)) R.ip=(uint16_t)(R.ip+d); } break;
    case 0xE1:{ int8_t d=(int8_t)fetch8(); R.cx--; if(R.cx && TESTF(F_ZF)) R.ip=(uint16_t)(R.ip+d); } break;
    case 0xE2:{ int8_t d=(int8_t)fetch8(); R.cx--; if(R.cx) R.ip=(uint16_t)(R.ip+d); } break;
    case 0xE3:{ int8_t d=(int8_t)fetch8(); if(R.cx==0) R.ip=(uint16_t)(R.ip+d); } break;

    case 0xF8: R.flags&=~F_CF; break;
    case 0xF9: R.flags|=F_CF; break;
    case 0xFA: R.flags&=~F_IF; break;
    case 0xFB: R.flags|=F_IF; break;
    case 0xFC: R.flags&=~F_DF; break;
    case 0xFD: R.flags|=F_DF; break;
    case 0xF5: R.flags^=F_CF; break;
    case 0x9C: push16(R.flags|2); break;
    case 0x9D: R.flags=pop16(); break;

    case 0xCD:{ uint8_t n=fetch8(); do_int(n); } break;
    case 0xCC: do_int(3); break;

    case 0xA4: case 0xA5: case 0xA6: case 0xA7:
    case 0xAA: case 0xAB: case 0xAC: case 0xAD:
    case 0xAE: case 0xAF:
        string_op(op); break;
    case 0xA8: op_sub8(R.al,fetch8()); break;
    case 0xA9: op_sub16(R.ax,fetch16()); break;

    case 0xD0: case 0xD1: case 0xD2: case 0xD3:
    case 0xC0: case 0xC1:{
        int wide=(op==0xD1||op==0xC1);
        rm_t m=decode_rm();
        int n;
        if(op==0xD0||op==0xD1) n=1;
        else if(op==0xD2||op==0xD3) n=REG8(1)&31;   /* CL */
        else n=fetch8()&31;
        if(wide){ uint16_t v=read_rm16(&m);
            switch(m.reg){case 0:shl16(&v,n);break;case 1:shr16(&v,n);break;case 2:shl16(&v,n);break;case 3:sar16(&v,n);break;
                          case 4:rol16(&v,n);break;case 5:ror16(&v,n);break;case 6:shl16(&v,n);break;default:v=op_not16(v);}
            write_rm16(&m,v);
        } else { uint8_t v=read_rm8(&m);
            switch(m.reg){case 0:shl8(&v,n);break;case 1:shr8(&v,n);break;case 2:shl8(&v,n);break;case 3:sar8(&v,n);break;
                          case 4:rol8(&v,n);break;case 5:ror8(&v,n);break;case 6:shl8(&v,n);break;default:v=op_not8(v);}
            write_rm8(&m,v);
        } } break;

    case 0xFE:{ rm_t m=decode_rm(); uint8_t v=read_rm8(&m); write_rm8(&m, m.reg==0?op_inc8(v):op_dec8(v)); } break;
    case 0xFF:{ rm_t m=decode_rm();
        switch(m.reg){
            case 0: push16(read_rm16(&m)); break;
            case 1:{ uint16_t t=read_rm16(&m); push16(R.ip); R.ip=t; } break;      /* call near */
            case 2:{ uint32_t lin=rm_linear(&m); uint16_t off=mem_read16(lin),seg=mem_read16(lin+2);
                     push16(R.ip); push16(R.cs); R.cs=seg; R.ip=off; } break;       /* call far */
            case 3: R.ip=read_rm16(&m); break;                                      /* jmp near */
            case 4:{ uint32_t lin=rm_linear(&m); R.cs=mem_read16(lin+2); R.ip=mem_read16(lin); } break; /* jmp far */
            case 6: write_rm16(&m,op_inc16(read_rm16(&m))); break;
            case 7: write_rm16(&m,op_dec16(read_rm16(&m))); break;
            default: R.stopped=4;
        } } break;

    case 0xF6:{ rm_t m=decode_rm(); uint8_t v=read_rm8(&m);
        switch(m.reg){
            case 0: case 1: op_test8(v,fetch8()); break;
            case 2: write_rm8(&m,op_not8(v)); break;
            case 3: write_rm8(&m,op_neg8(v)); break;
            case 4: { uint16_t p=(uint16_t)R.al*(uint16_t)v; R.ax=p; R.flags=(R.flags&~(F_CF|F_OF))|((p&0xFF00)?(F_CF|F_OF):0);} break;
            case 5: { uint16_t dv=R.ax; if(v==0){R.stopped=5;break;} R.al=(uint8_t)(dv/v); R.ah=(uint8_t)(dv%v); } break;
            case 6: { int16_t dv=(int16_t)R.ax; if(v==0){R.stopped=5;break;} int16_t q=dv/(int8_t)v; if(q>127||q<-128){R.stopped=5;break;} R.al=(uint8_t)q; R.ah=(uint8_t)(dv%(int8_t)v);} break;
            case 7: { int16_t dv=(int16_t)R.ax; if(v==0){R.stopped=5;break;} R.al=(uint8_t)(dv/(int8_t)v);} break;
        } } break;
    case 0xF7:{ rm_t m=decode_rm(); uint16_t v=read_rm16(&m);
        switch(m.reg){
            case 0: case 1: op_test16(v,fetch16()); break;
            case 2: write_rm16(&m,op_not16(v)); break;
            case 3: write_rm16(&m,op_neg16(v)); break;
            case 4: { uint32_t p=(uint32_t)R.ax*(uint32_t)v; R.ax=(uint16_t)p; R.dx=(uint16_t)(p>>16); R.flags=(R.flags&~(F_CF|F_OF))|((R.dx)?(F_CF|F_OF):0);} break;
            case 5: { uint32_t dv=((uint32_t)R.dx<<16)|R.ax; if(v==0){R.stopped=5;break;} uint32_t q=dv/v; if(q>0xFFFF){R.stopped=5;break;} R.ax=(uint16_t)q; R.dx=(uint16_t)(dv%v);} break;
            case 6: { int32_t dv=(int32_t)(((uint32_t)R.dx<<16)|R.ax); if(v==0){R.stopped=5;break;} int32_t q=dv/(int16_t)v; if(q>32767||q<-32768){R.stopped=5;break;} R.ax=(uint16_t)q; R.dx=(uint16_t)(dv%(int16_t)v);} break;
            case 7: { int32_t dv=(int32_t)(((uint32_t)R.dx<<16)|R.ax); if(v==0){R.stopped=5;break;} R.ax=(uint16_t)(dv/(int16_t)v);} break;
        } } break;

    case 0x98:{ if(R.al&0x80){R.ah=0xFF;}else{R.ah=0;} } break; /* cbw */
    case 0x99:{ if(R.ax&0x8000){R.dx=0xFFFF;}else{R.dx=0;} } break; /* cwd */
    case 0x9B: break;
    case 0xD7:{ uint8_t idx=(uint8_t)(R.bx+R.al); R.al=mem_read8(la(R.ds,idx)); } break; /* xlat */
    case 0x27: case 0x2F: case 0x37: case 0x3F: break; /* BCD — no-op */
    case 0xF4: R.halted=1; break;
    case 0xC8:{ uint16_t size=fetch16(); uint8_t lvl=fetch8(); push16(R.bp); R.bp=R.sp;
                for(uint8_t i=1;i<lvl;i++){ R.bp=(uint16_t)(R.bp-2); push16(mem_read16(la(R.ss,R.bp))); }
                R.sp=(uint16_t)(R.sp-size); (void)size; } break;
    case 0xC9: R.sp=R.bp; R.bp=pop16(); break;
    case 0x0F:{ uint8_t o2=fetch8();
        if(o2>=0x80&&o2<=0x8F){ int16_t d=(int16_t)fetch16(); if(cond_taken((uint8_t)(0x70+(o2-0x80)))) R.ip=(uint16_t)(R.ip+d); }
        else R.stopped=2; } break;
    default:
        R.stopped=3;
        break;
    }
    return 0;
}
