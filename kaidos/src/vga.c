/* VGA mode 13h framebuffer 320x200 -> RGB565 буфер для canvas 320x240 телефона */
#include <stdint.h>
#include <string.h>
#define W 320
#define H 200
static uint16_t fb[W*H];           /* выходной буфер RGB565 */
uint16_t *vga_buffer(void){ return fb; }
int vga_w(void){return W;} int vga_h(void){return H;}

void vga_update(const uint8_t *palette256rgb, const uint8_t *screen){
    for(int i=0;i<W*H;i++){
        uint8_t c=screen[i];
        uint8_t rr=palette256rgb[c*3], gg=palette256rgb[c*3+1], bb=palette256rgb[c*3+2];
        fb[i]=((rr>>3)<<11)|((gg>>2)<<5)|(bb>>3);
    }
}
