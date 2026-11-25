# «Кейсы» (DnD) — студія-шоу, власний дизайн.
# Запуск: blender -b --factory-startup --python blender/dnd_studio.py
# Пише public/models/dnd/dnd.glb (+ blender/dnd_studio.blend).
# Шаблони (гра клонує й розставляє їх сама, див. public/dnd.js):
#   DND_CaseRig  — порожній вузол; діти DND_CaseBase (корпус) і DND_CaseLid (кришка, початок координат — на завісі)
#   DND_Pedestal — підставка-пюпітр; дитина DND_Seat — точка й нахил, куди кладеться кейс
#   DND_Podium   — подіум гравця; дитина DND_PodiumSeat
#   DND_PhoneSet — столик із телефоном банкіра; дитина DND_Handset (трубка — трясеться, коли дзвонить)
#   DND_Stage    — підлога, ярус задніх кейсів, LED-стіна; DND_BigScreen — круглий екран над сценою (гра малює на ньому текст)
# Координати сцени (Blender): камера з боку −Y. У three.js це (x, z, −y).
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler
ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'models', 'dnd'); os.makedirs(OUT, exist_ok=True)

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
col = bpy.data.collections.get('DND') or bpy.data.collections.new('DND')
if col.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(col)

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c) + (1,)
def mat(name, hexc, rough=0.4, metal=0.0, emit=None, estr=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = lin(hexc); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if emit:
        k = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
        b.inputs[k].default_value = lin(emit); b.inputs['Emission Strength'].default_value = estr
    return m
M = dict(
    alu=mat('DND_Alu', '#c3c9d3', 0.3, 1.0),
    velvet=mat('DND_Velvet', '#5a0f22', 0.95, 0.0),
    trim=mat('DND_Trim', '#e0ad48', 0.22, 1.0),
    rubber=mat('DND_Rubber', '#141519', 0.6, 0.0),
    ped=mat('DND_Ped', '#1b1828', 0.32, 0.7),
    glow=mat('DND_Glow', '#ffcf5a', 0.4, 0.0, emit='#ffcf5a', estr=4.0),
    floor=mat('DND_Floor', '#08080d', 0.16, 0.55),
    neon=mat('DND_Neon', '#58e6ff', 0.3, 0.0, emit='#58e6ff', estr=5.0),
    ngold=mat('DND_NeonGold', '#ffc94a', 0.3, 0.0, emit='#ffc94a', estr=5.0),
    wall=mat('DND_Wall', '#0f0d1a', 0.7, 0.1),
    screen=mat('DND_Screen', '#1c0f38', 0.5, 0.0, emit='#5a26c4', estr=1.2),
    big=mat('DND_BigScreen', '#0b0716', 0.4, 0.0, emit='#ffffff', estr=1.0),
    phone=mat('DND_PhoneBlack', '#0b0b0f', 0.12, 0.25),
    cream=mat('DND_Cream', '#efe2c4', 0.4, 0.0),
    tier=mat('DND_Tier', '#13101e', 0.28, 0.55),
)
ML = list(M.values()); MI = {k: ML.index(v) for k, v in M.items()}

def mesh_obj(name, bm, parent=None, loc=(0, 0, 0)):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for m in ML: me.materials.append(m)
    for p in me.polygons: p.use_smooth = False
    o = bpy.data.objects.new(name, me); col.objects.link(o)
    if parent: o.parent = parent
    o.location = loc
    return o
def empty(name, parent=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    o = bpy.data.objects.new(name, None); col.objects.link(o)
    if parent: o.parent = parent
    o.location = loc; o.rotation_euler = rot; o.empty_display_size = 0.2
    return o
def bevel(o, w, seg=3, ang=35):
    m = o.modifiers.new('bev', 'BEVEL'); m.width = w; m.segments = seg
    m.limit_method = 'ANGLE'; m.angle_limit = math.radians(ang); m.harden_normals = False
    o.data.polygons.foreach_set('use_smooth', [True] * len(o.data.polygons))
    try: o.data.set_sharp_from_angle(angle=math.radians(40))
    except Exception: pass
    return o
def setmat(bm, faces, key):
    for f in faces: f.material_index = MI[key]
def box(bm, c, s, key, rot=None):
    """куб у вже наявний bmesh: центр c, розмір s, матеріал key, (необовʼязково) поворот Matrix"""
    r = bmesh.ops.create_cube(bm, size=1.0)
    vs = r['verts']
    for v in vs:
        v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
        if rot: v.co = rot @ v.co
        v.co += Vector(c)
    fs = {f for v in vs for f in v.link_faces}
    setmat(bm, fs, key); return vs
def cyl(bm, c, r1, r2, d, key, seg=32, rot=None):
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=d)
    vs = res['verts']
    for v in vs:
        if rot: v.co = rot @ v.co
        v.co += Vector(c)
    setmat(bm, {f for v in vs for f in v.link_faces}, key); return vs
def torus(bm, c, R, r, key, seg=48, rs=10, rot=None):
    """тор у площині XY"""
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg; ring = []
        for j in range(rs):
            b = 2 * math.pi * j / rs
            p = Vector(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
            if rot: p = rot @ p
            ring.append(bm.verts.new(p + Vector(c)))
        rings.append(ring)
    fs = []
    for i in range(seg):
        for j in range(rs):
            a, b = rings[i], rings[(i + 1) % seg]
            fs.append(bm.faces.new((a[j], b[j], b[(j + 1) % rs], a[(j + 1) % rs])))
    setmat(bm, fs, key)
def sector(bm, cx, cy, r0, r1, a0, a1, z0, z1, key, seg=48, front_key=None):
    """суцільний сектор кільця навколо (cx, cy); кут від осі +Y (за годинниковою — до +X)"""
    P = lambda r, a, z: bm.verts.new((cx + r * math.sin(a), cy + r * math.cos(a), z))
    rows = []
    for i in range(seg + 1):
        a = a0 + (a1 - a0) * i / seg
        rows.append([P(r0, a, z0), P(r1, a, z0), P(r1, a, z1), P(r0, a, z1)])
    fs = []
    for i in range(seg):
        A, B = rows[i], rows[i + 1]
        for k in range(4):
            f = bm.faces.new((A[k], B[k], B[(k + 1) % 4], A[(k + 1) % 4])); fs.append(f)
            if front_key and k == 3: f.material_index = MI[front_key]; fs.pop()   # k=3: внутрішня (ближча до центру) стінка
    for R_ in (rows[0], rows[-1]): fs.append(bm.faces.new(R_))
    setmat(bm, fs, key)
def tray(bm, w, h, d, wall, key_out, key_in):
    """лоток (корпус кейса): відкритий угору, дно на z=0"""
    r = bmesh.ops.create_cube(bm, size=1.0)
    for v in r['verts']: v.co = Vector((v.co.x * w, v.co.y * h, v.co.z * d + d / 2))
    setmat(bm, bm.faces, key_out)
    top = [f for f in bm.faces if f.normal.z > 0.9]
    bmesh.ops.inset_region(bm, faces=top, thickness=wall, depth=0)
    ext = bmesh.ops.extrude_face_region(bm, geom=top)
    nv = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    nf = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMFace)]
    bmesh.ops.translate(bm, verts=nv, vec=(0, 0, -(d - 0.022)))
    bmesh.ops.delete(bm, geom=top, context='FACES')
    setmat(bm, nf, key_in)

