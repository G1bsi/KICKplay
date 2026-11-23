# Шарики 2.0 — карта «Гнев Зевса» (власний дизайн): Олімп над морем хмар, білий мармур і золото.
# Запуск: blender -b --factory-startup --python blender/mb2_zeus.py
# Формат той самий, що в mb2_neon.py (рамки маршруту + тіла обертання + кілки), плюс:
#   bumpers — хмарні бампери (відкидають кульки), storm — ділянки, куди б'ють блискавки, pegsMove=0 — колони не рухаються,
#   statue — місце під статую Зевса (додамо пізніше).
# Маршрут: старт над вирвою → «Гроза» (широкий спуск, низькі борти) → шпилька навколо колони → «Колонада»
#   (храмовий коридор: мармурові стовпчики + бампери) → друга шпилька → «Блискавка» (зигзаг) → храм-фініш.
# Пише public/marbles2/maps/zeus.glb і zeus.json. Координати в JSON — як у three.js: (x, z, −y).
import bpy, bmesh, math, json, os, random
from mathutils import Vector, Matrix
ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'marbles2', 'maps'); os.makedirs(OUT, exist_ok=True)
DS = 0.5
random.seed(51)

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
col = bpy.data.collections.get('MB2Z') or bpy.data.collections.new('MB2Z')
if col.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(col)

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c) + (1,)
def mat(name, hexc, rough=0.4, metal=0.0, emit=None, estr=0.0, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = lin(hexc); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if emit:
        k = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
        b.inputs[k].default_value = lin(emit); b.inputs['Emission Strength'].default_value = estr
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        try: m.blend_method = 'BLEND'
        except Exception: pass
        try: m.surface_render_method = 'BLENDED'
        except Exception: pass
    return m
# назви матеріалів — з префіксом ZS_: mb2.js підміняє їх своїми (мармур, золото, хмари)
M = dict(
    floor=mat('ZS_Marble', '#efe9df', 0.35, 0.0),
    wall=mat('ZS_Glass', '#dff2ff', 0.05, 0.0, alpha=0.2),
    gold=mat('ZS_Gold', '#ffcf5a', 0.25, 1.0, emit='#ffcf5a', estr=2.0),
    under=mat('ZS_Under', '#b9b2a6', 0.6, 0.0),
    column=mat('ZS_Column', '#f4f0e8', 0.45, 0.0),
    cloud=mat('ZS_Cloud', '#ffffff', 0.9, 0.0),
    bumper=mat('ZS_Bumper', '#8fd8ff', 0.2, 0.0, emit='#8fd8ff', estr=3.0),
    gate=mat('ZS_Gate', '#c9a24a', 0.3, 0.8),
)
ML = list(M.values()); MI = {m.name: i for i, m in enumerate(ML)}
def put(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in ML: me.materials.append(m)
    o = bpy.data.objects.new(name, me); col.objects.link(o); return o
def C(v): return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]

# ── маршрут: опорні точки (x, y, z, W, H, Rf, open) ──
CP = [
    (0, 5, 52.0, 5.2, 4.2, 2.0, 0),       # під горлом вирви (високі борти — натовп)
    (0, -8, 50.2, 5.6, 2.6, 2.2, 0),
    (0, -30, 46.6, 6.2, 1.5, 1.3, 0),     # «Гроза»: широко, низькі борти — блискавка викидає за край
    (0, -50, 43.2, 6.2, 1.5, 1.3, 0),
]
def arc(c, R, a0, a1, z0, z1, n, W, H, Rf):
    for k in range(0, n + 1):          # з k=0: дуга починається дотично до прямої — без зламу на вході
        a = math.radians(a0 + (a1 - a0) * k / n)
        CP.append((c[0] + R * math.cos(a), c[1] + R * math.sin(a), z0 + (z1 - z0) * k / n, W, H, Rf, 0))
H1 = (14, -62); arc(H1, 14, 180, 360, 42.4, 37.6, 9, 5.0, 2.6, 2.4)          # шпилька 1 навколо колони
CP += [
    (28, -54, 36.8, 7.5, 1.9, 1.3, 0),    # «Колонада»
    (28, -46, 35.8, 9.0, 1.8, 1.2, 0),
    (28, -22, 32.6, 9.0, 1.8, 1.2, 0),
    (28, -14, 31.8, 6.0, 2.2, 2.0, 0),
]
H2 = (40, -10); arc(H2, 12, 180, 0, 31.2, 27.8, 9, 5.0, 2.6, 2.4)             # шпилька 2 (за годинниковою)
CP += [
    (52, -20, 26.6, 4.3, 2.4, 2.2, 0),    # «Блискавка» — зигзаг (злами плавні: радіус > ширини жолоба)
    (59, -42, 22.6, 4.3, 2.6, 2.4, 0),
    (49, -61, 19.4, 4.3, 2.6, 2.4, 0),
    (59, -82, 15.2, 4.3, 2.6, 2.4, 0),
    (49, -101, 11.6, 4.3, 2.6, 2.4, 0),
    (58, -121, 7.4, 4.3, 2.6, 2.4, 0),
    (54, -134, 5.2, 4.6, 2.4, 2.4, 0),
    (54, -142, 4.4, 4.8, 2.2, 2.4, 0),
    (54, -150, 3.9, 5.0, 2.0, 2.4, 0),    # у храм — до чаші
]

def cr(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
P = [Vector(c[:3]) for c in CP]
dense = []
for i in range(len(P) - 1):
    p0 = P[i - 1] if i > 0 else P[i] * 2 - P[i + 1]
    p3 = P[i + 2] if i + 2 < len(P) else P[i + 1] * 2 - P[i]
    for k in range(24):
        t = k / 24
        par = [CP[i][j] + (CP[i + 1][j] - CP[i][j]) * t for j in (3, 4, 5)]
        dense.append((cr(p0, P[i], P[i + 1], p3, t), par, 0))
dense.append((P[-1], list(CP[-1][3:6]), 0))
L = [0.0]
for i in range(1, len(dense)): L.append(L[-1] + (dense[i][0] - dense[i - 1][0]).length)
fr = []; s = 0.0; j = 0
while s <= L[-1]:
    while j + 1 < len(L) - 1 and L[j + 1] < s: j += 1
    t = (s - L[j]) / max(1e-6, L[j + 1] - L[j])
    a, b = dense[j], dense[j + 1]
    pos = a[0].lerp(b[0], t); par = [a[1][k] + (b[1][k] - a[1][k]) * t for k in range(3)]
    fr.append(dict(p=pos, W=par[0], H=par[1], Rf=min(par[2], par[0]), open=0, s=s))
    s += DS
n = len(fr)
for i, f in enumerate(fr):
    a = fr[max(0, i - 1)]['p']; b = fr[min(n - 1, i + 1)]['p']; f['T'] = (b - a).normalized()
kap = []
for i in range(n):
    t0 = fr[max(0, i - 2)]['T']; t1 = fr[min(n - 1, i + 2)]['T']
    h0 = Vector((t0.x, t0.y, 0)); h1 = Vector((t1.x, t1.y, 0))
    kz = h0.cross(h1).z / (4 * DS) if h0.length > 1e-3 and h1.length > 1e-3 else 0
    kap.append(kz)
roll = [max(-0.44, min(0.44, -math.atan(9.0 * k))) for k in kap]
sm = []
for i in range(n):
    w = [roll[j] for j in range(max(0, i - 8), min(n, i + 9))]; sm.append(sum(w) / len(w))
for i, f in enumerate(fr):
    T = f['T']; up0 = Vector((0, 0, 1)); up0 = (up0 - T * up0.dot(T)).normalized()
    U = (Matrix.Rotation(sm[i], 4, T) @ up0.to_4d()).to_3d().normalized()
    R = T.cross(U).normalized(); U = R.cross(T).normalized()
    f['U'], f['R'] = U, R
def fidx(x, y):   # індекс рамки, найближчої до точки плану (x, y)
    return min(range(n), key=lambda i: (fr[i]['p'].x - x) ** 2 + (fr[i]['p'].y - y) ** 2)

# ── меш траси: мармурова підлога, «кришталеві» борти, золотий кант ──
TH = 0.4; NF = 6; NB = 5
def ring(f):
    W, H, Rf = f['W'], f['H'], f['Rf']; pts = []
    pts.append((-W - TH, H + 0.08, 'ZS_Gold')); pts.append((-W, H + 0.08, 'ZS_Glass'))
    pts.append((-W, Rf, 'ZS_Glass'))
    for k in range(1, NF):
        a = math.pi + k / NF * math.pi / 2; pts.append((-(W - Rf) + Rf * math.cos(a), Rf + Rf * math.sin(a), 'ZS_Marble'))
    for k in range(NB + 1):
        x = -(W - Rf) + 2 * (W - Rf) * k / NB; pts.append((x, 0.0, 'ZS_Marble'))
    for k in range(1, NF):
        a = 1.5 * math.pi + k / NF * math.pi / 2; pts.append(((W - Rf) + Rf * math.cos(a), Rf + Rf * math.sin(a), 'ZS_Marble'))
    pts.append((W, Rf, 'ZS_Glass')); pts.append((W, H + 0.08, 'ZS_Gold'))
    pts.append((W + TH, H + 0.08, 'ZS_Glass')); pts.append((W + TH, 0.2, 'ZS_Gold')); pts.append((W + TH, 0.0, 'ZS_Under')); pts.append((W + TH, -TH, 'ZS_Under'))
    pts.append((-W - TH, -TH, 'ZS_Under')); pts.append((-W - TH, 0.0, 'ZS_Gold')); pts.append((-W - TH, 0.2, 'ZS_Glass'))
    return pts
bm = bmesh.new(); rings = []; vinfo = {}
for f in fr:
    rr = []
    for (x, y, m) in ring(f):
        v = bm.verts.new(f['p'] + f['R'] * x + f['U'] * y); vinfo[v] = (x, f['s']); rr.append(v)
    rings.append(rr)
uvl = bm.loops.layers.uv.new('UVMap')
names = [m for (_, _, m) in ring(fr[0])]
for i in range(n - 1):
    A, B = rings[i], rings[i + 1]; m = len(A)
    for k in range(m):
        k1 = (k + 1) % m
        face = bm.faces.new((A[k], A[k1], B[k1], B[k])); face.material_index = MI[names[k]]; face.smooth = True
        for lp in face.loops:
            x, sv = vinfo[lp.vert]; lp[uvl].uv = (x * 0.25 + 0.5, sv * 0.25)
try: f2 = bm.faces.new(rings[0]); f2.material_index = MI['ZS_Under']
except ValueError: pass
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
put('ZS_Track', bm)

# ── перевірка перетинів: траса сама з собою + мінімальний радіус повороту (вивід у консоль) ──
def track_report():
    bad = []
    for i in range(0, n, 4):
        for j in range(i + 60, n, 4):
            a, b = fr[i]['p'], fr[j]['p']
            dz = abs(a.z - b.z); dh = Vector((a.x - b.x, a.y - b.y)).length
            if dh < fr[i]['W'] + fr[j]['W'] + 1.4 and dz < max(fr[i]['H'], fr[j]['H']) + 1.2:
                bad.append((i, j, round(dh, 1), round(dz, 1)))
    # горизонтальний радіус повороту: якщо він менший за ширину жолоба — внутрішній борт «складається» сам у себе
    tight = []
    for i in range(3, n - 3):
        a, b = fr[i - 3]['T'], fr[i + 3]['T']
        a2, b2 = Vector((a.x, a.y)), Vector((b.x, b.y))
        if a2.length < 1e-3 or b2.length < 1e-3: continue
        ang = a2.angle(b2, 0)
        if ang > 1e-4:
            r = (6 * DS) / ang
            if r < fr[i]['W'] + 2.0: tight.append((i, round(r, 1), round(fr[i]['W'], 1)))
    print('TRACK CHECK overlaps', len(bad), bad[:6], 'tight turns', len(tight), tight[:12])
track_report()

# ── тіла обертання: вирва (мармур + золотий обідок) і фінішна чаша ──
def lathe(name, c, prof, matn, rim=None, N=72):
    bm = bmesh.new(); rs = []
    for i in range(N):
        a = i / N * 2 * math.pi; ca, sa = math.cos(a), math.sin(a)
        rs.append([bm.verts.new((c.x + r * ca, c.y + r * sa, c.z + z)) for (r, z) in prof])
    for i in range(N):
        A, B = rs[i], rs[(i + 1) % N]
        for j in range(len(prof) - 1):
            f = bm.faces.new((A[j], A[j + 1], B[j + 1], B[j])); f.material_index = MI[matn]; f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = put(name, bm)
    if rim:
        r0, z0 = rim; b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=False, segments=96, radius1=r0 + 0.3, radius2=r0 + 0.3, depth=0.4)
        b2.transform(Matrix.Translation(c + Vector((0, 0, z0))))
        for f in b2.faces: f.material_index = MI['ZS_Gold']
        put(name + '_Rim', b2)
    return o
FC = Vector((0, 0, 54.0))
FUN = [(4.0, 0.0), (4.0, 2.5), (8.0, 6.0), (12.5, 10.0), (17.0, 14.0), (17.0, 16.0)]
lathe('ZS_Funnel', FC, FUN + [(17.4, 16.0), (17.4, 13.6), (4.4, 2.2), (4.4, 0.0)], 'ZS_Marble', rim=(17.0, 16.0))
fe = fr[-1]
_th = Vector((fe['T'].x, fe['T'].y, 0)).normalized()
BC = Vector((fe['p'].x, fe['p'].y, fe['p'].z - 4.2 - 0.9)) + _th * (9.6 - 0.3)   # край чаші під кінцем жолоба
BOWL = [(0.0, 0.0), (5.0, 0.3), (8.6, 1.2), (9.6, 3.2), (9.6, 4.2)]
lathe('ZS_Bowl', BC, BOWL + [(10.0, 4.2), (10.0, -0.4), (0.0, -0.4)], 'ZS_Gold', rim=(9.6, 4.2))

# ── контейнер: «кришталеві» стінки + золота рамка, дно-ворота (ZS_GATE ховається на старті) ──
CZ = 72.0; CH = 11.5; CWH = 6.5
def box(name, c, half, matn):
    b = bmesh.new(); bmesh.ops.create_cube(b, size=2.0)
    b.transform(Matrix.Translation(c) @ Matrix.Diagonal(Vector((half[0], half[1], half[2], 1))))
    for f in b.faces: f.material_index = MI[matn]
    return put(name, b)
box('ZS_GATE', Vector((0, 0, CZ - 0.2)), (CH + 0.3, CH + 0.3, 0.2), 'ZS_Gate')
for nm, c, h in (('N', (0, CH + 0.15, CZ + CWH / 2), (CH + 0.3, 0.15, CWH / 2)), ('S', (0, -CH - 0.15, CZ + CWH / 2), (CH + 0.3, 0.15, CWH / 2)),
                 ('E', (CH + 0.15, 0, CZ + CWH / 2), (0.15, CH, CWH / 2)), ('W', (-CH - 0.15, 0, CZ + CWH / 2), (0.15, CH, CWH / 2))):
    box('ZS_Box' + nm, Vector(c), h, 'ZS_Glass')
for sx in (-1, 1):
    for sy in (-1, 1):
        box('ZS_BoxPost', Vector((sx * (CH + 0.3), sy * (CH + 0.3), CZ + CWH / 2)), (0.3, 0.3, CWH / 2 + 0.2), 'ZS_Gold')
    box('ZS_BoxTopX', Vector((0, sx * (CH + 0.3), CZ + CWH)), (CH + 0.5, 0.2, 0.2), 'ZS_Gold')
    box('ZS_BoxTopY', Vector((sx * (CH + 0.3), 0, CZ + CWH)), (0.2, CH + 0.5, 0.2), 'ZS_Gold')

# ── «Колонада»: мармурові стовпчики (не рухаються) + хмарні бампери ──
pegs = []; bumpers = []
s_a = next(f['s'] for f in fr if f['W'] > 8.6); s_b = max(f['s'] for f in fr if f['W'] > 8.6)
PR = 0.42; PH = 1.6
row = 0; s = s_a + 2.5
while s < s_b - 2.0:
    f = fr[int(s / DS)]
    for k in range(-3, 4):
        x = (k + (0.5 if row % 2 else 0)) * 2.6
        if abs(x) > f['W'] - 1.5: continue
        pegs.append(dict(p=f['p'] + f['R'] * x + f['U'] * (PH / 2), a=f['U'].copy(), r=PR, h=PH / 2, i=int(s / DS)))
    row += 1; s += 3.2
# бампери — серед колонади, шахово; кілки поруч із ними прибираємо
BR = 1.15; BH = 0.7
for (u, x) in ((0.28, -3.2), (0.42, 3.4), (0.58, 0.0), (0.74, -3.6), (0.86, 3.0)):
    f = fr[int((s_a + (s_b - s_a) * u) / DS)]
    bp = f['p'] + f['R'] * x + f['U'] * BH
    pegs = [p for p in pegs if (p['p'] - bp).length > BR + PR + 1.1]
    bumpers.append(dict(p=bp, a=f['U'].copy(), r=BR, h=BH, i=int(f['s'] / DS)))
bm = bmesh.new()
def add_cyl(bm, p, a, r, depth, matn, seg=18, smooth=True):
    b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=depth)
    z = a; x = z.orthogonal().normalized(); y = z.cross(x)
    M4 = Matrix((x, y, z)).transposed().to_4x4(); M4.translation = p; b2.transform(M4)
    vm = {v: bm.verts.new(v.co) for v in b2.verts}
    for f in b2.faces:
        nf = bm.faces.new([vm[v] for v in f.verts]); nf.material_index = MI[matn]; nf.smooth = smooth
    b2.free()
