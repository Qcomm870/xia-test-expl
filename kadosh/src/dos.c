/* KADOSH dos.c — хуки прерываний: INT 21h (DOS), INT 10h (видео текст 80x25),
 * INT 16h/21h AH=0Ah/01h (ввод), INT 20h/21h AH=4Ch (выход).
 * Экран — текстовый буфер в памяти по B800h (как у реального VGA text mode),
 * плюс кольцевой лог для хоста/webapp.
 */
#include "cpu.h"
#include "mem.h"
#include <string.h>
#include <stdio.h>

#define TEXT_COLS 80
#define TEXT_ROWS 25
#define VIDEO_SEG 0xB800

static int cursor_x=0, cursor_y=0;

/* очередь нажатых клавиш (заполняется снаружи через kados_inject_key) */
static uint8_t key_queue[64];
static int key_head=0, key_tail=0;

void kados_inject_key(uint8_t scancode, uint8_t ascii){
    if(key_tail-key_head < (int)(sizeof key_queue)-1){
        key_queue[key_tail++]=scancode;
        key_queue[key_tail++]=ascii;
    }
}

void kados_clear_screen(void){
    for(int i=0;i<TEXT_COLS*TEXT_ROWS;i++) mem_write16(la(VIDEO_SEG,i*2),' '|0x0700);
    cursor_x=cursor_y=0;
}

static void scroll_up(void){
    for(int y=0;y<TEXT_ROWS-1;y++)
        for(int x=0;x<TEXT_COLS;x++){
            uint16_t c=mem_read16(la(VIDEO_SEG,((y+1)*TEXT_COLS+x)*2));
            mem_write16(la(VIDEO_SEG,(y*TEXT_COLS+x)*2),c);
        }
    for(int x=0;x<TEXT_COLS;x++) mem_write16(la(VIDEO_SEG,((TEXT_ROWS-1)*TEXT_COLS+x)*2),' '|0x0700);
    cursor_y=TEXT_ROWS-1;
}

static void put_char(uint8_t ch){
    if(ch=='\r'){ cursor_x=0; return; }
    if(ch=='\n'){ if(cursor_y>=TEXT_ROWS-1) scroll_up(); else cursor_y++; cursor_x=0; return; }
    if(ch=='\b'){ if(cursor_x>0)cursor_x--; return; }
    if(ch=='\t'){ cursor_x=(cursor_x+8)&~7; if(cursor_x>=TEXT_COLS){cursor_x=0;if(cursor_y>=TEXT_ROWS-1)scroll_up();else cursor_y++;} return; }
    if(ch<32) return;
    if(cursor_x>=TEXT_COLS){ cursor_x=0; if(cursor_y>=TEXT_ROWS-1) scroll_up(); else cursor_y++; }
    mem_write16(la(VIDEO_SEG,(cursor_y*TEXT_COLS+cursor_x)*2), ch | 0x0700);
    cursor_x++;
}

static void print_ds_off(uint16_t off,uint16_t seg){
    uint32_t a=la(seg,off);
    for(int i=0;i<256;i++){
        uint8_t c=mem_read8(a+i);
        if(c=='$'||c==0) break;
        put_char(c);
    }
}

/* чтение строки DOS (INT 21h AH=0Ah): буфер DS:DX = [max][count][chars] */
static void buffered_input(uint16_t dx){
    uint32_t buf=la(R.ds,dx);
    uint8_t max=mem_read8(buf);
    int n=0;
    while(n<max-1){
        /* ждём символы из очереди; если пусто — возвращаем что есть (эмуляция EOF-lite) */
        if(key_head==key_tail) break;
        uint8_t sc=key_queue[key_head++];
        uint8_t asc=key_queue[key_head++];
        (void)sc;
        if(asc=='\r'||asc=='\n') break;
        if(asc>=32){ mem_write8(buf+2+n,asc); put_char(asc); n++; }
    }
    mem_write8(buf+1,(uint8_t)n);
    mem_write8(buf+2+n,0);
}

extern char kados_stdout_log[4096];
extern int  kados_stdout_len;
static void log_char(char c){
    if(kados_stdout_len<(int)sizeof(kados_stdout_log)-1) kados_stdout_log[kados_stdout_len++]=c;
}

