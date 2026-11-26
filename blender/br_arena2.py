# Батл Рояль 2.1 — арена фіналу «Руїни в джунглях» у стилі острова лобі.
# Запуск: E:\Blender\blender.exe -b blender/br_island2.blend --python blender/br_arena2.py
# Бере прототипи K_* з колекції BR_Kit (ті самі, що в public/models/br/island_kit.glb), будує рельєф і власні кам'яні руїни.
# Пише public/models/br/arena2.glb (BR_ArenaTerrain + BR_Ruins) і arena2.json:
#   e, n, h      — висоти (сітка 1 од., у см), як island2.json
#   place        — декор і укриття-інстанси [proto, x, y, z, rotY, scale] (у координатах three.js)
#   crates       — руйнівні ящики [{id, x, z, rot, s}], barrels — вибухові бочки [{id, x, z}]
#   cols         — колайдери AABB {t: wall|low|crate|barrel, x, z, w, d, h, id?}
#   half         — межа бою (|x|,|z| < half)
import bpy, bmesh, math, random, json, os
from mathutils import Vector, Matrix

OUT = r'D:\KICKplay-main\public\models\br'
R = random.Random(2711)
kit = {o.name[2:]: o for o in bpy.data.collections['BR_Kit'].objects}
sc = bpy.data.scenes.get('BR_Arena2') or bpy.data.scenes.new('BR_Arena2')
if bpy.context.window: bpy.context.window.scene = sc
col = bpy.data.collections.get('BR_Arena2') or bpy.data.collections.new('BR_Arena2')
if col.name not in sc.collection.children: sc.collection.children.link(col)
for o in list(col.objects): bpy.data.objects.remove(o, do_unlink=True)

def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
def hsh(ix, iz):
    n = (ix * 374761393 + iz * 668265263) & 0xffffffff; n = ((n ^ (n >> 13)) * 1274126177) & 0xffffffff; return (n & 0xffff) / 65535.0
def vn(x, z):
    ix, iz = math.floor(x), math.floor(z); fx, fz = x - ix, z - iz; fx, fz = fx*fx*(3-2*fx), fz*fz*(3-2*fz)
    a, b, c, d = hsh(ix, iz), hsh(ix+1, iz), hsh(ix, iz+1), hsh(ix+1, iz+1)
    return (a + (b-a)*fx) + ((c + (d-c)*fx) - (a + (b-a)*fx)) * fz
def fbm(x, z): return vn(x, z)*0.6 + vn(x*2.1+7, z*2.1+3)*0.3 + vn(x*4.3+1, z*4.3+9)*0.1
def lin(h):
    h = h.lstrip('#'); c = [int(h[k:k+2], 16)/255 for k in (0, 2, 4)]
    return [(v/12.92) if v <= 0.04045 else ((v+0.055)/1.055)**2.4 for v in c]
def mix(a, b, t): return [a[i] + (b[i]-a[i])*t for i in range(3)]

HALF = 27.0            # межа бою
# Координати: будуємо в three-коорд. (x, z), висота y. У Blender: (x, -z, y).
def height(x, z):
    d = max(abs(x), abs(z)) + (fbm(x * 0.08, z * 0.08) - 0.5) * 6
    h = 0.25 + fbm(x * 0.07 + 5, z * 0.07 + 2) * 0.5
    h += 5.5 * sstep(HALF + 2, HALF + 9, d) + fbm(x * 0.2, z * 0.2) * 1.6 * sstep(HALF + 3, HALF + 10, d)   # пагорби-стіна джунглів
    return h
E, ST = 44, 1.0; N = int(2 * E / ST) + 1
H = [[height(-E + i * ST, -E + j * ST) for i in range(N)] for j in range(N)]
def hat(x, z):
    fx, fz = (x + E) / ST, (z + E) / ST; i, j = max(0, min(N-2, int(fx))), max(0, min(N-2, int(fz))); tx, tz = fx - i, fz - j
    a, b, c, d = H[j][i], H[j][i+1], H[j+1][i], H[j+1][i+1]; return (a + (b-a)*tx)*(1-tz) + (c + (d-c)*tx)*tz