for pg in pegs:
    add_cyl(bm, pg['p'], pg['a'], PR, PH, 'ZS_Column')
    add_cyl(bm, pg['p'] + pg['a'] * (PH / 2 + 0.06), pg['a'], PR + 0.08, 0.14, 'ZS_Gold', smooth=False)   # золота капітель
put('ZS_Pegs', bm)
for k, bp in enumerate(bumpers):
    bm = bmesh.new()
    add_cyl(bm, bp['p'], bp['a'], BR, BH * 2, 'ZS_Bumper', seg=32)
    add_cyl(bm, bp['p'] + bp['a'] * (BH + 0.05), bp['a'], BR + 0.12, 0.12, 'ZS_Gold', seg=32, smooth=False)
    put('ZS_Bumper_%d' % k, bm)

# ── декор: великі колони в центрах шпильок, колонада обабіч, храм на фініші, постамент під Зевса, хмари ──
def column(name, x, y, z0, z1, r):
    bm = bmesh.new()
    b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=True, segments=28, radius1=r, radius2=r * 0.9, depth=z1 - z0)
    b2.transform(Matrix.Translation(Vector((x, y, (z0 + z1) / 2))))
    for f in b2.faces: f.material_index = MI['ZS_Column']; f.smooth = True
    bm2 = b2; o = put(name, bm2)
    box(name + '_Cap', Vector((x, y, z1 + 0.35)), (r * 1.35, r * 1.35, 0.35), 'ZS_Gold')
    box(name + '_Base', Vector((x, y, z0 + 0.4)), (r * 1.3, r * 1.3, 0.4), 'ZS_Column')
    return o
