# Батл Рояль 2.0 — острів (лобі), арена фіналу, бієць і реквізит. Власний дизайн, мультяшний стиль.
# Запуск: E:\Blender\blender.exe -b --factory-startup --python blender/br_build.py
# Пише в public/models/br/:
#   island.glb  — BR_Terrain (рельєф із вершинними кольорами), BR_Props (будинки, дерева, база, маяк… злиті в один меш)
#   island.json — висоти рельєфу (сітка 1 од.) + «підошви» споруд, щоб десант не падав на дах
#   arena.glb   — BR_ArenaStatic (стіни, контейнери, бетон) + окремі BR_Crate_<i> (руйнуються) і BR_Barrel_<i> (вибухають)
#   arena.json  — колайдери арени (AABB), ящики, бочки
#   kit.glb     — частини бійця BR_Torso/Head/ArmL/ArmR/LegL/LegR/Gun, парашут BR_Chute, літак BR_Plane,
#                 ракета BR_Missile, граната BR_Grenade, корона BR_Crown
# Усе будується в координатах three.js (x, y — вгору, z) і перед записом обертається в Blender (x, −z, y).
# Колір — вершинний (COLOR_0). Пурпур (1,0,1) = «фарба гравця»: шейдер у грі підставляє колір бійця.
import bpy, bmesh, math, os, json, random
from mathutils import Vector, Matrix

ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'models', 'br'); os.makedirs(OUT, exist_ok=True)
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
col = bpy.data.collections.new('BR'); bpy.context.scene.collection.children.link(col)
MAT = bpy.data.materials.new('BR_Toon'); MAT.use_nodes = True

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)
TINT = (1.0, 0.0, 1.0)
def shade(c, k):  # c — лінійний колір
    return tuple(max(0.0, min(1.0, v * k)) for v in c)
def mixc(a, b, t): return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

# ── збирач геометрії: вершини (three-коорд.), грані, колір грані ──
class Geo:
    def __init__(s): s.v = []; s.f = []; s.c = []
    def add_bm(s, bm, xf, color):
        """bm — примітив у координатах Blender; xf(v3) — перетворення в three-коорд."""
        base = len(s.v)
        for v in bm.verts:
            s.v.append(xf(Vector((v.co.x, v.co.z, -v.co.y))))
        for f in bm.faces:
            s.f.append([base + v.index for v in f.verts])
            s.c.append(color(f) if callable(color) else color)
        bm.free()
    def obj(s, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata([(p.x, -p.z, p.y) for p in s.v], [], s.f)
        me.validate(); me.update()
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if name in ('BR_Terrain', 'BR_ArenaGround'):   # відкрита поверхня — нормалі строго вгору (Blender: +Z)
            for f in bm.faces:
                if f.normal.z < 0: f.normal_flip()
        bm.to_mesh(me); bm.free()
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly in me.polygons:
            c = s.c[poly.index] if poly.index < len(s.c) else (1, 1, 1)
            for li in poly.loop_indices: ca.data[li].color = (c[0], c[1], c[2], 1.0)
        me.color_attributes.active_color = ca
        for p in me.polygons: p.use_smooth = False
        me.materials.append(MAT)
        o = bpy.data.objects.new(name, me); col.objects.link(o)
        return o

def T(pos=(0, 0, 0), rot=0.0, scl=(1, 1, 1), rx=0.0, rz=0.0):
    """перетворення в three-коорд.: масштаб → нахил rx/rz → поворот навколо Y → зсув"""
    cy, sy = math.cos(rot), math.sin(rot); cx, sx = math.cos(rx), math.sin(rx); cz, sz = math.cos(rz), math.sin(rz)
    def f(v):
        x, y, z = v.x * scl[0], v.y * scl[1], v.z * scl[2]
        y, z = y * cx - z * sx, y * sx + z * cx
        x, y = x * cz - y * sz, x * sz + y * cz
        x, z = x * cy + z * sy, -x * sy + z * cy
        return Vector((x + pos[0], y + pos[1], z + pos[2]))
    return f

# примітиви (у локальних three-коорд.: y — вгору)
def box(g, c, size, color, rot=0.0, rx=0.0, rz=0.0):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    g.add_bm(bm, T(c, rot, (size[0], size[1], size[2]), rx, rz), color)
def cyl(g, c, r, h, color, seg=10, r2=None, rot=0.0, rx=0.0, rz=0.0, sx=1.0, sz=1.0, mid=False):
    """циліндр/конус уздовж y, c — центр основи"""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=(r if r2 is None else r2), depth=h)
    if not mid:
        for v in bm.verts: v.co.z += h / 2
    g.add_bm(bm, T(c, rot, (sx, 1, sz), rx, rz), color)
def ico(g, c, r, color, sub=1, scl=(1, 1, 1), rot=0.0):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    g.add_bm(bm, T(c, rot, (r * scl[0], r * scl[1], r * scl[2])), color)
def roof(g, c, w, d, h, color, rot=0.0, over=0.25):
    """двосхилий дах: гребінь уздовж x; c — центр низу"""
    bm = bmesh.new()
    W, D = w / 2 + over, d / 2 + over
    vs = [bm.verts.new(p) for p in [(-W, -D, 0), (W, -D, 0), (W, D, 0), (-W, D, 0), (-W, 0, h), (W, 0, h)]]
    # у координатах Blender (x, y, z-вгору) — add_bm сам переведе
    bm.faces.new([vs[0], vs[1], vs[5], vs[4]]); bm.faces.new([vs[2], vs[3], vs[4], vs[5]])
    bm.faces.new([vs[0], vs[4], vs[3]]); bm.faces.new([vs[1], vs[2], vs[5]]); bm.faces.new([vs[0], vs[3], vs[2], vs[1]])
    bm.verts.index_update()
    g.add_bm(bm, T(c, rot), color)