# ── рельєф ──
me = bpy.data.meshes.new('BR_ArenaTerrain')
verts = [(-E + i * ST, -(-E + j * ST), H[j][i]) for j in range(N) for i in range(N)]
faces = [(j*N+i, (j+1)*N+i, (j+1)*N+i+1, j*N+i+1) for j in range(N-1) for i in range(N-1)]
me.from_pydata(verts, [], faces); me.update()
for p in me.polygons: p.use_smooth = True
G1, G2, G3 = lin('#5fae3c'), lin('#7cc646'), lin('#a3d955')
DIRT, DIRT2, ROCK, MOSS = lin('#c99a5a'), lin('#a97b45'), lin('#8f8a80'), lin('#4f8f3a')
ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
for v in me.vertices:
    x, z, h = v.co.x, -v.co.y, v.co.z
    n1, n2 = fbm(x * 0.06 + 40, z * 0.06 + 11), fbm(x * 0.22 + 3, z * 0.22 + 7)
    g = mix(mix(G1, G2, sstep(0.3, 0.6, n1)), G3, sstep(0.55, 0.8, n2) * 0.6)
    # витоптана земля в центрі й «доріжки» між руїнами
    dc = math.hypot(x, z) + (n2 - 0.5) * 6
    pth = min(abs(x - z * 0.15), abs(z + x * 0.1)) + (n2 - 0.5) * 2.5
    dirt = max(sstep(11, 6, dc), sstep(2.6, 1.2, pth) * sstep(HALF, HALF - 4, max(abs(x), abs(z))))
    g = mix(g, mix(DIRT, DIRT2, n2), dirt * 0.85)
    g = mix(g, mix(ROCK, MOSS, n1), sstep(0.86, 0.7, v.normal.z))
    ca.data[v.index].color = (g[0], g[1], g[2], 1)
me.color_attributes.active_color = ca
mt = bpy.data.materials.get('BR_TerrainMat'); me.materials.append(mt)
terr = bpy.data.objects.new('BR_ArenaTerrain', me); col.objects.link(terr)

# ── руїни: кам'яні блоки з фаскою, мох на верхах ──
rg = bmesh.new()
cl = rg.loops.layers.float_color.new('Col')   # float — лінійні кольори без зсуву sRGB
STONE = [lin('#a69f90'), lin('#958e80'), lin('#b5ad9b'), lin('#8a8476')]
COLS = []
def block(cx, cy, cz, sx, sy, sz, rot=0.0, moss=0.0):
    """блок у three-коорд.: центр (cx, cy — висота, cz), розміри sx (x), sy (y), sz (z)"""
    m = bmesh.new(); bmesh.ops.create_cube(m, size=1.0)
    bmesh.ops.bevel(m, geom=list(m.edges), offset=min(sx, sy, sz) * 0.12, segments=1, affect='EDGES')
    c = R.choice(STONE); top = mix(c, lin('#6aa84a'), moss)
    mat = Matrix.Translation((cx, -cz, cy)) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Diagonal((sx, sz, sy, 1))
    bmesh.ops.transform(m, matrix=mat, verts=m.verts)
    vmap = {}
    for f in m.faces:
        nf = rg.faces.new([vmap.setdefault(v, rg.verts.new(v.co)) for v in f.verts])
        k = 0.85 + R.random() * 0.25
        cc = top if f.normal.z > 0.6 else [ch * k for ch in c]
        for l in nf.loops: l[cl] = (cc[0], cc[1], cc[2], 1)
    m.free()