column('ZS_Pillar1', H1[0], H1[1], -12, 44, 3.0)
column('ZS_Pillar2', H2[0], H2[1], -12, 33, 2.6)
# колонада обабіч коридору: колони кожні 6 м + золотий архітрав
ca = s_a - 3; cb = s_b + 2
k = 0; s = ca
while s <= cb:
    f = fr[int(s / DS)]
    for sx in (-1, 1):
        base = f['p'] + f['R'] * sx * (f['W'] + 1.6)
        column('ZS_ColL%d_%d' % (k, sx), base.x, base.y, base.z - 0.4, base.z + 7.5, 0.55)
    k += 1; s += 6.0
for sx in (-1, 1):
    fa, fb = fr[int(ca / DS)], fr[int(cb / DS)]
    pa = fa['p'] + fa['R'] * sx * (fa['W'] + 1.6); pb = fb['p'] + fb['R'] * sx * (fb['W'] + 1.6)
    mid = (pa + pb) / 2; d = pb - pa
    b = bmesh.new(); bmesh.ops.create_cube(b, size=1.0)
    ang = math.atan2(d.y, d.x)
    b.transform(Matrix.Translation(Vector((mid.x, mid.y, (pa.z + pb.z) / 2 + 8.4))) @ Matrix.Rotation(ang, 4, 'Z') @ Matrix.Rotation(math.atan2(pb.z - pa.z, Vector((d.x, d.y)).length), 4, 'Y').inverted()
                @ Matrix.Diagonal(Vector((d.length + 1.6, 1.0, 0.7, 1))))
    for f in b.faces: f.material_index = MI['ZS_Gold']
    put('ZS_Architrave', b)