# ════════════════ КЕЙС ════════════════
CW, CH, CB, CL = 1.06, 0.76, 0.13, 0.11      # ширина, глибина (від завіси до ручки), висота корпусу, висота кришки
rig = empty('DND_CaseRig')
bm = bmesh.new(); tray(bm, CW, CH, CB, 0.045, 'alu', 'velvet')
# ручка (на ближньому довгому боці), стійки — золото
for sx in (-1, 1): box(bm, (sx * 0.17, -CH / 2 - 0.03, CB * 0.55), (0.05, 0.06, 0.045), 'trim')
cyl(bm, (0, -CH / 2 - 0.068, CB * 0.55), 0.024, 0.024, 0.42, 'rubber', 16, Matrix.Rotation(math.pi / 2, 3, 'Y'))
# кутники знизу
for sx in (-1, 1):
    for sy in (-1, 1): box(bm, (sx * (CW / 2 - 0.035), sy * (CH / 2 - 0.035), 0.022), (0.09, 0.09, 0.05), 'trim')
# ніжки-заклепки на дні
for sx in (-1, 1):
    for sy in (-1, 1): cyl(bm, (sx * 0.36, sy * 0.24, -0.006), 0.03, 0.026, 0.014, 'rubber', 12)
base = bevel(mesh_obj('DND_CaseBase', bm, rig), 0.012, 3)
# кришка: лоток догори дном; початок координат — на завісі (дальній край, верх корпусу)
bm = bmesh.new(); tray(bm, CW, CH, CL, 0.045, 'alu', 'velvet')
bmesh.ops.scale(bm, vec=(1, 1, -1), verts=bm.verts)                       # порожниною вниз
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -CH / 2, CL))             # z 0..CL, завіса на y=0
bmesh.ops.reverse_faces(bm, faces=bm.faces)
# ребра жорсткості (пари) біля країв кришки
for yy in (-0.05, -0.09, -CH + 0.05, -CH + 0.09): box(bm, (0, yy, CL + 0.006), (CW - 0.16, 0.018, 0.014), 'alu')
# кутники зверху
for sx in (-1, 1):
    for yy in (-0.035, -CH + 0.035): box(bm, (sx * (CW / 2 - 0.035), yy, CL - 0.022), (0.09, 0.09, 0.05), 'trim')