def wall(x0, z0, x1, z1, hgt, thick=0.9, broken=0.3):
    """стіна з блоків по відрізку; частина верхніх рядів «обвалена»"""
    L = math.hypot(x1 - x0, z1 - z0); n = max(1, int(L / 1.25)); rot = -math.atan2(z1 - z0, x1 - x0)
    rows = max(1, int(round(hgt / 0.7)))
    tops = []
    for i in range(n):
        t = (i + 0.5) / n; cx, cz = x0 + (x1 - x0) * t, z0 + (z1 - z0) * t
        top = rows if R.random() > broken else R.randint(1, max(1, rows - 1))
        tops.append(top)
        gy = hat(cx, cz) - 0.15
        for r in range(top):
            off = (0.3 if r % 2 else 0) * (L / n)
            bw = L / n * (0.96 if r % 2 == 0 else 0.9)
            block(cx + math.cos(-rot) * off * 0.2, gy + 0.35 + r * 0.7, cz - math.sin(-rot) * off * 0.2, bw, 0.68, thick * (0.95 + R.random() * 0.1), rot, moss=0.55 if r == top - 1 else 0)
    # колайдер: для осьових стін — точний AABB по середній висоті
    horiz = abs(z1 - z0) < 0.01
    hh = 0.35 + 0.7 * (sum(tops) / len(tops))
    t = 'wall' if hh > 1.4 else 'low'
    if horiz: COLS.append(dict(t=t, x=round((x0 + x1) / 2, 2), z=round(z0, 2), w=round(L, 2), d=round(thick, 2), h=round(hh, 2)))
    else: COLS.append(dict(t=t, x=round(x0, 2), z=round((z0 + z1) / 2, 2), w=round(thick, 2), d=round(L, 2), h=round(hh, 2)))
def pillar(x, z, hgt):
    gy = hat(x, z) - 0.1
    block(x, gy + 0.25, z, 1.5, 0.5, 1.5)
    k = int(hgt / 0.9)
    for r in range(k): block(x, gy + 0.95 + r * 0.9, z, 1.05, 0.88, 1.05, R.uniform(-0.15, 0.15), moss=0.5 if r == k - 1 else 0)
    COLS.append(dict(t='wall', x=x, z=z, w=1.3, d=1.3, h=round(0.5 + k * 0.9, 2)))
# центральний храм: квадрат 12×12 з проходами
S = 6.0
for s in (-1, 1):
    wall(-S, s * S, -2.0, s * S, 2.8, broken=0.35); wall(2.0, s * S, S, s * S, 2.8, broken=0.35)
    wall(s * S, -S, s * S, -2.0, 2.8, broken=0.35); wall(s * S, 2.0, s * S, S, 2.8, broken=0.35)
for (x, z) in [(-S, -S), (S, -S), (-S, S), (S, S)]: pillar(x, z, 3.6)
block(0, hat(0, 0) + 0.12, 0, 6, 0.24, 6, 0, moss=0.15)   # плита в центрі
EXTRA = []   # прототипи зі Sketchfab (якщо є в BR_Kit): арка над входом, напівкруглі стіни, каміння руїн
# уламки стін і колони по арені
for (x0, z0, x1, z1, hh) in [(-20, -14, -13, -14, 2.2), (13, 14, 20, 14, 2.2), (-14, 19, -14, 13, 1.4), (14, -19, 14, -13, 1.4),
                             (-22, 4, -22, 10, 2.6), (22, -10, 22, -4, 2.6), (-6, -21, 1, -21, 1.4), (-1, 21, 6, 21, 1.4)]:
    wall(x0, z0, x1, z1, hh, broken=0.45)
for (x, z) in [(-11, -6), (11, 6), (-9, 12), (9, -12), (-18, -2), (18, 2), (3, -15), (-3, 15)]: pillar(x, z, R.choice([1.8, 2.7, 3.6]))
rme = bpy.data.meshes.new('BR_Ruins'); rg.to_mesh(rme); rg.free()
for _a in list(rme.color_attributes):
    if _a.name != 'Col': rme.color_attributes.remove(_a)   # інакше в glTF COLOR_0 буде білий атрибут
rme.color_attributes.active_color = rme.color_attributes['Col'] if 'Col' in rme.color_attributes else None
for p in rme.polygons: p.use_smooth = False
rme.materials.append(mt)
ruins = bpy.data.objects.new('BR_Ruins', rme); col.objects.link(ruins)

# ── укриття й реквізит з набору ──
PLACE = []; CRATES = []; BARRELS = []
def dims(name): o = kit[name]; return o.dimensions.x, o.dimensions.y, o.dimensions.z   # Blender: x, y(глибина), z(висота)
def put(name, x, z, rot=0.0, s=1.0, collide=None, sink=0.05):
    y = hat(x, z) - sink
    PLACE.append([name, round(x, 2), round(y, 3), round(z, 2), round(rot, 3), round(s, 3)])
    if collide:
        dx, dy, dz = dims(name)
        w, d = dx * s, dy * s
        if abs(math.sin(rot)) > 0.7: w, d = d, w
        COLS.append(dict(t=collide, x=round(x, 2), z=round(z, 2), w=round(w * 0.92, 2), d=round(d * 0.92, 2), h=round(dz * s, 2)))