# храм над фінішною чашею: 8 колон по колу + золотий фриз
# храм ширший за чашу, з проходом там, де заходить траса (і камера фінішу)
ent = math.atan2(fe['p'].y - BC.y, fe['p'].x - BC.x)
for k in range(8):
    a = ent + math.pi / 8 + k / 8 * 2 * math.pi
    if abs(math.atan2(math.sin(a - ent), math.cos(a - ent))) < 0.5 or abs(math.atan2(math.sin(a - ent - 0.9), math.cos(a - ent - 0.9))) < 0.45: continue
    column('ZS_Temple%d' % k, BC.x + 16 * math.cos(a), BC.y + 16 * math.sin(a), BC.z - 0.5, BC.z + 13, 0.8)
b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=False, segments=64, radius1=16.9, radius2=16.9, depth=1.0)
b2.transform(Matrix.Translation(BC + Vector((0, 0, 13.9))))
for f in b2.faces: f.material_index = MI['ZS_Gold']
put('ZS_TempleFrieze', b2)
# постамент під статую Зевса (між «Грозою» і «Колонадою»)
STAT = Vector((11.6, -32.0, 30.0))
box('ZS_Plinth', Vector((STAT.x, STAT.y, (STAT.z - 14) / 2 - 1)), (3.6, 3.6, (STAT.z + 14) / 2 - 1), 'ZS_Column')
box('ZS_PlinthTop', Vector((STAT.x, STAT.y, STAT.z - 0.4)), (4.0, 4.0, 0.4), 'ZS_Gold')
# море хмар унизу + кілька хмаринок поруч із трасою
def cloud(name, c, sc):
    bm = bmesh.new()
    for k in range(5):
        b2 = bmesh.new(); bmesh.ops.create_icosphere(b2, subdivisions=2, radius=sc * random.uniform(0.6, 1.0))
        off = Vector((random.uniform(-1.3, 1.3) * sc, random.uniform(-0.8, 0.8) * sc, random.uniform(-0.2, 0.35) * sc))
        b2.transform(Matrix.Translation(c + off) @ Matrix.Diagonal(Vector((1.0, 1.0, 0.62, 1))))
        vm = {v: bm.verts.new(v.co) for v in b2.verts}
        for f in b2.faces:
            nf = bm.faces.new([vm[v] for v in f.verts]); nf.material_index = MI['ZS_Cloud']; nf.smooth = True
        b2.free()
    put(name, bm)
