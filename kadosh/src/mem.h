/* KADOSH — линейная память x86 real mode: 1 МБ + загрузочные образы */
#ifndef MEM_H
#define MEM_H
#include <stdint.h>
#include <stddef.h>

#define MEM_SIZE (1024u*1024u)

uint8_t *mem_ptr(void);                 /* вся память 1 МБ */
void     mem_reset(void);

static inline uint8_t  mem_read8 (uint32_t a){ return mem_ptr()[a & (MEM_SIZE-1)]; }
static inline uint16_t mem_read16(uint32_t a){ const uint8_t *m=mem_ptr(); a&=(MEM_SIZE-1); return m[a] | (m[(a+1)&(MEM_SIZE-1)]<<8); }
static inline uint32_t mem_read32(uint32_t a){ return (uint32_t)mem_read16(a) | ((uint32_t)mem_read16(a+2)<<16); }

static inline void mem_write8 (uint32_t a, uint8_t  v){ mem_ptr()[a & (MEM_SIZE-1)] = v; }
static inline void mem_write16(uint32_t a, uint16_t v){ uint8_t *m=mem_ptr(); a&=(MEM_SIZE-1); m[a]=v&0xFF; m[(a+1)&(MEM_SIZE-1)]=v>>8; }
static inline void mem_write32(uint32_t a, uint32_t v){ mem_write16(a,(uint16_t)v); mem_write16(a+2,(uint16_t)(v>>16)); }

#endif
