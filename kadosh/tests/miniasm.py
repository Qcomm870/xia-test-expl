#!/usr/bin/env python3
"""Мини-ассемблер x86 real mode для тестов KADOSH. Поддерживает подмножество,
достаточное для hello-world и арифметических тестов."""
import sys

def assemble(src_lines):
    # строки: метки (name:) и инструкции; DB 'текст$' поддерживается
    items=[]  # ('label',name) | ('ins',text) | ('db', bytes)
    for line in src_lines:
        s=line.strip()
        # вырезать комментарии, не трогая строки в апострофах
        cut=None; instr=True
        while True:
            i=s.find(';',cut if cut is not None else 0)
            if i<0: break
            q=s.count("'",0,i)
            if q%2==0: cut=i; break
        if cut is not None: s=s[:cut].strip()
        if not s: continue
        if ':' in s and s.index(':')< (s.find(' ') if ' ' in s else len(s)):
            li=s.index(':')
            items.append(('label',s[:li].strip().upper()))
            s=s[li+1:].strip()
            if not s: continue
        if s.upper().startswith('DB '):
            payload=s[3:].strip()
            if payload.startswith("'") and payload.endswith("'"):
                items.append(('bytes',payload[1:-1].encode('latin-1')))
            else:
                vals=[int(v.strip().rstrip('H'),16) if v.strip().endswith('H') or v.strip().startswith('0X') else int(v,0) for v in split_args(payload)]
                items.append(('bytes',bytes([v&0xFF for v in vals])))
        else:
            items.append(('ins',s))
    # pass1: размеры
    labels={}; pos=0
    ins_sizes=[]
    for kind,v in items:
        if kind=='label': labels[v]=pos
        elif kind=='bytes': pos+=len(v); ins_sizes.append(len(v))
        else:
            b=encode(v,labels,pos,dummy=True)
            ins_sizes.append(len(b)); pos+=len(b)
    # pass2
    code=bytearray(); pos=0; i=0
    for kind,v in items:
        if kind=='label': continue
        elif kind=='bytes': code+=v; pos+=len(v)
        else:
            b=encode(v,labels,pos); code+=b; pos+=len(b)
        i+=1
    return bytes(code)

def _size_of_rest(*a): return 0

def reg8_num(name):
    m={'al':0,'cl':2,'dl':4,'bl':6,'ah':1,'ch':3,'dh':5,'bh':7}
    return m[name.lower()]

def reg16_num(name):
    m={'ax':0,'cx':1,'dx':2,'bx':3,'sp':4,'bp':5,'si':6,'di':7}
    return m[name.lower()]

def parse_mem(tok):
    """[BX+SI], [1234h], [BP], [BX+DI+5] -> (mod,rm,disp_bytes)"""
    t = tok.strip('[]').upper()
    parts = [p.strip() for p in t.replace('+','|').split('|')]
    disp = 0; base=None; idx=None
    for p in parts:
        if p.startswith('0X') or p[-1]=='H' or p.isdigit():
            v=int(p.replace('H',''),16) if p.endswith('H') else int(p,0)
            disp+=v
        elif p in ('BX','BP','SI','DI'):
            if p in ('BX','BP'): base=p
            else: idx=p
        else:
            raise ValueError("mem? "+p)
    rm_table={('BX','SI'):0,('BX','DI'):1,('BP','SI'):2,('BP','DI'):3,
              ('BX',None):7,('BP',None):6,(None,'SI'):4,(None,'DI'):5}
    key=(base,idx)
    if base is None and idx is None:
        return 0,6,disp   # disp16
    rm=rm_table[key]
    if disp==0 and rm!=6: mod=0
    elif -128<=disp<=127 and rm!=6: mod=1
    else: mod=2
    return mod,rm,disp