# замки на ближньому боці (перекривають шов — їдуть із кришкою)
for sx in (-1, 1):
    box(bm, (sx * 0.33, -CH - 0.012, 0.0), (0.1, 0.03, 0.075), 'trim')
    box(bm, (sx * 0.33, -CH - 0.03, 0.012), (0.05, 0.012, 0.03), 'rubber')
# завіси
for sx in (-1, 1): cyl(bm, (sx * 0.3, 0.012, 0.0), 0.018, 0.018, 0.16, 'trim', 12, Matrix.Rotation(math.pi / 2, 3, 'Y'))
lid = bevel(mesh_obj('DND_CaseLid', bm, rig, loc=(0, CH / 2, CB)), 0.01, 3)

# ════════════════ ПІДСТАВКА-ПЮПІТР ════════════════
TILT = math.radians(34)
def lectern(name, seat_name, R0, colR, colH, plate, glow_rings):
    bm = bmesh.new()
    cyl(bm, (0, 0, 0.05), R0, R0 * 0.95, 0.1, 'ped', 48)
    cyl(bm, (0, 0, 0.115), R0 * 0.8, R0 * 0.78, 0.03, 'trim', 48)
    for k, (rr, zz) in enumerate(glow_rings): torus(bm, (0, 0, zz), rr, 0.016, 'glow', 64, 8)
    cyl(bm, (0, 0, 0.13 + colH / 2), colR * 1.15, colR * 0.85, colH, 'ped', 32)
    top = 0.13 + colH
    cyl(bm, (0, 0, top + 0.02), colR * 1.4, colR * 1.4, 0.04, 'trim', 32)
    rot = Matrix.Rotation(TILT, 3, 'X')
    pc = Vector((0, 0, top + 0.07 + colR * 1.6 * math.tan(TILT)))   # вище за диск колони: нахилений пюпітр не протикається
    box(bm, pc, (plate[0], plate[1], 0.05), 'ped', rot)
    # золота окантовка пюпітра + світна смуга на ближньому краї
    box(bm, pc + rot @ Vector((0, -plate[1] / 2 - 0.012, 0.0)), (plate[0] + 0.04, 0.03, 0.07), 'trim', rot)
    box(bm, pc + rot @ Vector((0, plate[1] / 2 + 0.012, 0.0)), (plate[0] + 0.04, 0.03, 0.07), 'trim', rot)
    box(bm, pc + rot @ Vector((0, -plate[1] / 2 - 0.03, -0.01)), (plate[0] * 0.8, 0.012, 0.03), 'glow', rot)
    # стійка-упор під пюпітром
    sz = pc.z - colR * 0.9 * math.tan(TILT) - 0.04                     # опора під пюпітром — нижче похилої площини
    cyl(bm, (0, 0, (top + sz) / 2), colR * 0.9, colR * 0.9, sz - top, 'ped', 24)
    o = bevel(mesh_obj(name, bm), 0.008, 2)
    empty(seat_name, o, loc=tuple(pc + rot @ Vector((0, 0, 0.025))), rot=(TILT, 0, 0))
    return o
lectern('DND_Pedestal', 'DND_Seat', 0.4, 0.13, 0.72, (1.2, 0.9), [(0.4, 0.1)])
lectern('DND_Podium', 'DND_PodiumSeat', 0.78, 0.3, 1.0, (1.35, 1.02), [(0.78, 0.1), (0.62, 0.135)])

