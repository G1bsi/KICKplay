# Шарики 2.0 — карта «Неоновий каскад» (власний дизайн).
# Запуск: blender -b --factory-startup --python blender/mb2_neon.py
# Будує трасу з тих самих параметрів, з яких гра рахує фізику (public/marbles2/mb2.js):
#   маршрут = рамки через кожні 0.5 м (позиція, напрям, «вгору», ширина W, висота борту H, радіус заокруглення Rf, open — провал),
#   вирва під контейнером і фінішна чаша — тіла обертання (профіль r(z)), кілки — циліндри.
# Пише public/marbles2/maps/neon.glb (показ) і neon.json (фізика). Координати в JSON — як у three.js: (x, z, −y).
import bpy, bmesh, math, json, os
from mathutils import Vector, Matrix
ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'marbles2', 'maps'); os.makedirs(OUT, exist_ok=True)
DS = 0.5

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
col = bpy.data.collections.get('MB2') or bpy.data.collections.new('MB2')
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
M = dict(
    floor=mat('MB2_Floor', '#1b2342', 0.28, 0.35),
    wall=mat('MB2_Glass', '#7fd3ff', 0.05, 0.0, alpha=0.22),
    neon=mat('MB2_NeonCyan', '#5ff4ff', 0.3, 0.0, emit='#5ff4ff', estr=6.0),
    pink=mat('MB2_NeonPink', '#ff4fd8', 0.3, 0.0, emit='#ff4fd8', estr=5.0),
    gold=mat('MB2_NeonGold', '#ffc94a', 0.3, 0.0, emit='#ffc94a', estr=5.0),
    under=mat('MB2_Under', '#0c0f1e', 0.6, 0.2),
    tower=mat('MB2_Tower', '#141a33', 0.35, 0.5),
    gate=mat('MB2_Gate', '#2a3566', 0.25, 0.4),
)
ML = list(M.values()); MI = {m.name: i for i, m in enumerate(ML)}
def put(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in ML: me.materials.append(m)
    o = bpy.data.objects.new(name, me); col.objects.link(o); return o
def C(v): return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]

# ── маршрут: опорні точки (x, y, z, W, H, Rf, open) ──
CP = [
    (0, 5, 42.0, 4.8, 4.6, 2.0, 0),      # під горлом вирви (високі борти — натовп)
    (0, -12, 39.6, 4.8, 3.4, 2.0, 0),
    (-10, -28, 37.2, 4.0, 2.4, 4.0, 0),   # змійка — напівтруба
    (-4, -46, 34.8, 4.0, 2.4, 4.0, 0),
    (10, -60, 32.4, 4.0, 2.4, 4.0, 0),
    (4, -78, 30.0, 4.0, 2.4, 4.0, 0),
    (0, -90, 28.4, 6.0, 1.9, 1.6, 0),     # розширення під кілки
    (0, -99, 27.0, 9.0, 1.7, 1.2, 0),     # поле кілків
    (0, -131, 21.4, 9.0, 1.7, 1.2, 0),
    (0, -138, 19.8, 5.0, 2.2, 2.2, 0),    # розгін (крутий)
    (0, -156, 14.6, 4.2, 2.2, 2.0, 0),
    (0, -162, 14.3, 4.2, 2.2, 2.0, 0),
    (0, -165, 14.8, 4.2, 2.2, 2.0, 0),    # трамплін (губа)
    (0, -167, 15.0, 4.2, 2.2, 2.0, 1),    # провал (губа ще йде вгору — виліт під кутом)
    (0, -170, 13.85, 4.2, 2.2, 2.0, 1),
    (0, -172.5, 12.9, 6.0, 2.8, 2.8, 0),    # приземлення (широко, нижче губи — повільні не долітають)
    (0, -180, 12.35, 5.0, 2.6, 2.6, 0),
    (0, -186, 12.0, 4.4, 2.4, 2.6, 0),
]
# спіраль на 2 оберти навколо вежі (проти год. стрілки, вхід з напрямом −y)
HC = Vector((14, -192)); HR = 14.0
hz0, hz1 = 11.8, 1.6
N = 48
for k in range(1, N + 1):
    a = math.pi + k / N * 4 * math.pi
    CP.append((HC.x + HR * math.cos(a), HC.y + HR * math.sin(a), hz0 + (hz1 - hz0) * k / N, 4.2, 2.4, 3.0, 0))
CP += [(0, -204, 1.0, 4.4, 2.2, 2.4, 0), (0, -214, 0.4, 4.6, 2.0, 2.4, 0)]