def encode(ins, labels, cur, dummy=False):
    u = ins.upper().replace('\t',' ')
    op,_,rest = u.partition(' ')
    rest=rest.strip()
    args=[a.strip() for a in split_args(rest)] if rest else []

    def immval(a):
        a=a.rstrip(';').strip()
        au=a.upper()
        if au in labels: return labels[au]
        if a.startswith('0X'): return int(a,16)
        if len(a)>1 and a[-1]=='H': return int(a[:-1],16)
        if a in labels: return labels[a]
        try: return int(a,0)
        except ValueError:
            if dummy: return cur+2   # заглушка нужной длины; во 2-м проходе метка уже есть
            raise KeyError(a)

    def modrm(mod,reg,rm,disp=None):
        b=bytearray([(mod<<6)|((reg&7)<<3)|(rm&7)])
        if mod!=3:
            if rm==6 and mod==0: b+=bytes([disp&0xFF,(disp>>8)&0xFF])
            elif mod==1: b+=bytes([disp&0xFF])
            elif mod==2: b+=bytes([disp&0xFF,(disp>>8)&0xFF])
        return bytes(b)

    if op=='DB':
        out=bytearray()
        for a in args:
            if a.startswith("'"): out.append(ord(a.strip("'")[0]))
            else: out.append(immval(a)&0xFF)
        return bytes(out)
    if op in ('NOP',): return b'\x90'
    if op=='HLT': return b'\xF4'
    if op=='RET': return b'\xC3'
    if op=='IRET': return b'\xCF'
    if op=='PUSHA': return b'\x60'
    if op=='POPA': return b'\x61'
    if op=='CLC': return b'\xF8'
    if op=='STC': return b'\xF9'
    if op=='CLD': return b'\xFC'
    if op=='STD': return b'\xFD'
    if op=='CBW': return b'\x98'
    if op=='CWD': return b'\x99'
    if op=='XLAT': return b'\xD7'
    if op=='INT':
        n=immval(args[0]); return bytes([0xCD,n&0xFF])
    if op=='MOV':
        d,s=args
        if d.startswith('['):
            mod,rm,disp=parse_mem(d)
            if s.startswith('0X') or s[-1]=='H' or s.isdigit() or s in labels:
                v=immval(s)
                if v<=0xFF and 'BYTE' in u: return bytes([0xC6])+modrm(0,0,rm,disp)+bytes([v])
                return bytes([0xC7])+modrm(0,0,rm,disp)+bytes([v&0xFF,v>>8])
            if reg8_num.get(s.lower()) is not None and len(s)==2 and s[:1] in 'ACDB' and s[1] in 'LH':
                return bytes([0x88])+modrm(mod,reg8_num(s.lower()),rm,disp)
            return bytes([0x89])+modrm(mod,reg16_num(s),rm,disp)
        if s.startswith('['):
            mod,rm,disp=parse_mem(s)
            if len(d)==2 and d[1] in 'LH' and d[0] in 'ACDB':
                return bytes([0x8A])+modrm(mod,reg8_num(d),rm,disp)
            return bytes([0x8B])+modrm(mod,reg16_num(d),rm,disp)
        if d[-1]=='X' or d in ('SP','BP','SI','DI'):
            return bytes([0xB8+reg16_num(d)])+bytes([immval(s)&0xFF,immval(s)>>8])
        if is_r8(d):
            return bytes([0xB0+reg8_num(d), immval(s)&0xFF])
    if op=='ADD':
        d,s=args
        if d=='AL' and not s.startswith('[') and not is_r8(s) and not is_r16(s): return bytes([0x04,immval(s)&0xFF])
        if d=='AX' and not s.startswith('[') and not is_r8(s) and not is_r16(s): v=immval(s); return bytes([0x05,v&0xFF,v>>8])
        if is_r8(d) and is_r8(s): return bytes([0x00])+modrm(3,reg8_num(s),reg8_num(d))
        if is_r16(d) and is_r16(s): return bytes([0x01])+modrm(3,reg16_num(s),reg16_num(d))
        if is_r8(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x02])+modrm(mod,reg8_num(d),rm,disp)
        if is_r16(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x03])+modrm(mod,reg16_num(d),rm,disp)
        if d.startswith('[') and is_r8(s): mod,rm,disp=parse_mem(d); return bytes([0x00])+modrm(mod,reg8_num(s),rm,disp)
        if d.startswith('[') and is_r16(s): mod,rm,disp=parse_mem(d); return bytes([0x01])+modrm(mod,reg16_num(s),rm,disp)
    if op=='SUB':
        d,s=args
        if d=='AL' and not s.startswith('[') and not is_r8(s) and not is_r16(s): return bytes([0x2C,immval(s)&0xFF])
        if d=='AX' and not s.startswith('[') and not is_r8(s) and not is_r16(s): v=immval(s); return bytes([0x2D,v&0xFF,v>>8])
        if is_r8(d) and is_r8(s): return bytes([0x28])+modrm(3,reg8_num(s),reg8_num(d))
        if is_r16(d) and is_r16(s): return bytes([0x29])+modrm(3,reg16_num(s),reg16_num(d))
        if is_r8(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x2A])+modrm(mod,reg8_num(d),rm,disp)
        if is_r16(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x2B])+modrm(mod,reg16_num(d),rm,disp)
    if op=='CMP':
        d,s=args
        if d=='AL' and not s.startswith('[') and not is_r8(s) and not is_r16(s): return bytes([0x3C,immval(s)&0xFF])
        if d=='AX' and not s.startswith('[') and not is_r8(s) and not is_r16(s): v=immval(s); return bytes([0x3D,v&0xFF,v>>8])
        if is_r8(d) and is_r8(s): return bytes([0x38])+modrm(3,reg8_num(s),reg8_num(d))
        if is_r16(d) and is_r16(s): return bytes([0x39])+modrm(3,reg16_num(s),reg16_num(d))
        if is_r8(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x3A])+modrm(mod,reg8_num(d),rm,disp)
        if is_r16(d) and s.startswith('['): mod,rm,disp=parse_mem(s); return bytes([0x3B])+modrm(mod,reg16_num(d),rm,disp)
    if op=='AND':
        d,s=args
        if d=='AL': return bytes([0x24,immval(s)&0xFF])
        if d=='AX': v=immval(s); return bytes([0x25,v&0xFF,v>>8])
    if op=='OR':
        d,s=args
        if d=='AL': return bytes([0x0C,immval(s)&0xFF])
        if d=='AX': v=immval(s); return bytes([0x0D,v&0xFF,v>>8])
    if op=='XOR':
        d,s=args
        if d=='AX' and s=='AX': return b'\x31\xC0'
        if d=='AL': return bytes([0x34,immval(s)&0xFF])
        if d=='AX': v=immval(s); return bytes([0x35,v&0xFF,v>>8])
    if op in ('INC','DEC'):
        d=args[0]
        base=0x40 if op=='INC' else 0x48
        return bytes([base+reg16_num(d)])
    if op=='JMP':
        t=args[0]; target=immval(t); rel=target-cur
        if -128<=rel<=127: return bytes([0xEB,rel&0xFF])
        return bytes([0xE9])+bytes([rel&0xFF,(rel>>8)&0xFF])
    if op=='CALL':
        t=args[0]; target=immval(t); rel=target-cur
        return bytes([0xE8])+bytes([rel&0xFF,(rel>>8)&0xFF])
    if op.startswith('J') and len(op)<=3:
        t=args[0]; target=immval(t); rel=target-cur
        cond={'JO':0x70,'JNO':0x71,'JB':0x72,'JC':0x72,'JNB':0x73,'JAE':0x73,'JZ':0x74,'JE':0x74,
              'JNZ':0x75,'JNE':0x75,'JBE':0x76,'JA':0x77,'JS':0x78,'JNS':0x79,'JP':0x7A,'JPE':0x7A,
              'JNP':0x7B,'JPO':0x7B,'JL':0x7C,'JGE':0x7D,'JLE':0x7E,'JG':0x7F}[op]
        return bytes([cond,rel&0xFF])
    if op=='LOOP':
        t=args[0]; target=immval(t); rel=target-cur
        return bytes([0xE2,rel&0xFF])
    if op=='PUSH':
        d=args[0]
        if d in ('ES','CS','SS','DS'): return {b'ES':b'\x06',b'CS':b'\x0E',b'SS':b'\x16',b'DS':b'\x1E'}[d.encode()]
        return bytes([0x68,immval(d)&0xFF,immval(d)>>8]) if False else bytes([0x50+reg16_num(d)])
    if op=='POP':
        return bytes([0x58+reg16_num(args[0])])
    if op=='MUL':
        return bytes([0xF7])+modrm(3,4,reg16_num(args[0]))
    if op=='DIV':
        return bytes([0xF7])+modrm(3,6,reg16_num(args[0]))
    raise ValueError("cannot encode: "+ins)

def is_r8(n): return len(n)==2 and n[0] in 'ACDB' and n[1] in 'LH'
def is_r16(n): return n in ('AX','BX','CX','DX','SP','BP','SI','DI')

def split_args(rest):
    out=[];depth=0;cur=''
    for ch in rest:
        if ch=='[': depth+=1
        if ch==']': depth-=1
        if ch==',' and depth==0: out.append(cur);cur='';continue
        cur+=ch
    if cur.strip(): out.append(cur)
    return out

if __name__=='__main__':
    data=open(sys.argv[1]).read().splitlines()
    code=assemble(data)
    open(sys.argv[2],'wb').write(code)
    print(f"assembled {len(code)} bytes")