# ── палітра (лінійна) ──
P = {k: lin(v) for k, v in dict(
    sand='#f2d78f', sand2='#e6c376', grass='#7fd34e', grass2='#68c043', grass3='#93df5c', forest='#4fa53a', forest2='#3f9132',
    rock='#9aa1ad', rock2='#80879a', snow='#f4f8ff', dirt='#c99a5e', road='#d8b27a', field1='#e7cf55', field2='#a6d047', field3='#c98f4c',
    trunk='#8a5a35', leaf='#58c046', leaf2='#3fae49', pine='#2f8f5a', pine2='#3aa067', white='#f6f3ea', red='#e2503f', red2='#c43c33',
    blue='#4b8fe0', blue2='#3a73c4', yellow='#ffd23f', orange='#f39a2e', green='#4fae5b', olive='#7a8f4a', gray='#8d96a6', gray2='#6b7486',
    dark='#2c3140', dark2='#1e222c', concrete='#b9bcc4', concrete2='#a3a7b1', wood='#c58a4a', wood2='#a8723c', metal='#6f7a8c',
    glass='#9fe3ff', roofb='#5b6bd6', roofg='#4c9a64', skin='#f5c39a', skin2='#e7ab7f', boot='#3a2c24', gun='#2b2f38', gun2='#4a505c',
    gold='#ffc93a', gold2='#e8a720', lamp='#fff2a8', canvas='#d9cba4', tent='#6f8f4a', pier='#9b6a3d', hay='#f0c75a', barn='#c8453a',
    water='#3aa7e8').items()}

# ════════════════════════════════ ОСТРІВ ════════════════════════════════
rnd = random.Random(20261126)
def hsh(ix, iz):
    n = (ix * 374761393 + iz * 668265263) & 0xffffffff
    n = ((n ^ (n >> 13)) * 1274126177) & 0xffffffff
    return (n & 0xffff) / 65535.0
def vnoise(x, z):
    ix, iz = math.floor(x), math.floor(z); fx, fz = x - ix, z - iz
    fx, fz = fx * fx * (3 - 2 * fx), fz * fz * (3 - 2 * fz)
    a, b, c, d = hsh(ix, iz), hsh(ix + 1, iz), hsh(ix, iz + 1), hsh(ix + 1, iz + 1)
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz
def fbm(x, z): return vnoise(x, z) * 0.6 + vnoise(x * 2.1 + 7, z * 2.1 + 3) * 0.3 + vnoise(x * 4.3 + 1, z * 4.3 + 9) * 0.1
def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
def hill(x, z, cx, cz, r, h): return h * math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (r * r))

# Сітка лобі: 10×10 клітинок по 10 од.; колонка A — x=−45, рядок 1 — z=−45 (дальній край від камери)
BIOME_FLAT = [(0, 0, 15, 1.7), (-30, 30, 12, 1.5), (32, 30, 13, 1.4)]   # (x, z, r, висота): база, ферма, містечко
def mask(x, z):
    a = math.atan2(z, x); r = math.hypot(x, z)
    d6 = (abs(x) ** 6 + abs(z) ** 6) ** (1 / 6)
    dd = 0.75 * d6 + 0.25 * r
    R = 63 + 2.6 * math.sin(3 * a + 0.5) + 1.8 * math.sin(5 * a + 1.3) + 1.1 * math.sin(9 * a + 2.0)
    return sstep(R + 3, R - 7, dd)
def height(x, z):
    m = mask(x, z)
    H = 1.25 + fbm(x * 0.07, z * 0.07) * 1.6
    H += hill(x, z, 30, -30, 15, 12.5) + hill(x, z, 14, -42, 9, 5) + hill(x, z, 42, -14, 10, 5.5)     # гори північного сходу
    H += hill(x, z, -33, -28, 17, 5.5) + hill(x, z, -16, -40, 9, 3.5)                                    # лісисті пагорби
    H += hill(x, z, 44, 8, 9, 2.5) + hill(x, z, -6, 40, 10, 2)
    for (bx, bz, br, bh) in BIOME_FLAT:
        t = sstep(br + 6, br - 2, math.hypot(x - bx, z - bz)); H = H + (bh - H) * t
    H -= hill(x, z, -30, 2, 8.5, 3.6)                                                                    # озеро
    return -4.5 + (H + 4.5) * (m ** 0.8) if m < 1 else H
# дороги: ламані між зонами (колір і легке вирівнювання)
ROADS = [[(-30, 30), (-14, 16), (0, 0)], [(0, 0), (16, 15), (32, 30)], [(0, 0), (12, -14), (22, -26)], [(0, 0), (-16, -10), (-34, -22)],
         [(32, 30), (46, 44)], [(-30, 30), (-44, 44)]]
def road_d(x, z):
    best = 1e9
    for pl in ROADS:
        for (ax, az), (bx, bz) in zip(pl, pl[1:]):
            dx, dz = bx - ax, bz - az; L = dx * dx + dz * dz
            t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L)); px, pz = ax + dx * t, az + dz * t
            best = min(best, math.hypot(x - px, z - pz))
    return best

E = 64; STEP = 1.0; NV = int(2 * E / STEP) + 1
HG = [[height(-E + i * STEP, -E + j * STEP) for i in range(NV)] for j in range(NV)]   # HG[j][i]: z-рядок j, x-стовпець i
def hat(x, z):
    fx, fz = (x + E) / STEP, (z + E) / STEP
    i, j = max(0, min(NV - 2, int(fx))), max(0, min(NV - 2, int(fz))); tx, tz = fx - i, fz - j
    a, b, c, d = HG[j][i], HG[j][i + 1], HG[j + 1][i], HG[j + 1][i + 1]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz

def terrain_color(x, z, h, slope):
    n = fbm(x * 0.18 + 40, z * 0.18 + 11)
    if h < 0.15: return P['sand2']
    if h < 0.95 and mask(x, z) < 0.995: return P['sand'] if n > 0.35 else P['sand2']
    if h > 12.0: return P['snow']
    if slope > 0.95 or h > 9.5: return P['rock'] if n > 0.5 else P['rock2']
    rd = road_d(x, z)
    if rd < 1.6: return P['road'] if n > 0.3 else P['dirt']
    if math.hypot(x, z) < 13: return P['concrete'] if ((int((x + 50) / 3) + int((z + 50) / 3)) % 2) else P['concrete2']   # бетон бази
    if -44 < x < -14 and 14 < z < 46 and math.hypot(x + 30, z - 30) > 9:                                                   # поля ферми
        k = int((x * 0.55 + z * 0.2 + 40) / 2.2) % 3
        return (P['field1'], P['field2'], P['field3'])[k]
    if x < -8 and z < -6: return P['forest'] if n > 0.45 else P['forest2']
    return (P['grass'], P['grass2'], P['grass3'])[0 if n < 0.45 else (1 if n < 0.7 else 2)]