for k in range(46):
    x = random.uniform(-70, 120); y = random.uniform(-200, 50)
    cloud('ZS_CloudSea%d' % k, Vector((x, y, random.uniform(-16, -8))), random.uniform(6, 11))
def clear_of_track(c, rad):
    for i in range(0, n, 3):
        if (fr[i]['p'] - c).length < rad + fr[i]['W'] + 3.0: return False
    if (Vector((c.x - FC.x, c.y - FC.y)).length < 22 and c.z > FC.z - 4) or (c - BC).length < rad + 20: return False
    if Vector((c.x - STAT.x, c.y - STAT.y)).length < rad + 6: return False
    return True
placed = 0; tries = 0
while placed < 12 and tries < 400:
    tries += 1
    f = fr[random.randrange(30, n - 30)]
    rad = random.uniform(2.2, 3.6)
    c = f['p'] + f['R'] * random.choice((-1, 1)) * random.uniform(12, 22) + Vector((0, 0, random.uniform(-6, 2)))
    if not clear_of_track(c, rad * 2.2): continue
    cloud('ZS_CloudMid%d' % placed, c, rad); placed += 1

# ── «Гроза»: ділянки, куди б'ють блискавки (індекси рамок) ──
storm = [[fidx(0, -14), fidx(0, -52)], [fidx(59, -42), fidx(58, -121)]]