int hook_int(uint8_t num){
    switch(num){
    case 0x20: /* terminate program */
        R.stopped=0x20; return 1;
    case 0x21:{
        uint8_t high=(uint8_t)(R.ax>>8);
        switch(high){
            case 0x01: { /* getchar */
                if(key_head<key_tail){ uint8_t sc=key_queue[key_head++]; uint8_t a=key_queue[key_head++]; (void)sc; R.al=a; log_char(a); }
                else R.al=0;
                put_char(R.al);
                return 1; }
            case 0x02: put_char(R.al&0xFF); log_char(R.al&0xFF); return 1;
            case 0x06: if((R.al&0xFF)==0xFF){ /* status query */
                       if(key_head<key_tail){ R.al=key_queue[key_head+1]; } else R.al=0; }
                       else { put_char(R.al&0xFF); log_char(R.al&0xFF);} return 1;
            case 0x07: case 0x08: {
                if(key_head<key_tail){ key_head+=2; R.al=0x08; } else R.al=0;
                return 1; }
            case 0x09: print_ds_off(R.dx,R.ds); return 1;
            case 0x0A: buffered_input(R.dx); return 1;
            case 0x0C: R.al=high; return 1;
            case 0x0E: put_char(R.al&0xFF); log_char(R.al&0xFF); return 1; /* tel output */
            case 0x19: R.al=0; return 1;                    /* get default drive */
            case 0x25: { /* set interrupt vector DS:DX -> AL */
                uint32_t v=(uint32_t)(R.al)*4;
                mem_write16(v+0,R.dx); mem_write16(v+2,R.ds);
                return 1; }
            case 0x2A: { R.cx=2026; R.dx=0x0101; R.al=2; return 1; } /* date */
            case 0x2C: R.al=12; R.dl=0; return 1;           /* time */
            case 0x2F: R.al=0; return 1;                   /* dos version-ish */
            case 0x30: R.al=3; R.ah=3; R.bx=0; return 1;   /* DOS 3.3 */
            case 0x33: R.al=0; R.dl=1; return 1;           /* ctrl-break state */
            case 0x35: { uint32_t v=(uint32_t)(R.al)*4; R.bx=mem_read16(v+0); R.es=mem_read16(v+2); return 1; }
            case 0x36: R.ax=1024; R.bx=64; R.cx=512; R.dx=0; return 1; /* free space */
            case 0x40: { /* write fh=BX, cx bytes from ds:dx */
                uint32_t a=la(R.ds,R.dx);
                for(uint16_t i=0;i<R.cx;i++){ uint8_t c=mem_read8(a+i); put_char(c); log_char(c);} 
                return 1; }
            case 0x44: R.al=0; return 1;                   /* ioctl */
            case 0x48: R.bx=0x8000; return 1;              /* alloc mem -> fake */
            case 0x4A: return 1;                            /* resize */
            case 0x4C: R.stopped=0x4C; return 1;
            case 0x4D: R.al=0; return 1;                   /* no child */
            case 0x4E: case 0x4F: R.al=0x12; return 1;     /* no files in our VFS */
            case 0x57: R.dx=0; return 1;
            case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F: R.al=2; return 1; /* unsupported fns */
            case 0x62: R.bx=0x0080; return 1;              /* get PSP */
            default: R.al=0x01; return 1;                  /* error: bad fn */
        }
    }
    case 0x10:{
        uint8_t high=(uint8_t)(R.ax>>8);
        switch(high){
            case 0x00: return 1;                 /* set mode */
            case 0x01: return 1;                 /* set cursor shape */
            case 0x02: cursor_x=R.dl&0x7F; cursor_y=R.dh&0x1F; return 1;
            case 0x03: R.cx=0x0607; R.dx=(cursor_y<<8)|cursor_x; return 1;
            case 0x06: case 0x07: {              /* scroll window/clear */
                if((R.ax>>8)==0x06 && (R.al&0xFF)==0){ kados_clear_screen(); }
                else if((R.ax>>8)==0x07){ kados_clear_screen(); }
                return 1; }
            case 0x08: R.al=' '; R.ah=7; return 1;
            case 0x09: for(uint16_t i=0;i<R.cx;i++) put_char(R.bl); return 1; /* write attr char */
            case 0x0E: put_char(R.al&0xFF); return 1;      /* teletype */
            case 0x13: {                          /* write string */
                uint32_t a=la(R.es,R.bp);
                for(uint16_t i=0;i<R.cx;i++) put_char(mem_read8(a+i));
                return 1; }
            case 0x1A: R.bx=0x1030; return 1;             /* get ptr info */
            default: return 1;
        }
    }
    case 0x16:{
        uint8_t high=(uint8_t)(R.ax>>8);
        switch(high){
            case 0x00: case 0x10:
                if(key_head<key_tail){ R.al=key_queue[key_head++]; R.ah=key_queue[key_head++]; }
                else { R.al=0; R.ah=0; R.halted=1; }
                return 1;
            case 0x01: case 0x11:
                if(key_head<key_tail){ R.al=key_queue[key_head++]; R.ah=key_queue[key_head++]; }
                else { R.ax=0xFFFF; }
                return 1;
            case 0x02: R.al=0; return 1;          /* shift flags */
            default: return 1;
        }
    }
    case 0x11: case 0x12: case 0x15: return 1;   /* BIOS misc: no-op success */
    case 0x1A: { uint8_t high=(uint8_t)(R.ax>>8);
        if(high==0){ R.al=0x03; return 1; }      /* get device status: tty */
        if(high==2){ R.al=0; return 1; }         /* no serial */
        return 1; }
    default: return 0;                            /* идти в IVT */
    }
    return 0;
}

/* доступ хоста к экрану */
int kados_get_cursor_x(void){return cursor_x;}
int kados_get_cursor_y(void){return cursor_y;}
const char *kados_screen_text(void){
    static char out[TEXT_COLS*TEXT_ROWS+1];
    int p=0;
    for(int y=0;y<TEXT_ROWS;y++){
        for(int x=0;x<TEXT_COLS;x++){
            uint16_t c=mem_read16(la(VIDEO_SEG,(y*TEXT_COLS+x)*2));
            out[p++]=(char)(c&0xFF);
        }
    }
    out[p]=0;
    return out;
}