# ════════════════ ТЕЛЕФОН БАНКІРА ════════════════
# класичний дисковий апарат: чорний глянець + золото; корпус і трубка — згладжені (subsurf)
ps = empty('DND_PhoneSet')
bm = bmesh.new()
cyl(bm, (0, 0, 0.04), 0.36, 0.34, 0.08, 'ped', 40)
torus(bm, (0, 0, 0.09), 0.34, 0.012, 'glow', 48, 8)
cyl(bm, (0, 0, 0.5), 0.07, 0.05, 0.84, 'trim', 20)
cyl(bm, (0, 0, 0.94), 0.58, 0.56, 0.05, 'ped', 48)
cyl(bm, (0, 0, 0.97), 0.56, 0.56, 0.012, 'trim', 48)
bevel(mesh_obj('DND_PhoneTable', bm, ps), 0.006, 2)
def smooth_obj(name, bm, parent=None, loc=(0, 0, 0), lv=2):
    o = mesh_obj(name, bm, parent, loc)
    o.data.polygons.foreach_set('use_smooth', [True] * len(o.data.polygons))
    m = o.modifiers.new('sub', 'SUBSURF'); m.levels = lv; m.render_levels = lv
    return o
TZ = 0.976                                   # верх столика
# корпус: «хлібина» — низ ширший, верх вужчий і зсунутий назад; ребра зняті фаскою, потім згладжено
bm = bmesh.new()
r = bmesh.ops.create_cube(bm, size=1.0)
for v in r['verts']:
    top = v.co.z > 0
    v.co = Vector((v.co.x * (0.40 if top else 0.52), v.co.y * (0.30 if top else 0.44) + (0.045 if top else 0.0), TZ + (0.175 if top else 0.0)))
setmat(bm, bm.faces, 'phone')
bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.03, segments=2, profile=0.5, affect='EDGES')
setmat(bm, bm.faces, 'phone')                 # грані фаски — теж чорний глянець
body = smooth_obj('DND_PhoneBody', bm, ps)
# деталі корпусу (окремо, без згладжування)
bm = bmesh.new()
# похила передня грань: від (y −0.22, z TZ) до (y −0.105, z TZ+0.175); нормаль — угору-вперед
n = Vector((0, -0.175, 0.115)).normalized()
fr = Matrix.Rotation(math.atan2(0.175, 0.115), 3, 'X')
dc = Vector((0, -0.163, TZ + 0.088)) - n * 0.001   # згладжений корпус «усідає»: диск майже на площині грані
torus(bm, dc, 0.106, 0.011, 'trim', 64, 10, fr)                                   # золоте кільце
cyl(bm, dc + n * 0.002, 0.098, 0.098, 0.008, 'cream', 64, fr)                     # табличка з цифрами
cyl(bm, dc + n * 0.009, 0.094, 0.094, 0.006, 'trim', 64, fr)                      # диск-«палець» (золото)
for i in range(10):
    a = math.radians(-60 + i * 30)                                                 # 10 отворів на дузі 270°
    cyl(bm, dc + n * 0.013 + fr @ Vector((0.066 * math.cos(a), 0.066 * math.sin(a), 0)), 0.016, 0.016, 0.006, 'phone', 18, fr)
cyl(bm, dc + n * 0.014, 0.034, 0.034, 0.008, 'phone', 32, fr)                     # центр
cyl(bm, dc + n * 0.018, 0.022, 0.022, 0.004, 'cream', 24, fr)
a = math.radians(-95); box(bm, dc + n * 0.016 + fr @ Vector((0.092 * math.cos(a), 0.092 * math.sin(a), 0)), (0.012, 0.03, 0.012), 'trim', fr)   # упор
# золотий пояс по низу корпусу і ніжки
box(bm, (0, 0, TZ + 0.008), (0.48, 0.4, 0.016), 'trim')
for sx in (-1, 1):
    for sy in (-1, 1): cyl(bm, (sx * 0.21, sy * 0.17, TZ + 0.002), 0.025, 0.022, 0.008, 'rubber', 16)
# важіль (вилка) під трубку: дві «роги» + золоті кнопки
for sx in (-1, 1):
    box(bm, (sx * 0.15, 0.06, TZ + 0.2), (0.07, 0.11, 0.05), 'phone')
    cyl(bm, (sx * 0.055, 0.06, TZ + 0.19), 0.014, 0.014, 0.03, 'trim', 16)
