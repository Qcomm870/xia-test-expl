/* Заглушка DOS-сервисов. Реальный DOSBox требует эмуляцию INT 21h/10h/33h и т.д. */
#include <stdint.h>
struct regs;
extern uint8_t *vm_mem(void);
static uint32_t la(uint16_t s,uint16_t o){return ((uint32_t)s<<4)+o;}

void dos_int(uint8_t num, struct regs *R){
    if(num==0x21){
        /* доступ к регистрам через структуру — упрощённо читаем DX как указатель строки */
        extern void js_print(const char*);
        js_print("[DOS stub] INT21 invoked\n");
    }
}