# Catmull-Rom (позиція), лінійно — параметри
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
        op = CP[i][6] if t < 0.5 else CP[i + 1][6]
        op = 1 if (CP[i][6] and CP[i + 1][6]) or (CP[i][6] and t < 0.5) or (CP[i + 1][6] and t >= 0.5) else 0
        dense.append((cr(p0, P[i], P[i + 1], p3, t), par, op))
dense.append((P[-1], list(CP[-1][3:6]), CP[-1][6]))
# рівномірна вибірка через DS
L = [0.0]
for i in range(1, len(dense)): L.append(L[-1] + (dense[i][0] - dense[i - 1][0]).length)
fr = []; s = 0.0; j = 0
while s <= L[-1]:
    while j + 1 < len(L) - 1 and L[j + 1] < s: j += 1
    t = (s - L[j]) / max(1e-6, L[j + 1] - L[j])
    a, b = dense[j], dense[j + 1]
    pos = a[0].lerp(b[0], t); par = [a[1][k] + (b[1][k] - a[1][k]) * t for k in range(3)]
    fr.append(dict(p=pos, W=par[0], H=par[1], Rf=min(par[2], par[0]), open=a[2] if t < 0.5 else b[2], s=s))
    s += DS
n = len(fr)
# напрям, автоматичний крен віражів за кривизною, «вгору», «вправо»
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

# ── меш траси: переріз — U з заокругленнями, товщина TH, неоновий кант по верху бортів ──
TH = 0.35; NF = 6; NB = 5
def ring(f):
    W, H, Rf = f['W'], f['H'], f['Rf']; pts = []   # (x, y, matname)
    pts.append((-W - TH, H + 0.06, 'MB2_NeonCyan')); pts.append((-W, H + 0.06, 'MB2_Glass'))
    pts.append((-W, Rf, 'MB2_Glass'))
    for k in range(1, NF):
        a = math.pi + k / NF * math.pi / 2; pts.append((-(W - Rf) + Rf * math.cos(a), Rf + Rf * math.sin(a), 'MB2_Floor'))
    for k in range(NB + 1):
        x = -(W - Rf) + 2 * (W - Rf) * k / NB; pts.append((x, 0.0, 'MB2_Floor'))
    for k in range(1, NF):
        a = 1.5 * math.pi + k / NF * math.pi / 2; pts.append(((W - Rf) + Rf * math.cos(a), Rf + Rf * math.sin(a), 'MB2_Floor'))
    pts.append((W, Rf, 'MB2_Glass')); pts.append((W, H + 0.06, 'MB2_NeonCyan'))
    # зовнішній бік борту теж скляний (кульок видно збоку), низ жолоба — непрозорий
    pts.append((W + TH, H + 0.06, 'MB2_Glass')); pts.append((W + TH, 0.3, 'MB2_Under')); pts.append((W + TH, -TH, 'MB2_Under'))
    pts.append((-W - TH, -TH, 'MB2_Under')); pts.append((-W - TH, 0.3, 'MB2_Glass'))
    return pts
bm = bmesh.new(); rings = []; vinfo = {}
for f in fr:
    rr = []
    for (x, y, m) in ring(f):
        v = bm.verts.new(f['p'] + f['R'] * x + f['U'] * y); vinfo[v] = (x, f['s']); rr.append(v)
    rings.append(rr)
uvl = bm.loops.layers.uv.new('UVMap')   # u — поперек (м), v — уздовж (м): розмітка на підлозі
names = [m for (_, _, m) in ring(fr[0])]
for i in range(n - 1):
    if fr[i]['open'] and fr[i + 1]['open']: continue
    if fr[i]['open'] or fr[i + 1]['open']: continue
    A, B = rings[i], rings[i + 1]; m = len(A)
    for k in range(m):
        k1 = (k + 1) % m
        face = bm.faces.new((A[k], A[k1], B[k1], B[k])); face.material_index = MI[names[k]]; face.smooth = True
        for lp in face.loops:
            x, sv = vinfo[lp.vert]; lp[uvl].uv = (x * 0.25 + 0.5, sv * 0.25)
# торці на початку, перед і після провалу, в кінці
for i in range(n):
    if (i == 0) or (not fr[i]['open'] and (i + 1 < n and fr[i + 1]['open'])) or (not fr[i]['open'] and i > 0 and fr[i - 1]['open']):
        try: f2 = bm.faces.new(rings[i]); f2.material_index = MI['MB2_Under']
        except ValueError: pass
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
put('MB2_Track', bm)

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