def build_terrain():
    g = Geo()
    idx = {}
    for j in range(NV):
        for i in range(NV):
            idx[(i, j)] = len(g.v); g.v.append(Vector((-E + i * STEP, HG[j][i], -E + j * STEP)))
    for j in range(NV - 1):
        for i in range(NV - 1):
            a, b, c, d = idx[(i, j)], idx[(i + 1, j)], idx[(i + 1, j + 1)], idx[(i, j + 1)]
            for tri in ((a, d, c), (a, c, b)) if (i + j) % 2 == 0 else ((a, d, b), (b, d, c)):
                p = [g.v[k] for k in tri]
                cx, cz = sum(q.x for q in p) / 3, sum(q.z for q in p) / 3; ch = sum(q.y for q in p) / 3
                nrm = (p[1] - p[0]).cross(p[2] - p[0]).normalized()
                slope = math.sqrt(max(0, 1 - nrm.y * nrm.y)) / max(0.05, abs(nrm.y))
                g.f.append(list(tri)); g.c.append(terrain_color(cx, cz, ch, slope))
    return g.obj('BR_Terrain')

props = Geo(); FOOT = []
def free(x, z, r):
    for (fx, fz, fr) in FOOT:
        if math.hypot(x - fx, z - fz) < r + fr: return False
    return True
def ground_min(x, z, r):
    return min(hat(x + dx * r, z + dz * r) for dx in (-1, 0, 1) for dz in (-1, 0, 1))

def pine(g, x, z, s=1.0):
    y = hat(x, z) - 0.1
    cyl(g, (x, y, z), 0.28 * s, 1.4 * s, P['trunk'], seg=6)
    for k, (rr, hh, yy) in enumerate([(1.7, 2.0, 1.1), (1.35, 1.8, 2.3), (0.95, 1.6, 3.4)]):
        cyl(g, (x, y + yy * s, z), rr * s, hh * s, P['pine'] if k % 2 == 0 else P['pine2'], seg=7, r2=0.0, rot=k * 0.6)
def tree(g, x, z, s=1.0):
    y = hat(x, z) - 0.1
    cyl(g, (x, y, z), 0.3 * s, 1.6 * s, P['trunk'], seg=6)
    ico(g, (x, y + 2.4 * s, z), 1.45 * s, P['leaf'] if rnd.random() < 0.6 else P['leaf2'], sub=1, scl=(1, 0.9, 1), rot=rnd.random() * 6)
    if rnd.random() < 0.5: ico(g, (x + 0.7 * s, y + 1.9 * s, z + 0.3 * s), 0.85 * s, P['leaf2'], sub=1)
def rock(g, x, z, s=1.0):
    y = hat(x, z)
    ico(g, (x, y + 0.2 * s, z), 1.0 * s, P['rock'] if rnd.random() < 0.5 else P['rock2'], sub=1,
        scl=(1 + rnd.random() * 0.6, 0.55 + rnd.random() * 0.4, 1 + rnd.random() * 0.5), rot=rnd.random() * 6)
def house(g, x, z, rot, w=5.0, d=4.2, h=3.0, wall=None, rf=None):
    y = ground_min(x, z, max(w, d) / 2) - 0.2
    wall = wall or rnd.choice([P['white'], lin('#ffe3b0'), lin('#cfe8ff'), lin('#ffd1c8'), lin('#e1f5c4')])
    rf = rf or rnd.choice([P['red'], P['roofb'], P['roofg'], P['orange'], lin('#8a5ad0')])
    cr, sr = math.cos(rot), math.sin(rot)
    L = lambda lx, lz: (x + lx * cr + lz * sr, z - lx * sr + lz * cr)
    box(g, (x, y + h / 2 + 0.1, z), (w, h + 0.2, d), wall, rot)
    roof(g, (x, y + h + 0.2, z), w, d, 1.7, rf, rot)
    px, pz = L(0, d / 2 + 0.03); box(g, (px, y + 1.0, pz), (0.9, 1.7, 0.12), P['wood2'], rot)          # двері
    for lx in (-w / 2 + 1.0, w / 2 - 1.0):
        px, pz = L(lx, d / 2 + 0.03); box(g, (px, y + 1.9, pz), (0.85, 0.75, 0.1), P['glass'], rot)
    for lz in (-d / 4, d / 4):
        for sgn in (-1, 1):
            px, pz = L(sgn * (w / 2 + 0.03), lz); box(g, (px, y + 1.9, pz), (0.1, 0.75, 0.85), P['glass'], rot)
    px, pz = L(w / 3, -d / 5); box(g, (px, y + h + 1.4, pz), (0.5, 1.4, 0.5), P['red2'], rot)          # димар
    FOOT.append((x, z, max(w, d) * 0.62))
def barn(g, x, z, rot):
    y = ground_min(x, z, 4) - 0.2
    box(g, (x, y + 2.1, z), (7, 4.2, 5.4), P['barn'], rot)
    roof(g, (x, y + 4.2, z), 7, 5.4, 2.3, P['dark'], rot, 0.3)
    cr, sr = math.cos(rot), math.sin(rot)
    for k in (-1, 1):
        box(g, (x + 0, y + 1.5, z + 0), (0.2, 3.0, 5.5), P['white'], rot)
    px, pz = x + (2.71 * sr), z + (2.71 * cr); box(g, (px, y + 1.6, pz), (2.6, 3.0, 0.14), P['white'], rot)
    FOOT.append((x, z, 4.6))