Q = math.pi / 2
# мішки з піском (по пояс) — короткі лінії
for (x, z, r) in [(-9, -10, 0), (9, 10, 0), (-16, 8, Q), (16, -8, Q), (0, -11, 0), (0, 11, 0), (-21, -20, 0), (21, 20, 0), (-24, 15, Q), (24, -15, Q)]:
    put('T_sack', x, z, r, 1.0, 'low')
# бетонні загородження й контейнери
for (x, z, r) in [(-12, 18, 0), (12, -18, 0), (19, -20, Q), (-19, 20, Q)]: put('T_barrier', x, z, r, 0.9, 'low')
put('T_containerlong', -20, -8, Q, 1.25, 'wall'); put('T_container', 20, 8, 0, 1.3, 'wall')
# великі камені — укриття
for (x, z, nm, s) in [(-6, 17, 'Rock03', 1.6), (6, -17, 'Rock03', 1.6), (-17, -18, 'Rock05', 1.4), (17, 18, 'Rock05', 1.4), (-24, -3, 'Rock02', 1.8), (24, 3, 'Rock02', 1.8),
                      (4, 9, 'Rock09', 1.5), (-4, -9, 'Rock09', 1.5)]:
    put(nm, x, z, R.uniform(0, 6.28), s, 'wall', sink=0.3)
# намети й вежа-бак (декор біля краю, теж колайдери)
put('Tent', -23, 23, 0.6, 1.4, 'wall'); put('Tent', 23, -23, 3.7, 1.4, 'wall'); put('T_watertank', 23, 23, 0, 1.2, 'wall')
if 'Arch' in kit:
    for s_ in (-1, 1):
        put('Arch', 0, s_ * S, 0 if s_ < 0 else math.pi, 1.0, None, sink=0.1)
        for px in (-2.0, 2.0): COLS.append(dict(t='wall', x=px, z=s_ * S, w=1.0, d=1.4, h=4.3))
if 'RuinShell' in kit:
    for (x, z, r) in [(-16, 0, Q), (16, 0, -Q), (0, -16, 0), (0, 16, math.pi)]:
        put('RuinShell', x, z, r, 1.5, None, sink=0.1)
        dx, dy, dz = dims('RuinShell'); w, d = dx * 1.5, dy * 1.5
        if abs(math.sin(r)) > 0.7: w, d = d, w
        COLS.append(dict(t='low', x=x, z=z, w=round(w * 0.85, 2), d=round(d * 0.6, 2), h=round(dz * 1.5, 2)))
for k in range(26):
    nm = 'RuinRock%d' % R.randint(1, 4)
    if nm not in kit: break
    a = R.uniform(0, 6.28); r = R.uniform(6.5, 24); x, z = math.cos(a) * r, math.sin(a) * r
    if any(abs(x - c['x']) < c['w'] / 2 + 1.2 and abs(z - c['z']) < c['d'] / 2 + 1.2 for c in COLS): continue
    put(nm, x, z, R.uniform(0, 6.28), R.uniform(1.6, 2.6), None, sink=0.1)
# руйнівні ящики й вибухові бочки
CR = [(-3, -3.5), (3.5, 3), (-8, 4), (8, -4), (-13, -11), (13, 11), (-15, 15), (15, -15), (-2, 18), (2, -18), (-19, 2), (19, -2), (-10, -19), (10, 19), (-25, 9), (25, -9), (6, 14), (-6, -14)]
for i, (x, z) in enumerate(CR):
    s = R.choice([1.5, 1.7]); rot = R.choice([0, Q]); y = hat(x, z) - 0.02
    CRATES.append(dict(id=i, x=x, y=round(y, 3), z=z, rot=rot, s=s))
    dx, dy, dz = dims('T_crate'); COLS.append(dict(t='crate', x=x, z=z, w=round(dx * s, 2), d=round(dy * s, 2), h=round(dz * s, 2), id=i))