# ── тіла обертання: вирва під контейнером і фінішна чаша ──
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
        r0, z0 = rim; b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=False, segments=96, radius1=r0 + 0.25, radius2=r0 + 0.25, depth=0.3)
        b2.transform(Matrix.Translation(c + Vector((0, 0, z0))));
        for f in b2.faces: f.material_index = MI['MB2_NeonCyan']
        put(name + '_Rim', b2)
    return o
FC = Vector((0, 0, 44.0))
FUN = [(4.0, 0.0), (4.0, 2.5), (8.0, 6.0), (12.5, 10.0), (17.0, 14.0), (17.0, 16.0)]
lathe('MB2_Funnel', FC, [(r, z) for (r, z) in FUN] + [(17.4, 16.0), (17.4, 13.6), (4.4, 2.2), (4.4, 0.0)], 'MB2_Floor', rim=(17.0, 16.0))
_fe = fr[-1]; _th = Vector((_fe['T'].x, _fe['T'].y, 0)).normalized()
BC = Vector((_fe['p'].x, _fe['p'].y, _fe['p'].z - 4.2 - 0.9)) + _th * (9.6 - 0.3)   # край чаші під кінцем жолоба
BOWL = [(0.0, 0.0), (5.0, 0.3), (8.6, 1.2), (9.6, 3.2), (9.6, 4.2)]
lathe('MB2_Bowl', BC, BOWL + [(10.0, 4.2), (10.0, -0.4), (0.0, -0.4)], 'MB2_Floor', rim=(9.6, 4.2))
# ── контейнер на старті: скло + неонова рамка, дно-ворота (MB2_GATE ховається на старті) ──
CZ = 62.0; CH = 11.5; CWH = 6.5
def box(name, c, half, matn):
    b = bmesh.new(); bmesh.ops.create_cube(b, size=2.0)
    b.transform(Matrix.Translation(c) @ Matrix.Diagonal(Vector((half[0], half[1], half[2], 1))))
    for f in b.faces: f.material_index = MI[matn]
    return put(name, b)
box('MB2_GATE', Vector((0, 0, CZ - 0.2)), (CH + 0.3, CH + 0.3, 0.2), 'MB2_Gate')
for nm, c, h in (('N', (0, CH + 0.15, CZ + CWH / 2), (CH + 0.3, 0.15, CWH / 2)), ('S', (0, -CH - 0.15, CZ + CWH / 2), (CH + 0.3, 0.15, CWH / 2)),
                 ('E', (CH + 0.15, 0, CZ + CWH / 2), (0.15, CH, CWH / 2)), ('W', (-CH - 0.15, 0, CZ + CWH / 2), (0.15, CH, CWH / 2))):
    box('MB2_Box' + nm, Vector(c), h, 'MB2_Glass')
for sx in (-1, 1):
    for sy in (-1, 1):
        box('MB2_BoxPost', Vector((sx * (CH + 0.3), sy * (CH + 0.3), CZ + CWH / 2)), (0.18, 0.18, CWH / 2 + 0.1), 'MB2_NeonCyan')
    box('MB2_BoxTopX', Vector((0, sx * (CH + 0.3), CZ + CWH)), (CH + 0.3, 0.12, 0.12), 'MB2_NeonCyan')
    box('MB2_BoxTopY', Vector((sx * (CH + 0.3), 0, CZ + CWH)), (0.12, CH + 0.3, 0.12), 'MB2_NeonCyan')
# ── кілки на полі (рядки через 2.6 м, шаховий порядок) ──
pegs = []; s_a = None; s_b = None
for f in fr:
    if f['W'] > 8.5 and s_a is None: s_a = f['s']
    if f['W'] > 8.5: s_b = f['s']
PR = 0.32; PH = 1.3
row = 0; s = s_a + 2.0
while s < s_b - 2.0:
    f = fr[int(s / DS)]
    for k in range(-4, 5):
        x = (k + (0.5 if row % 2 else 0)) * 2.3
        if abs(x) > f['W'] - 1.4: continue
        base = f['p'] + f['R'] * x
        pegs.append(dict(p=base + f['U'] * (PH / 2), a=f['U'].copy(), r=PR, h=PH / 2, i=int(s / DS)))
    row += 1; s += 2.6