def silo(g, x, z):
    y = hat(x, z) - 0.2
    cyl(g, (x, y, z), 1.6, 7, P['concrete'], seg=12); ico(g, (x, y + 7, z), 1.6, P['gray2'], sub=2, scl=(1, 0.7, 1))
    for k in range(4): cyl(g, (x, y + 1.4 + k * 1.6, z), 1.66, 0.18, P['red'], seg=12)
    FOOT.append((x, z, 2.2))
def hay(g, x, z):
    y = hat(x, z); cyl(g, (x, y + 0.75, z), 0.8, 1.2, P['hay'], seg=8, rz=math.pi / 2, rot=rnd.random() * 3, mid=True)
def container(g, x, z, rot, color, y=None, store=True):
    y = (ground_min(x, z, 3) - 0.1) if y is None else y
    box(g, (x, y + 1.3, z), (6, 2.6, 2.5), color, rot)
    for k in range(-2, 3): box(g, (x + k * 1.15 * math.cos(rot), y + 1.3, z - k * 1.15 * math.sin(rot)), (0.12, 2.5, 2.58), shade(color, 0.8), rot)
    if store: FOOT.append((x, z, 3.2))
    return y + 2.6
def warehouse(g, x, z, rot):
    y = ground_min(x, z, 6) - 0.2
    box(g, (x, y + 2.2, z), (12, 4.4, 8), P['blue2'], rot)
    cyl(g, (x, y + 4.4, z), 4.1, 12.2, P['gray'], seg=10, rz=math.pi / 2, rot=rot, mid=True)
    cr, sr = math.cos(rot), math.sin(rot)
    box(g, (x + 4.02 * sr, y + 1.8, z + 4.02 * cr), (4, 3.2, 0.12), P['yellow'], rot)
    FOOT.append((x, z, 7.2))
def tower(g, x, z, H=7.0):
    y = hat(x, z) - 0.1
    for sx in (-1, 1):
        for sz in (-1, 1): box(g, (x + sx * 1.3, y + H / 2, z + sz * 1.3), (0.3, H, 0.3), P['wood2'])
    box(g, (x, y + H, z), (3.6, 0.3, 3.6), P['wood'])
    for sx, sz, w, d in ((0, -1.7, 3.6, 0.15), (0, 1.7, 3.6, 0.15), (-1.7, 0, 0.15, 3.6), (1.7, 0, 0.15, 3.6)):
        box(g, (x + sx, y + H + 0.55, z + sz), (w, 0.9, d), P['wood2'])
    roof(g, (x, y + H + 2.2, z), 3.2, 3.2, 1.2, P['red'])
    for sx in (-1, 1):
        for sz in (-1, 1): box(g, (x + sx * 1.6, y + H + 1.1, z + sz * 1.6), (0.18, 2.2, 0.18), P['wood2'])
    FOOT.append((x, z, 2.4))
def tent(g, x, z, rot):
    y = hat(x, z) - 0.05
    roof(g, (x, y, z), 3.6, 2.6, 2.2, P['tent'], rot, 0.0)
    FOOT.append((x, z, 2.4))
def lighthouse(g, x, z):
    y = hat(x, z) - 0.3
    cyl(g, (x, y, z), 3.0, 1.2, P['rock2'], seg=10)
    for k in range(6):
        cyl(g, (x, y + 1.2 + k * 2.0, z), 2.0 - k * 0.17, 2.0, P['white'] if k % 2 == 0 else P['red'], seg=12, r2=1.83 - k * 0.17)
    cyl(g, (x, y + 13.2, z), 1.3, 1.6, P['lamp'], seg=10)
    cyl(g, (x, y + 14.8, z), 1.5, 1.4, P['red2'], seg=10, r2=0.2)
    FOOT.append((x, z, 3.2))
def pier(g, x0, z0, x1, z1):
    L = math.hypot(x1 - x0, z1 - z0); rot = math.atan2(x1 - x0, z1 - z0)
    n = int(L / 1.2)
    for k in range(n):
        t = (k + 0.5) / n; px, pz = x0 + (x1 - x0) * t, z0 + (z1 - z0) * t
        box(g, (px, 0.9, pz), (3.0, 0.2, 1.05), P['pier'] if k % 2 else P['wood'], rot)
        if k % 3 == 0:
            for s in (-1, 1): box(g, (px + s * 1.4 * math.cos(rot), -0.6, pz - s * 1.4 * math.sin(rot)), (0.3, 3.2, 0.3), P['wood2'])
def fence(g, x0, z0, x1, z1):
    L = math.hypot(x1 - x0, z1 - z0); rot = math.atan2(x1 - x0, z1 - z0)
    n = max(1, int(L / 2.2))
    for k in range(n + 1):
        t = k / n; px, pz = x0 + (x1 - x0) * t, z0 + (z1 - z0) * t
        box(g, (px, hat(px, pz) + 0.7, pz), (0.18, 1.4, 0.18), P['gray2'])
    mx, mz = (x0 + x1) / 2, (z0 + z1) / 2; y = hat(mx, mz)
    box(g, (mx, y + 1.0, mz), (0.06, 0.9, L), P['gray'], rot)