bevel(mesh_obj('DND_PhoneParts', bm, ps), 0.008, 2, 30)
# трубка: вигнута ручка (skin + subsurf) і дві чашки (вухо / мікрофон), що дивляться вниз
HZ = TZ + 0.265
bm = bmesh.new()
for sx in (-1, 1):
    tilt = Matrix.Rotation(sx * math.radians(14), 3, 'Y')
    cyl(bm, Vector((sx * 0.2, 0, -0.03)), 0.064, 0.05, 0.075, 'phone', 40, tilt)
    cyl(bm, Vector((sx * 0.2, 0, -0.03)) + tilt @ Vector((0, 0, -0.039)), 0.056, 0.056, 0.006, 'trim', 40, tilt)
    for k in range(7):
        a = 2 * math.pi * k / 7
        cyl(bm, Vector((sx * 0.2, 0, -0.03)) + tilt @ Vector((0.03 * math.cos(a), 0.03 * math.sin(a), -0.043)), 0.006, 0.006, 0.004, 'phone', 8, tilt)
hs = bevel(mesh_obj('DND_Handset', bm, ps, loc=(0, 0.06, HZ)), 0.01, 3, 30)
bm = bmesh.new(); prev = None
for i in range(11):
    t = i / 10; x = -0.21 + 0.42 * t
    v = bm.verts.new((x, 0, 0.012 + 0.03 * math.sin(math.pi * t)))
    if prev: bm.edges.new((prev, v))
    prev = v
me = bpy.data.meshes.new('DND_HandsetGrip'); bm.to_mesh(me); bm.free()
grip = bpy.data.objects.new('DND_HandsetGrip', me); col.objects.link(grip); grip.parent = hs
sk = grip.modifiers.new('skin', 'SKIN')
for v in grip.data.skin_vertices[0].data: v.radius = (0.03, 0.026)
sub = grip.modifiers.new('sub', 'SUBSURF'); sub.levels = 2; sub.render_levels = 2
grip.data.materials.append(M['phone'])
# кручений шнур: від мікрофона трубки до боку корпусу
bm = bmesh.new(); pts = []
p0, p1 = Vector((-0.27, 0.06, HZ - 0.05)), Vector((-0.27, -0.05, TZ + 0.05))
for i in range(160):
    t = i / 159
    bp = p0.lerp(p1, t) + Vector((-0.07 * math.sin(t * math.pi), 0, -0.05 * math.sin(t * math.pi)))
    a = t * 2 * math.pi * 16
    pts.append(bp + Vector((0.016 * math.cos(a), 0.016 * math.sin(a), 0)))
prev = None
for p in pts:
    v = bm.verts.new(p)
    if prev: bm.edges.new((prev, v))
    prev = v
me = bpy.data.meshes.new('DND_Cord'); bm.to_mesh(me); bm.free()
cord = bpy.data.objects.new('DND_Cord', me); col.objects.link(cord); cord.parent = ps
sk = cord.modifiers.new('skin', 'SKIN')
for v in cord.data.skin_vertices[0].data: v.radius = (0.005, 0.005)
cord.data.materials.append(M['phone'])

# ════════════════ СЦЕНА ════════════════
# розкладка (як у public/dnd.js): центр дуг C = (0, −6); передній ряд R=7, ±36°; задній — R=9.6, ±29°, на ярусі 0.75
CX, CY = 0.0, -6.0
st = empty('DND_Stage')
bm = bmesh.new()
cyl(bm, (0, 0.5, -0.15), 12.6, 12.6, 0.3, 'floor', 128)
torus(bm, (0, 0.5, 0.0), 12.6, 0.06, 'trim', 128, 8)
for rr in (11.6, 3.2):
    sector(bm, 0, 0.5, rr - 0.035, rr + 0.035, 0, 2 * math.pi, 0.0, 0.006, 'neon', 160)
# промені від центру сцени — тонкі золоті лінії в підлозі
for k in range(24):
    a = 2 * math.pi * k / 24
    rot = Matrix.Rotation(-a, 3, 'Z')
    box(bm, Vector((0, 0.5, 0.003)) + rot @ Vector((0, 7.4, 0)), (0.03, 8.2, 0.006), 'ngold', rot)