BR = [(-4, 7), (4, -7), (-12, 1), (12, -1), (-18, -12), (18, 12), (-8, 21), (8, -21), (-22, -24), (22, 24), (0, 0.01)]
for i, (x, z) in enumerate(BR[:-1]):
    y = hat(x, z) - 0.02
    BARRELS.append(dict(id=i, x=x, y=round(y, 3), z=z, s=1.25))
    dx, dy, dz = dims('T_barrel'); COLS.append(dict(t='barrel', x=x, z=z, w=round(dx * 1.25, 2), d=round(dy * 1.25, 2), h=round(dz * 1.25, 2), id=i))
# джунглі навколо (поза межею бою), без колайдерів
TREES = ['T_tree1', 'T_tree3', 'T_tree4', 'T_tree2', 'pine3', 'Palm']
for k in range(1400):
    x, z = R.uniform(-E + 2, E - 2), R.uniform(-E + 2, E - 2)
    d = max(abs(x), abs(z))
    if d < HALF + 1.5 or (d < HALF + 4 and R.random() < 0.5): continue
    if any(math.hypot(x - p[1], z - p[3]) < 2.6 for p in PLACE[-160:] if p[0] in TREES): continue
    nm = R.choice(TREES); s = R.uniform(0.95, 1.4) * (3.4 if nm.startswith('pine') else (1.3 if nm == 'Palm' else 1.0))
    put(nm, x, z, R.uniform(0, 6.28), s, None, sink=0.2)
# кущі/дрібні камені всередині (декор)
for k in range(70):
    x, z = R.uniform(-HALF + 1, HALF - 1), R.uniform(-HALF + 1, HALF - 1)
    if math.hypot(x, z) < 8 or any(abs(x - c['x']) < c['w'] / 2 + 1.5 and abs(z - c['z']) < c['d'] / 2 + 1.5 for c in COLS): continue
    if R.random() < 0.6: put(R.choice(['pine1', 'pine2']), x, z, R.uniform(0, 6.28), R.uniform(1.8, 2.5))
    else: put('Rock%02d' % R.choice([1, 4, 6, 7, 8, 10]), x, z, R.uniform(0, 6.28), R.uniform(0.6, 1.1), None, sink=0.2)

# ── експорт ──
def export_objs(objs, path, **kw):
    tmp = bpy.data.collections.new('EXP_tmp'); sc.collection.children.link(tmp)
    for o in objs: tmp.objects.link(o)
    vl = bpy.context.view_layer; vl.active_layer_collection = vl.layer_collection.children['EXP_tmp']; vl.update()
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=False, use_active_collection=True, export_animations=False, export_yup=True, export_apply=True, **kw)
    for o in objs: tmp.objects.unlink(o)
    bpy.data.collections.remove(tmp)
export_objs([terr, ruins], os.path.join(OUT, 'arena2.glb'), export_vertex_color='ACTIVE', export_materials='EXPORT')
used = sorted({p[0] for p in PLACE} | {'T_crate', 'T_barrel'})
kobjs = [kit[u] for u in used]
saved = [(o, o.location.copy()) for o in kobjs]
for o in kobjs: o.location = (0, 0, 0)
export_objs(kobjs, os.path.join(OUT, 'arena_kit.glb'), export_vertex_color='MATERIAL', export_materials='EXPORT', export_image_format='JPEG', export_jpeg_quality=85)
for o, l in saved: o.location = l
print('ARENA KIT', os.path.getsize(os.path.join(OUT, 'arena_kit.glb')), used)
n = 2 * 36 + 1
hs = [round(hat(-36 + i, -36 + j) * 100) for j in range(n) for i in range(n)]
with open(os.path.join(OUT, 'arena2.json'), 'w') as f:
    json.dump({'half': HALF, 'e': 36, 'step': 1, 'n': n, 'h': hs, 'place': PLACE, 'crates': CRATES, 'barrels': BARRELS, 'cols': COLS}, f, separators=(',', ':'))
for fn in ('arena2.glb', 'arena2.json'): print('ARENA OUT', fn, os.path.getsize(os.path.join(OUT, fn)))
print('ARENA', len(PLACE), 'place', len(COLS), 'cols', len(CRATES), 'crates', len(BARRELS), 'barrels')