def build_props():
    g = props
    # ── база в центрі
    warehouse(g, -5, -5, 0.0); warehouse(g, 7, 6, math.pi / 2)
    tower(g, 11, -9); tower(g, -10, 9)
    yy = container(g, 6, -6, 0.0, P['red']); container(g, 6, -6, 0.0, P['blue'], y=yy, store=False)
    container(g, -7, 7, math.pi / 2, P['orange']); container(g, -2, 11, 0.0, P['green'])
    for k in range(3): tent(g, -11 + k * 4.2, -11, 0.0)
    for (a, b) in ((-14, -14), (14, -14), (14, 14), (-14, 14), (-14, -14)):
        pass
    pts = [(-14, -14), (14, -14), (14, 14), (-14, 14)]
    for k in range(4):
        (ax, az), (bx, bz) = pts[k], pts[(k + 1) % 4]
        # ворота в середині кожної сторони
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        fence(g, ax, az, ax + (mx - ax) * 0.8, az + (mz - az) * 0.8)
        fence(g, mx + (bx - mx) * 0.2, mz + (bz - mz) * 0.2, bx, bz)
    # ── ферма (південний захід)
    barn(g, -30, 30, 0.3); silo(g, -24, 25); silo(g, -36, 24)
    house(g, -38, 38, 0.6); house(g, -22, 38, -0.4, w=4.6)
    for k in range(14):
        x, z = -42 + rnd.random() * 26, 16 + rnd.random() * 28
        if free(x, z, 1.2): hay(g, x, z)
    # ── містечко (південний схід)
    for (x, z, r) in [(24, 22, 0.0), (32, 20, 0.0), (40, 23, 0.1), (24, 33, math.pi), (33, 37, math.pi), (41, 34, math.pi + 0.15),
                      (20, 42, 0.5), (46, 14, -0.3)]:
        house(g, x, z, r, w=4.4 + rnd.random() * 1.6, d=4.0 + rnd.random() * 0.8, h=2.6 + rnd.random() * 1.2)
    lighthouse(g, 52, 50)
    pier(g, 47, 41, 60, 34)
    # ── будиночок рибалки біля озера та на півночі
    house(g, -18, 4, 1.2, w=3.8, d=3.4, h=2.4); house(g, 22, -12, 0.4)
    house(g, -4, -34, 0.0, w=4.4); house(g, 4, -38, 0.3, w=3.8)
    tower(g, 30, -30, H=5.0)   # вежа на вершині
    # ── ліс
    for k in range(260):
        x, z = -58 + rnd.random() * 116, -58 + rnd.random() * 116
        h = hat(x, z)
        if h < 1.2 or h > 10.5: continue
        if road_d(x, z) < 2.6 or math.hypot(x, z) < 17: continue
        forest = x < -6 and z < -4
        dens = 0.95 if forest else (0.18 if (-44 < x < -14 and 14 < z < 46) else 0.32)
        if (x > 16 and z > 14 and x < 48 and z < 44): dens = 0.12
        if rnd.random() > dens: continue
        if not free(x, z, 1.6): continue
        s = 0.8 + rnd.random() * 0.6
        if forest or h > 6: pine(g, x, z, s)
        else: tree(g, x, z, s)
        FOOT.append((x, z, 1.2 * s))
    for k in range(70):
        x, z = -60 + rnd.random() * 120, -60 + rnd.random() * 120
        h = hat(x, z)
        if h < 0.3 or road_d(x, z) < 2 or math.hypot(x, z) < 15: continue
        if (h > 5 or rnd.random() < 0.35) and free(x, z, 1.5):
            s = 0.6 + rnd.random() * 1.3; rock(g, x, z, s); FOOT.append((x, z, 1.1 * s))
    return g.obj('BR_Props')

terrain = build_terrain(); propo = build_props()
def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=False,
                              export_yup=True, export_apply=True, export_vertex_color='ACTIVE', export_normals=True,
                              export_materials='EXPORT')
export([terrain, propo], os.path.join(OUT, 'island.glb'))
GI = int(55 * 2) + 1
with open(os.path.join(OUT, 'island.json'), 'w') as f:
    json.dump({'e': 55, 'step': 1, 'n': GI,
               'h': [round(hat(-55 + i, -55 + j) * 100) for j in range(GI) for i in range(GI)],
               'foot': [[round(a, 2), round(b, 2), round(c, 2)] for a, b, c in FOOT if abs(a) < 56 and abs(b) < 56]}, f, separators=(',', ':'))

# ════════════════════════════════ АРЕНА ФІНАЛУ ════════════════════════════════
# Порт-форт 64×64 (−32..32). Земля рівна (y=0). Колайдери — AABB: t: wall (висока), low (по пояс), crate, barrel.
for o in list(col.objects): bpy.data.objects.remove(o, do_unlink=True)
arena = Geo(); COLS = []; CRATES = []; BARRELS = []
def acol(t, x, z, w, d, h, **kw): COLS.append(dict(t=t, x=round(x, 2), z=round(z, 2), w=round(w, 2), d=round(d, 2), h=round(h, 2), **kw))
def awall(x, z, w, d, h, color, t='wall'):
    box(arena, (x, h / 2, z), (w, h, d), color); acol(t, x, z, w, d, h)
    if h > 1.6:   # верхня окантовка
        box(arena, (x, h + 0.06, z), (w + 0.08, 0.12, d + 0.08), shade(color, 0.85))
def acont(x, z, along_x, color, level=0):
    w, d = (6.0, 2.5) if along_x else (2.5, 6.0)
    y = level * 2.6
    box(arena, (x, y + 1.3, z), (w, 2.6, d), color)
    n = 5
    for k in range(-2, 3):
        if along_x: box(arena, (x + k * 1.15, y + 1.3, z), (0.12, 2.5, d + 0.08), shade(color, 0.78))
        else: box(arena, (x, y + 1.3, z + k * 1.15), (w + 0.08, 2.5, 0.12), shade(color, 0.78))
    box(arena, (x, y + 2.62, z), (w - 0.2, 0.06, d - 0.2), shade(color, 1.1))
    if level == 0: acol('wall', x, z, w, d, 2.6)
    else:
        for c in COLS:
            if c['t'] == 'wall' and c['x'] == round(x, 2) and c['z'] == round(z, 2): c['h'] = round(2.6 * (level + 1), 2)
def sandbags(x, z, w, d):
    along = w >= d; n = int((w if along else d) / 0.9)
    for row in range(2):
        for k in range(n):
            off = -((w if along else d) / 2) + 0.45 + k * 0.9 + (0.45 if row else 0)
            if off > (w if along else d) / 2 - 0.3: continue
            px, pz = (x + off, z) if along else (x, z + off)
            ico(arena, (px, 0.28 + row * 0.42, pz), 0.5, P['canvas'] if (k + row) % 2 else shade(P['canvas'], 0.86), sub=1,
                scl=((1.0, 0.45, 0.62) if along else (0.62, 0.45, 1.0)))
    acol('low', x, z, w, d, 1.05)

