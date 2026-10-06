import zipfile, os, sys
src='webapp'; out=sys.argv[1]
zf=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)
for root,dirs,files in os.walk(src):
    for fn in files:
        full=os.path.join(root,fn)
        arc=os.path.relpath(full,src).replace(os.sep,'/')
        zf.write(full,arc)
zf.close()
# verify manifest at root with correct name
with zipfile.ZipFile(out) as f:
    names=f.namelist()
    assert 'manifest.webapp' in names, 'missing root manifest!'
    import json
    m=json.loads(f.read('manifest.webapp'))
    assert m.get('name') and m.get('launch_path') and m.get('version') and m.get('developer'), 'incomplete manifest'
    print('OK', out, names, 'v'+m['version'])