bevel(mesh_obj('DND_Floor', bm, st), 0.0, 1)
# ярус заднього ряду
bm = bmesh.new()
sector(bm, CX, CY, 8.55, 10.9, math.radians(-38), math.radians(38), 0.0, 0.75, 'tier', 64, front_key='tier')
sector(bm, CX, CY, 8.5, 8.56, math.radians(-38), math.radians(38), 0.62, 0.7, 'neon', 64)
sector(bm, CX, CY, 8.52, 8.6, math.radians(-38), math.radians(38), 0.75, 0.79, 'trim', 64)
mesh_obj('DND_Tier', bm, st)
# LED-стіна: темна дуга + панелі-екрани між неоновими стійками + верхня смуга
bm = bmesh.new()
WR, A0 = 13.4, math.radians(64)
sector(bm, CX, CY, WR, WR + 0.3, -A0, A0, 0.0, 7.6, 'wall', 96)
NP = 15
for i in range(NP):
    a0 = -A0 + (2 * A0) * i / NP + 0.012; a1 = -A0 + (2 * A0) * (i + 1) / NP - 0.012
    sector(bm, CX, CY, WR - 0.06, WR - 0.02, a0, a1, 0.6, 6.6, 'screen', 6)
for i in range(NP + 1):
    a = -A0 + (2 * A0) * i / NP
    box(bm, (CX + (WR - 0.08) * math.sin(a), CY + (WR - 0.08) * math.cos(a), 3.6), (0.07, 0.07, 6.2), 'neon', Matrix.Rotation(-a, 3, 'Z'))
sector(bm, CX, CY, WR - 0.12, WR - 0.04, -A0, A0, 6.78, 6.86, 'ngold', 96)
sector(bm, CX, CY, WR - 0.12, WR - 0.04, -A0, A0, 0.38, 0.44, 'ngold', 96)
mesh_obj('DND_Wall', bm, st)
# великий круглий екран над заднім рядом (гра пише на ньому текст) + золоте кільце
SY = CY + WR - 0.45
bm = bmesh.new()
torus(bm, (0, SY, 4.7), 2.05, 0.09, 'ngold', 96, 12, Matrix.Rotation(math.pi / 2, 3, 'X'))
torus(bm, (0, SY - 0.02, 4.7), 2.28, 0.03, 'neon', 96, 8, Matrix.Rotation(math.pi / 2, 3, 'X'))
cyl(bm, (0, SY + 0.12, 4.7), 2.12, 2.12, 0.16, 'wall', 96, Matrix.Rotation(math.pi / 2, 3, 'X'))
mesh_obj('DND_ScreenFrame', bm, st)
bm = bmesh.new()
uvl = bm.loops.layers.uv.new('UVMap')
cr = bmesh.ops.create_circle(bm, cap_ends=True, cap_tris=False, segments=96, radius=2.0)
for f in bm.faces:
    f.material_index = MI['big']
    for l in f.loops: l[uvl].uv = (l.vert.co.x / 4.0 + 0.5, l.vert.co.y / 4.0 + 0.5)
for v in bm.verts: v.co = Matrix.Rotation(math.pi / 2, 3, 'X') @ v.co + Vector((0, SY - 0.04, 4.7))
me = bpy.data.meshes.new('DND_BigScreen'); bm.to_mesh(me); bm.free()
for m in ML: me.materials.append(m)
bs = bpy.data.objects.new('DND_BigScreen', me); col.objects.link(bs); bs.parent = st
# нормаль екрана — до камери (−Y)
if bs.data.polygons[0].normal.y > 0:
    bm = bmesh.new(); bm.from_mesh(bs.data); bmesh.ops.reverse_faces(bm, faces=bm.faces); bm.to_mesh(bs.data); bm.free()

# ── UV: кубічна розгортка в метрах (гра кладе на неї процедурні текстури: шліфований метал, мармур, LED-точки) ──
for o in list(col.objects):
    if o.type != 'MESH' or o.name == 'DND_BigScreen' or any(m.type == 'SKIN' for m in o.modifiers): continue
    bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=False, clip_to_bounds=False, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
# ── експорт ──
bpy.ops.object.select_all(action='DESELECT')
for o in col.objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'dnd.glb'), export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'dnd_studio.blend'))
print('DND OK', os.path.getsize(os.path.join(OUT, 'dnd.glb')), [o.name for o in col.objects if o.parent is None])