# земля: бетонний двір, пісок по краях, вода за південною стіною
gr = Geo()
for i in range(-20, 20):
    for j in range(-20, 20):
        x0, z0 = i * 2.0, j * 2.0; cx, cz = x0 + 1, z0 + 1
        if abs(cx) < 33 and abs(cz) < 33:
            c = P['concrete'] if (i + j) % 2 else P['concrete2']
            if abs(cx) > 26 or abs(cz) > 26: c = P['sand'] if (i * 7 + j * 3) % 5 else P['sand2']
            if abs(cx) < 3.5 or abs(cz) < 3.5: c = shade(P['concrete'], 0.92) if abs(cx) > 3.5 or abs(cz) > 3.5 else P['yellow'] if (i + j) % 2 else P['dark']
        else:
            c = P['sand'] if cz < 33 or abs(cx) > 33 else P['sand2']
        y = 0.0 if (abs(cx) < 33 and abs(cz) < 33) else -0.05
        bm = bmesh.new(); bm.verts.new((0, 0, 0)); bm.verts.new((2, 0, 0)); bm.verts.new((2, -2, 0)); bm.verts.new((0, -2, 0))
        bm.verts.ensure_lookup_table(); bm.faces.new(bm.verts[:]); bm.verts.index_update()
        gr.add_bm(bm, T((x0, y, z0)), c)
# розмітка-коло в центрі
for k in range(32):
    a = k / 32 * math.tau
    box(gr, (math.cos(a) * 6, 0.02, math.sin(a) * 6), (0.5, 0.04, 1.25), P['yellow'], rot=-a)

# периметр: високі стіни з проходами-ворітьми (ворота закриті контейнерами — бій лишається всередині)
H = 3.4
for s in (-1, 1):
    awall(s * 31.5, 0, 1.0, 64, H, P['concrete2'])
    awall(0, s * 31.5, 64, 1.0, H, P['concrete2'])
for s in (-1, 1):
    for k in range(-3, 4):
        box(arena, (s * 31.5, H + 0.5, k * 9), (1.3, 1.0, 1.3), P['red'] if k % 2 else P['white'])
        box(arena, (k * 9, H + 0.5, s * 31.5), (1.3, 1.0, 1.3), P['red'] if k % 2 else P['white'])
# центральна будівля без даху: 12×10, проходи на кожній стороні
bx0, bz0, BW, BD, BH, T_ = 0, 0, 12, 10, 3.6, 0.5
for s in (-1, 1):
    awall(bx0 - BW / 2 + 2.25, s * BD / 2, 4.5, T_, BH, P['white']); awall(bx0 + BW / 2 - 2.25, s * BD / 2, 4.5, T_, BH, P['white'])
    awall(s * BW / 2, -BD / 2 + 1.75, T_, 3.5, BH, P['white']); awall(s * BW / 2, BD / 2 - 1.75, T_, 3.5, BH, P['white'])
box(arena, (0, BH + 0.1, -BD / 2), (BW + 0.6, 0.2, 0.8), P['red']); box(arena, (0, BH + 0.1, BD / 2), (BW + 0.6, 0.2, 0.8), P['red'])
box(arena, (-BW / 2, BH + 0.1, 0), (0.8, 0.2, BD + 0.6), P['red']); box(arena, (BW / 2, BH + 0.1, 0), (0.8, 0.2, BD + 0.6), P['red'])
box(arena, (0, 0.03, 0), (BW - 0.6, 0.06, BD - 0.6), P['wood'])
# контейнери
for (x, z, ax, c, lv) in [(-19, -19, True, 'red', 0), (-19, -19, True, 'blue', 1), (19, 19, True, 'orange', 0), (19, 19, True, 'green', 1),
                          (-22, 10, False, 'green', 0), (22, -10, False, 'blue', 0), (-8, -22, True, 'orange', 0), (8, 22, True, 'red', 0),
                          (13, -21, False, 'yellow', 0), (-13, 21, False, 'blue', 0), (25, 3, False, 'red', 0), (-25, -3, False, 'orange', 0)]:
    acont(x, z, ax, P[c], lv)
# бетонні блоки та мішки з піском — по пояс
for (x, z, w, d) in [(-12, -9, 3.2, 0.7), (12, 9, 3.2, 0.7), (-9, 14, 0.7, 3.2), (9, -14, 0.7, 3.2), (-27, 18, 3.2, 0.7), (27, -18, 3.2, 0.7),
                     (0, -16, 4.0, 0.7), (0, 16, 4.0, 0.7), (-17, 0, 0.7, 4.0), (17, 0, 0.7, 4.0)]:
    box(arena, (x, 0.55, z), (w, 1.1, d), P['concrete']); box(arena, (x, 1.12, z), (w, 0.06, d), P['yellow']); acol('low', x, z, w, d, 1.1)
for (x, z, w, d) in [(-6, -12, 3.6, 0.8), (6, 12, 3.6, 0.8), (-21, 24, 3.6, 0.8), (21, -24, 3.6, 0.8), (-26, -24, 0.8, 3.6), (26, 24, 0.8, 3.6),
                     (-15, -27, 3.6, 0.8), (15, 27, 3.6, 0.8)]:
    sandbags(x, z, w, d)
# вежі в кутах (декор, ноги — дрібні колайдери)
for (x, z) in [(-27, -27), (27, 27), (27, -27), (-27, 27)]:
    for sx in (-1, 1):
        for sz in (-1, 1): box(arena, (x + sx * 1.1, 2.6, z + sz * 1.1), (0.26, 5.2, 0.26), P['wood2'])
    box(arena, (x, 5.2, z), (3.0, 0.26, 3.0), P['wood']); roof(arena, (x, 6.9, z), 2.6, 2.6, 1.0, P['red'])
    for sx in (-1, 1):
        for sz in (-1, 1): box(arena, (x + sx * 1.3, 6.1, z + sz * 1.3), (0.16, 1.8, 0.16), P['wood2'])
    acol('wall', x, z, 2.5, 2.5, 0.5, deco=1)
# руйнівні ящики та вибухові бочки — окремі об'єкти
cr_obj = []; br_obj = []
CRATE_POS = [(-4, -9), (4, 9), (-15, -15), (15, 15), (-15, 6), (15, -6), (-24, -12), (24, 12), (-3, 20), (3, -20), (-10, 24), (10, -24),
             (-20, -6), (20, 6), (-6, 3), (6, -3), (-27, 6), (27, -6), (-11, -21), (11, 21), (0, -26), (0, 26)]