# ── експорт ──
data = dict(version=1, ds=DS, ballR=0.5, theme='zeus', pegsMove=0,
    frames=dict(p=[C(f['p']) for f in fr], T=[C(f['T']) for f in fr], U=[C(f['U']) for f in fr], R=[C(f['R']) for f in fr],
                W=[round(f['W'], 3) for f in fr], H=[round(f['H'], 3) for f in fr], Rf=[round(f['Rf'], 3) for f in fr], open=[0 for f in fr]),
    funnel=dict(c=C(FC), prof=FUN, exitY=round(FC.z - 0.3, 3)),
    bowl=dict(c=C(BC), prof=BOWL),
    box=dict(c=C(Vector((0, 0, CZ))), half=CH, h=CWH),
    pegs=[dict(p=C(p['p']), a=C(p['a']), r=p['r'], h=p['h'], i=p['i']) for p in pegs],
    bumpers=[dict(p=C(b['p']), a=C(b['a']), r=b['r'], h=b['h'], i=b['i']) for b in bumpers],
    storm=storm,
    statue=dict(c=C(STAT), h=34),
    eliminate=1)
with open(os.path.join(OUT, 'zeus.json'), 'w') as fjs: json.dump(data, fjs, separators=(',', ':'))
for s_ in bpy.context.selected_objects: s_.select_set(False)
for o in col.objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'zeus.glb'), export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'mb2_zeus.blend'))
print('ZEUS OK frames', n, 'len', round(fr[-1]['s'], 1), 'pegs', len(pegs), 'bumpers', len(bumpers), 'storm', storm,
      'glb', os.path.getsize(os.path.join(OUT, 'zeus.glb')), 'json', os.path.getsize(os.path.join(OUT, 'zeus.json')))