bm = bmesh.new()
for pg in pegs:
    b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=True, segments=14, radius1=PR, radius2=PR, depth=PH)
    z = pg['a']; x = z.orthogonal().normalized(); y = z.cross(x)
    M4 = Matrix((x, y, z)).transposed().to_4x4(); M4.translation = pg['p']; b2.transform(M4)
    # корпус — темний метал, зверху — неонова «шапочка»
    b3 = bmesh.new(); bmesh.ops.create_cone(b3, cap_ends=True, segments=14, radius1=PR + 0.05, radius2=PR + 0.05, depth=0.16)
    M5 = M4.copy(); M5.translation = pg['p'] + z * (PH / 2 + 0.02); b3.transform(M5)
    for src, mat in ((b2, 'MB2_Tower'), (b3, 'MB2_NeonPink')):
        vm = {v: bm.verts.new(v.co) for v in src.verts}
        for f in src.faces:
            nf = bm.faces.new([vm[v] for v in f.verts]); nf.material_index = MI[mat]; nf.smooth = mat == 'MB2_Tower'
        src.free()
put('MB2_Pegs', bm)
# ── вежа в центрі спіралі з неоновими кільцями ──
b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=True, segments=32, radius1=3.2, radius2=2.4, depth=26)
b2.transform(Matrix.Translation(Vector((HC.x, HC.y, 0.0))))
for f in b2.faces: f.material_index = MI['MB2_Tower']
put('MB2_Tower', b2)
for k in range(6):
    b2 = bmesh.new(); bmesh.ops.create_cone(b2, cap_ends=False, segments=48, radius1=3.3 - k * 0.12, radius2=3.3 - k * 0.12, depth=0.25)
    b2.transform(Matrix.Translation(Vector((HC.x, HC.y, -8 + k * 4.0))))
    for f in b2.faces: f.material_index = MI['MB2_NeonGold' if k % 2 else 'MB2_NeonPink']
    put('MB2_TowerRing', b2)
# ── фінішна арка над кінцем траси ──
fe = fr[-11]   # арка — за 5 м до кінця жолоба (кінець нависає над чашею)
for sx in (-1, 1):
    box('MB2_ArchPost', fe['p'] + fe['R'] * sx * (fe['W'] + 1.0) + Vector((0, 0, 3.2)), (0.3, 0.3, 3.4), 'MB2_NeonGold')
box('MB2_ArchTop', fe['p'] + Vector((0, 0, 6.6)), (fe['W'] + 1.3, 0.3, 0.3), 'MB2_NeonGold')

# ── бусти: вхід у спіраль, ~2 м до неї + перші ~14 м (світні стрілки на підлозі, кульки розганяються на весь спуск) ──
_hel = [i for i, f in enumerate(fr) if abs(Vector((f['p'].x - HC.x, f['p'].y - HC.y)).length - HR) < 0.7 and f['p'].z < hz0 + 0.5]
_hs = min(_hel)
boost = [[max(0, _hs - 4), _hs + 28]]
print('BOOST', boost, 'helix start', _hs, 'of', n)
# ── експорт фізики ──
fin_i = n - 1
data = dict(version=1, ds=DS, ballR=0.5,
    frames=dict(p=[C(f['p']) for f in fr], T=[C(f['T']) for f in fr], U=[C(f['U']) for f in fr], R=[C(f['R']) for f in fr],
                W=[round(f['W'], 3) for f in fr], H=[round(f['H'], 3) for f in fr], Rf=[round(f['Rf'], 3) for f in fr], open=[int(f['open']) for f in fr]),
    funnel=dict(c=C(FC), prof=FUN, exitY=round(FC.z - 0.3, 3)),
    bowl=dict(c=C(BC), prof=BOWL),
    box=dict(c=C(Vector((0, 0, CZ))), half=CH, h=CWH),
    pegs=[dict(p=C(p['p']), a=C(p['a']), r=p['r'], h=p['h'], i=p['i']) for p in pegs],
    tower=dict(c=C(Vector((HC.x, HC.y, 0))), r=3.2, hr=HR, z0=hz0, z1=hz1),
    boost=boost,
    eliminate=1)
with open(os.path.join(OUT, 'neon.json'), 'w') as fjs: json.dump(data, fjs, separators=(',', ':'))
for s_ in bpy.context.selected_objects: s_.select_set(False)
for o in col.objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'neon.glb'), export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'mb2_neon.blend'))
print('MB2 OK frames', n, 'len', round(fr[-1]['s'], 1), 'pegs', len(pegs), 'glb', os.path.getsize(os.path.join(OUT, 'neon.glb')), 'json', os.path.getsize(os.path.join(OUT, 'neon.json')))