for k, (x, z) in enumerate(CRATE_POS):
    g = Geo(); s = 1.3
    box(g, (0, s / 2, 0), (s, s, s), P['wood'])
    for e in (-1, 1):
        box(g, (0, s / 2, e * (s / 2 + 0.02)), (s + 0.04, 0.16, 0.06), P['wood2']); box(g, (e * (s / 2 + 0.02), s / 2, 0), (0.06, 0.16, s + 0.04), P['wood2'])
        box(g, (0, e * (s / 2 - 0.08) + s / 2, 0), (s + 0.05, 0.12, s + 0.05), P['wood2'])
    o = g.obj('BR_Crate_%d' % k); o.location = (x, -z, 0); cr_obj.append(o)
    CRATES.append(dict(id=k, x=x, z=z, s=s)); acol('crate', x, z, s, s, s, id=k)
BARREL_POS = [(-9, -3), (9, 3), (-2, -14), (2, 14), (-18, 15), (18, -15), (-23, 22), (23, -22), (-26, 0), (26, 0), (-12, 2), (12, -2)]
for k, (x, z) in enumerate(BARREL_POS):
    g = Geo()
    cyl(g, (0, 0, 0), 0.46, 1.15, P['red'], seg=12)
    for yy in (0.25, 0.85): cyl(g, (0, yy, 0), 0.48, 0.07, P['red2'], seg=12)
    cyl(g, (0, 1.15, 0), 0.4, 0.04, P['dark'], seg=12)
    box(g, (0, 0.58, 0.47), (0.36, 0.3, 0.02), P['yellow'])
    o = g.obj('BR_Barrel_%d' % k); o.location = (x, -z, 0); br_obj.append(o)
    BARRELS.append(dict(id=k, x=x, z=z)); acol('barrel', x, z, 0.9, 0.9, 1.15, id=k)
# пальми й скелі за стіною (декор)
for k in range(26):
    a = k / 26 * math.tau + rnd.random() * 0.2; r = 36 + rnd.random() * 6
    x, z = math.cos(a) * r, math.sin(a) * r
    if rnd.random() < 0.55:
        y = 0
        cyl(arena, (x, 0, z), 0.3, 2.0, P['trunk'], seg=6)
        ico(arena, (x, 2.8, z), 1.6, P['leaf'] if k % 2 else P['leaf2'], sub=1, scl=(1, 0.85, 1))
    else:
        ico(arena, (x, 0.3, z), 1.4 + rnd.random(), P['rock'] if k % 2 else P['rock2'], sub=1, scl=(1.3, 0.7, 1.1), rot=k)
# прожектори на стінах (жовті лампи)
for s in (-1, 1):
    for k in (-18, 0, 18):
        box(arena, (s * 30.8, 3.0, k), (0.4, 0.4, 0.8), P['lamp']); box(arena, (k, 3.0, s * 30.8), (0.8, 0.4, 0.4), P['lamp'])
gro = gr.obj('BR_ArenaGround'); aro = arena.obj('BR_ArenaStatic')
export([aro, gro] + cr_obj + br_obj, os.path.join(OUT, 'arena.glb'))
with open(os.path.join(OUT, 'arena.json'), 'w') as f:
    json.dump({'half': 31, 'cols': COLS, 'crates': CRATES, 'barrels': BARRELS}, f, separators=(',', ':'))

# ════════════════════════════════ БІЄЦЬ І РЕКВІЗИТ ════════════════════════════════
for o in list(col.objects): bpy.data.objects.remove(o, do_unlink=True)
kit = []
def part(name, build):
    g = Geo(); build(g); o = g.obj(name); kit.append(o); return o
# Бієць дивиться вздовж +z. Півоти: ноги — тазостегновий суглоб (y=0 частини), тулуб — таз, голова — шия, руки — плече.
def legs(sgn):
    def b(g):
        box(g, (0, -0.42, 0), (0.27, 0.72, 0.3), TINT)
        box(g, (0, -0.42, 0.155), (0.2, 0.2, 0.02), shade(P['dark'], 1.2))        # кишеня
        box(g, (0, -0.84, 0.04), (0.3, 0.2, 0.42), P['boot'])
    return b
def torso(g):
    box(g, (0, 0.36, 0), (0.62, 0.66, 0.38), TINT)
    box(g, (0, 0.04, 0), (0.6, 0.12, 0.4), P['dark'])                               # пояс
    box(g, (0, 0.42, 0.2), (0.5, 0.42, 0.06), P['olive'])                           # бронежилет
    for sx in (-0.14, 0.14): box(g, (sx, 0.36, 0.235), (0.14, 0.16, 0.05), P['dark2'])   # підсумки
    box(g, (0, 0.38, -0.27), (0.46, 0.52, 0.2), P['wood2'])                         # рюкзак
    box(g, (0, 0.66, -0.27), (0.4, 0.1, 0.22), shade(P['wood2'], 0.8))
    box(g, (0, 0.04, 0.215), (0.12, 0.09, 0.03), P['gold'])                          # пряжка
def head(g):
    ico(g, (0, 0.27, 0), 0.25, P['skin'], sub=2, scl=(1.0, 1.04, 0.98))
    ico(g, (0, 0.37, -0.01), 0.275, TINT, sub=2, scl=(1.06, 0.72, 1.08))            # шолом
    box(g, (0, 0.36, 0.23), (0.44, 0.12, 0.08), P['dark2'])                          # окуляри на шоломі
    box(g, (-0.1, 0.36, 0.272), (0.12, 0.07, 0.02), P['glass']); box(g, (0.1, 0.36, 0.272), (0.12, 0.07, 0.02), P['glass'])
    box(g, (-0.085, 0.25, 0.235), (0.05, 0.06, 0.02), P['dark2']); box(g, (0.085, 0.25, 0.235), (0.05, 0.06, 0.02), P['dark2'])  # очі
    box(g, (0, 0.15, 0.23), (0.1, 0.03, 0.02), P['skin2'])                            # усмішка
    cyl(g, (0, -0.02, 0), 0.1, 0.08, P['skin2'], seg=8)                               # шия
