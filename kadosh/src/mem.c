#include "mem.h"
#include <string.h>

static uint8_t memory[MEM_SIZE];

uint8_t *mem_ptr(void){ return memory; }
void mem_reset(void){ memset(memory,0,MEM_SIZE); }
