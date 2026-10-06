/* KADOSH main.c — загрузчик COM + CLI-хост для тестов на ПК */
#include "cpu.h"
#include "mem.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

char kados_stdout_log[4096];
int  kados_stdout_len=0;

void kados_clear_screen(void);
void kados_inject_key(uint8_t scancode, uint8_t ascii);
const char *kados_screen_text(void);
int  kados_get_cursor_x(void);
int  kados_get_cursor_y(void);

extern void dos_set_psp(uint16_t psp_seg); /* если понадобится */

static int load_com(const uint8_t *img,int len,const char *cmdline){
    mem_reset();
    cpu_reset();
    kados_clear_screen();
    kados_stdout_len=0;

    /* PSP на сегменте 0x0080 (стандартно для COM) */
    uint32_t psp=la(0x0080,0);
    mem_write16(psp+0x00,0x20CD);           /* INT 20h на входе */
    mem_write16(psp+0x02,(uint16_t)(0x100+len)); /* stack top-ish */
    mem_write16(psp+0x04,0x28);             /* far call DOS terminate stub */
    for(int i=0;i<5;i++) mem_write8(psp+0x0C+i,0xC3*0+0x90); /* nop-sled: 0x90 */
    mem_write8(psp+0x0C,0xCB);              /* retf как terminate fallback */
    mem_write16(psp+0x2C,0x00FF);           /* FCB-ish */
    /* cmdline: offset 0x80 внутри PSP */
    int n=(int)strlen(cmdline); if(n>126)n=126;
    memcpy(mem_ptr()+psp+0x80+1,cmdline,n);
    mem_write8(psp+0x80,(uint8_t)n);
    mem_write8(psp+0x80+1+n,'\r');

    /* образ по 0x0100 */
    memcpy(mem_ptr()+0x100,img,len);
    R.cs=R.ds=R.ss=R.es=0x0080;
    R.ip=0x0100;
    R.sp=0xFFFE;
    return 0;
}

int kados_run_steps(long max_steps){
    long i=0;
    while(i<max_steps && !R.stopped && !R.halted){
        cpu_step();
        i++;
    }
    return R.stopped?R.stopped:(R.halted?100:0);
}

#ifdef KADOS_CLI_HOST
int main(int argc,char**argv){
    if(argc<2){ fprintf(stderr,"usage: kados program.com [args...]\n"); return 2; }
    FILE *f=fopen(argv[1],"rb");
    if(!f){ perror("open"); return 2; }
    fseek(f,0,SEEK_END); long sz=ftell(f); fseek(f,0,SEEK_SET);
    if(sz<=0||sz>MEM_SIZE-0x100){ fprintf(stderr,"bad size\n"); return 2; }
    uint8_t *buf=malloc((size_t)sz);
    fread(buf,1,(size_t)sz,f); fclose(f);

    char cmd[256]=""; 
    for(int i=2;i<argc;i++){ strcat(cmd,argv[i]); strcat(cmd," "); }
    load_com(buf,(int)sz,cmd);
    free(buf);

    int rc=kados_run_steps(20000000L);
    printf("--- screen ---\n%s\n",kados_screen_text());
    printf("--- stdout log ---\n%.*s\n",kados_stdout_len,kados_stdout_log);
    printf("cursor=(%d,%d) exit=%d\n",kados_get_cursor_x(),kados_get_cursor_y(),rc);
    return rc==0x4C?0:rc;
}
#endif