def arm(sgn):
    def b(g):
        box(g, (0, -0.25, 0), (0.2, 0.5, 0.22), TINT)
        box(g, (0, -0.02, 0), (0.24, 0.16, 0.26), shade(P['olive'], 1.0))           # наплічник
        box(g, (0, -0.56, 0), (0.17, 0.14, 0.19), P['dark'])                          # рукавичка
    return b
def gun(g):
    box(g, (0, 0.02, 0.32), (0.11, 0.15, 0.62), P['gun'])                             # корпус
    box(g, (0, 0.05, 0.78), (0.05, 0.05, 0.36), P['gun2'])                            # ствол
    box(g, (0, -0.12, 0.3), (0.08, 0.2, 0.1), P['gun2'])                              # магазин
    box(g, (0, -0.06, -0.08), (0.09, 0.14, 0.26), P['wood2'])                         # приклад
    box(g, (0, 0.13, 0.32), (0.06, 0.06, 0.2), P['dark2'])                            # приціл
    box(g, (0, 0.135, 0.42), (0.04, 0.04, 0.02), (1.0, 0.2, 0.1))                    # червона мушка
part('BR_LegL', legs(-1)); part('BR_LegR', legs(1)); part('BR_Torso', torso); part('BR_Head', head)
part('BR_ArmL', arm(-1)); part('BR_ArmR', arm(1)); part('BR_Gun', gun)
def chute(g):
    # купол: верхня частина еліпсоїда; смуги по секторах — фарба гравця / білий
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0)
    for v in list(bm.verts):
        if v.co.z < 0.15: pass
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.1], context='VERTS')
    def cf(f):
        c = f.calc_center_median(); a = math.atan2(c.y, c.x)
        return TINT if int((a + math.pi) / (math.tau / 12)) % 2 == 0 else P['white']
    g.add_bm(bm, T((0, 2.35, 0), 0, (1.7, 1.0, 1.7)), cf)
    for k in range(8):
        a = k / 8 * math.tau; x, z = math.cos(a) * 1.55, math.sin(a) * 1.55
        L = math.sqrt(x * x + 2.55 ** 2 + z * z)
        # тонка стропа від купола до плечей
        rx = math.atan2(math.hypot(x, z), 2.55)
        box(g, (x / 2, 1.38 + 0.0, z / 2), (0.025, 2.7, 0.025), P['white'], rot=math.atan2(x, z), rx=-rx)
part('BR_Chute', chute)
def plane(g):
    cyl(g, (0, 0, -5.5), 1.15, 11, P['gray'], seg=12, rx=math.pi / 2)               # фюзеляж уздовж z
    cyl(g, (0, 0, 5.5), 1.15, 2.2, P['gray'], seg=12, r2=0.3, rx=math.pi / 2)       # ніс
    cyl(g, (0, 0, -5.5), 1.15, 2.6, P['gray'], seg=12, r2=0.35, rx=-math.pi / 2)    # хвіст
    box(g, (0, 0.2, 0.6), (15, 0.25, 2.2), P['white'])                                # крила
    box(g, (0, 0.2, 0.6), (15.1, 0.27, 0.4), P['red'])
    box(g, (0, 1.7, -7.2), (0.25, 2.6, 1.8), P['red'])                                # кіль
    box(g, (0, 0.6, -7.4), (5, 0.2, 1.3), P['white'])
    for sx in (-4, 4):
        cyl(g, (sx, 0.0, 1.0), 0.5, 1.9, P['dark'], seg=8, rx=math.pi / 2)             # двигуни
        box(g, (sx, 0.0, 2.05), (0.15, 2.0, 0.08), P['dark2'])                         # гвинти
    box(g, (0, 0.55, 4.6), (1.3, 0.45, 1.0), P['glass'])                               # кабіна
    for k in range(5): box(g, (1.16, 0.25, 2.5 - k * 1.6), (0.04, 0.35, 0.5), P['glass']); box(g, (-1.16, 0.25, 2.5 - k * 1.6), (0.04, 0.35, 0.5), P['glass'])
part('BR_Plane', plane)
def missile(g):
    cyl(g, (0, 0, 0), 0.22, 1.6, P['white'], seg=10)
    cyl(g, (0, 1.6, 0), 0.22, 0.6, P['red'], seg=10, r2=0.0)
    for k in range(4):
        a = k / 4 * math.tau; box(g, (math.cos(a) * 0.3, 0.2, math.sin(a) * 0.3), (0.04 if k % 2 == 0 else 0.4, 0.5, 0.4 if k % 2 == 0 else 0.04), P['red'])
    cyl(g, (0, 0.9, 0), 0.23, 0.12, P['yellow'], seg=10)
part('BR_Missile', missile)
def grenade(g):
    ico(g, (0, 0, 0), 0.14, P['green'], sub=1, scl=(1, 1.15, 1)); box(g, (0, 0.16, 0), (0.08, 0.08, 0.08), P['gray2'])
    box(g, (0.06, 0.15, 0), (0.12, 0.03, 0.03), P['gray'])
part('BR_Grenade', grenade)
def crown(g):
    cyl(g, (0, 0, 0), 0.27, 0.16, P['gold'], seg=12)
    for k in range(6):
        a = k / 6 * math.tau
        cyl(g, (math.cos(a) * 0.22, 0.14, math.sin(a) * 0.22), 0.07, 0.22, P['gold2'], seg=4, r2=0.0)
        ico(g, (math.cos(a) * 0.255, 0.08, math.sin(a) * 0.255), 0.04, (0.9, 0.05, 0.2) if k % 2 else (0.1, 0.4, 1.0), sub=1)
part('BR_Crown', crown)
export(kit, os.path.join(OUT, 'kit.glb'))
for fn in ('island.glb', 'arena.glb', 'kit.glb', 'island.json', 'arena.json'):
    print('BR OUT', fn, os.path.getsize(os.path.join(OUT, fn)))
