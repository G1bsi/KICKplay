# Батл Рояль 2.0 — анімований боєць (скелет + анімації), власний дизайн у стилізованій «MOBA»-подачі.
# Запуск: E:\Blender\blender.exe -b --factory-startup --python blender/br_hero.py
# Пише public/models/br/hero.glb: SkinnedMesh BR_Hero (матеріали BR_Tint — колір гравця, BR_Skin, BR_Dark, BR_Gear, BR_Metal),
# гвинтівка BR_Gun (на грудях, у руках) і BR_GunBack (за спиною — для перемоги/парашута), купол BR_Chute (на кістці chest).
# Анімації (NLA-доріжки → glTF clips): Idle, Run, Aim, Crouch, Throw, Death, Victory, Chute.
# Персонаж дивиться в −Y Blender (= +Z у three.js).
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler

ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'models', 'br'); os.makedirs(OUT, exist_ok=True)
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
sc = bpy.context.scene; sc.render.fps = 30

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c) + (1,)
def mat(name, hexc, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = lin(hexc); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m
MT = [mat('BR_Tint', '#d8d8d8', 0.7), mat('BR_Skin', '#f2b98e', 0.55), mat('BR_Dark', '#2e2b31', 0.75), mat('BR_Gear', '#6f7a3e', 0.7), mat('BR_Metal', '#3b4049', 0.35, 0.6)]
TINT, SKIN, DARK, GEAR, METAL = range(5)

# ── скелет (голова/хвіст у координатах Blender: x вправо від персонажа = −x? персонаж дивиться −Y, його ліва рука — +X) ──
B = {
    'hips':       ((0, 0, 0.92), (0, 0, 1.10), None),
    'spine':      ((0, 0, 1.10), (0, 0, 1.30), 'hips'),
    'chest':      ((0, 0, 1.30), (0, 0, 1.56), 'spine'),
    'neck':       ((0, 0, 1.56), (0, 0, 1.64), 'chest'),
    'head':       ((0, 0, 1.64), (0, 0, 2.02), 'neck'),
    'upperarm.L': ((0.27, 0, 1.50), (0.31, 0, 1.20), 'chest'),
    'forearm.L':  ((0.31, 0, 1.20), (0.33, 0, 0.94), 'upperarm.L'),
    'hand.L':     ((0.33, 0, 0.94), (0.33, 0, 0.84), 'forearm.L'),
    'upperarm.R': ((-0.27, 0, 1.50), (-0.31, 0, 1.20), 'chest'),
    'forearm.R':  ((-0.31, 0, 1.20), (-0.33, 0, 0.94), 'upperarm.R'),
    'hand.R':     ((-0.33, 0, 0.94), (-0.33, 0, 0.84), 'forearm.R'),
    'thigh.L':    ((0.12, 0, 0.92), (0.13, 0, 0.50), 'hips'),
    'shin.L':     ((0.13, 0, 0.50), (0.13, 0.02, 0.10), 'thigh.L'),
    'foot.L':     ((0.13, 0.02, 0.10), (0.13, -0.16, 0.03), 'shin.L'),
    'thigh.R':    ((-0.12, 0, 0.92), (-0.13, 0, 0.50), 'hips'),
    'shin.R':     ((-0.13, 0, 0.50), (-0.13, 0.02, 0.10), 'thigh.R'),
    'foot.R':     ((-0.13, 0.02, 0.10), (-0.13, -0.16, 0.03), 'shin.R'),
}
arm_data = bpy.data.armatures.new('BR_Rig'); rig = bpy.data.objects.new('BR_Rig', arm_data); sc.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig; rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name, (h, t, p) in B.items():
    eb = arm_data.edit_bones.new(name); eb.head = h; eb.tail = t; eb.roll = 0
    if name.startswith('foot'): eb.roll = 0
for name, (h, t, p) in B.items():
    if p: arm_data.edit_bones[name].parent = arm_data.edit_bones[p]; arm_data.edit_bones[name].use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

# ── тіло: skin-модифікатор по «скелету», потім субдив ──
SK = [  # (позиція, радіус x, радіус y)
    ((0, 0, 0.90), 0.20, 0.15), ((0, 0, 1.12), 0.21, 0.155), ((0, 0, 1.36), 0.255, 0.17), ((0, 0, 1.56), 0.10, 0.10),   # 0..3 тулуб
    ((0.24, 0, 1.49), 0.10, 0.10), ((0.31, 0, 1.20), 0.085, 0.085), ((0.33, 0, 0.95), 0.07, 0.07),                    # 4..6 рука Л
    ((-0.24, 0, 1.49), 0.10, 0.10), ((-0.31, 0, 1.20), 0.085, 0.085), ((-0.33, 0, 0.95), 0.07, 0.07),                 # 7..9 рука П
    ((0.11, 0, 0.88), 0.105, 0.11), ((0.13, 0, 0.50), 0.085, 0.09), ((0.13, 0.02, 0.14), 0.07, 0.075),                 # 10..12 нога Л
    ((-0.11, 0, 0.88), 0.105, 0.11), ((-0.13, 0, 0.50), 0.085, 0.09), ((-0.13, 0.02, 0.14), 0.07, 0.075),              # 13..15 нога П
]
ED = [(0, 1), (1, 2), (2, 3), (2, 4), (4, 5), (5, 6), (2, 7), (7, 8), (8, 9), (0, 10), (10, 11), (11, 12), (0, 13), (13, 14), (14, 15)]
me = bpy.data.meshes.new('body'); me.from_pydata([p for p, _, _ in SK], ED, []); me.update()
body = bpy.data.objects.new('body', me); sc.collection.objects.link(body)
sk = body.modifiers.new('skin', 'SKIN'); sk.use_smooth_shade = True
for i, (_, rx, ry) in enumerate(SK):
    body.data.skin_vertices[0].data[i].radius = (rx, ry)
body.data.skin_vertices[0].data[0].use_root = True
sub = body.modifiers.new('sub', 'SUBSURF'); sub.levels = 2; sub.render_levels = 2
bpy.context.view_layer.objects.active = body
for m in list(body.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
body.data.materials.append(MT[TINT])

parts = [body]
def prim(kind, loc, scl, mi, rot=(0, 0, 0), bone=None, seg=16):
    if kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=max(6, seg // 2), radius=1, location=loc, rotation=rot)
    elif kind == 'cube': bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    elif kind == 'cyl': bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=1, depth=1, location=loc, rotation=rot)
    elif kind == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=seg, radius1=1, radius2=0, depth=1, location=loc, rotation=rot)
    o = bpy.context.object; o.scale = scl
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if kind == 'cube':
        bv = o.modifiers.new('bv', 'BEVEL'); bv.width = min(scl) * 0.18; bv.segments = 2; bpy.ops.object.modifier_apply(modifier='bv')
    o.data.materials.append(MT[mi])
    for p in o.data.polygons: p.use_smooth = True
    o['bone'] = bone
    parts.append(o); return o
# голова (трохи більша — читається зверху), шолом, окуляри, ніс, вуха
prim('sphere', (0, 0, 1.80), (0.20, 0.19, 0.21), SKIN, bone='head', seg=24)
prim('sphere', (0, 0.01, 1.87), (0.235, 0.235, 0.17), TINT, bone='head', seg=24)                 # шолом
prim('cube', (0, -0.005, 1.835), (0.48, 0.44, 0.035), TINT, bone='head')                          # козирок/обідок шолома
prim('cube', (0, -0.175, 1.86), (0.30, 0.06, 0.075), DARK, bone='head')                           # окуляри на шоломі
prim('sphere', (0.075, -0.215, 1.86), (0.055, 0.02, 0.04), METAL, bone='head')
prim('sphere', (-0.075, -0.215, 1.86), (0.055, 0.02, 0.04), METAL, bone='head')
prim('sphere', (0, -0.195, 1.77), (0.04, 0.04, 0.035), SKIN, bone='head')                         # ніс
prim('sphere', (0.06, -0.175, 1.795), (0.022, 0.012, 0.028), DARK, bone='head')                   # очі
prim('sphere', (-0.06, -0.175, 1.795), (0.022, 0.012, 0.028), DARK, bone='head')
prim('sphere', (0.195, 0, 1.79), (0.035, 0.05, 0.06), SKIN, bone='head'); prim('sphere', (-0.195, 0, 1.79), (0.035, 0.05, 0.06), SKIN, bone='head')
# бронежилет, підсумки, пояс, рюкзак
prim('cube', (0, -0.02, 1.33), (0.50, 0.36, 0.40), GEAR, bone='chest')
for x in (-0.12, 0.0, 0.12): prim('cube', (x, -0.2, 1.24), (0.10, 0.06, 0.13), DARK, bone='chest')
prim('cube', (0, 0, 1.0), (0.44, 0.33, 0.09), DARK, bone='hips')
prim('cube', (0, -0.165, 1.0), (0.08, 0.02, 0.06), METAL, bone='hips')
prim('cube', (0, 0.23, 1.30), (0.38, 0.18, 0.42), GEAR, bone='chest')
prim('cube', (0, 0.25, 1.53), (0.32, 0.16, 0.08), DARK, bone='chest')
prim('cyl', (0, 0.23, 1.06), (0.09, 0.09, 0.30), DARK, rot=(0, math.pi / 2, 0), bone='chest')    # спальник
# наплічники, рукавички, черевики, наколінники
for s in (1, -1):
    sd = 'L' if s > 0 else 'R'
    prim('sphere', (0.25 * s, 0, 1.53), (0.12, 0.12, 0.09), GEAR, bone='upperarm.' + sd)
    prim('sphere', (0.335 * s, -0.01, 0.89), (0.07, 0.07, 0.08), DARK, bone='hand.' + sd)
    prim('cube', (0.13 * s, -0.04, 0.07), (0.17, 0.30, 0.14), DARK, bone='foot.' + sd)
    prim('sphere', (0.13 * s, -0.07, 0.50), (0.07, 0.04, 0.07), GEAR, bone='shin.' + sd)

# ── ваги: тіло — по найближчих сегментах кісток, деталі — жорстко до своєї кістки ──
def seg_d(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared)); return (p - (a + ab * t)).length
BONES = {n: (Vector(h), Vector(t)) for n, (h, t, _) in B.items()}
SKIP_FOR_BODY = {'neck'}
def weights_body(o):
    vg = {n: o.vertex_groups.new(name=n) for n in B}
    for v in o.data.vertices:
        p = v.co
        ds = sorted(((seg_d(p, *BONES[n]), n) for n in B if n not in SKIP_FOR_BODY and not n.startswith('hand') and n != 'head'), key=lambda x: x[0])
        d0, n0 = ds[0]; d1, n1 = ds[1]
        w0, w1 = 1 / (d0 + 1e-4) ** 4, 1 / (d1 + 1e-4) ** 4
        # не змішуємо руки з ногами/тулубом довільно — лише сусідні кістки
        def related(a, b):
            return B[a][2] == b or B[b][2] == a or B[a][2] == B[b][2]
        if not related(n0, n1): w1 = 0
        s = w0 + w1
        vg[n0].add([v.index], w0 / s, 'REPLACE')
        if w1 > 0: vg[n1].add([v.index], w1 / s, 'REPLACE')
weights_body(body)
for o in parts[1:]:
    g = o.vertex_groups.new(name=o['bone']); g.add([v.index for v in o.data.vertices], 1.0, 'REPLACE')
# злиття в один меш
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
hero = bpy.context.object; hero.name = 'BR_Hero'
for p in hero.data.polygons: p.use_smooth = True
mod = hero.modifiers.new('arm', 'ARMATURE'); mod.object = rig
hero.parent = rig

# ── гвинтівки: у руках (на грудях) і за спиною ──
def build_gun(name, loc, rot):
    objs = []
    def add(kind, l, s, mi, r=(0, 0, 0)):
        if kind == 'cube': bpy.ops.mesh.primitive_cube_add(size=1, location=l, rotation=r)
        else: bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=1, depth=1, location=l, rotation=r)
        o = bpy.context.object; o.scale = s; bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        if kind == 'cube':
            bv = o.modifiers.new('bv', 'BEVEL'); bv.width = min(s) * 0.2; bv.segments = 1; bpy.ops.object.modifier_apply(modifier='bv')
        o.data.materials.append(MT[mi]); objs.append(o)
    # уздовж −Y (вперед)
    add('cube', (0, -0.25, 0), (0.07, 0.55, 0.11), METAL)
    add('cyl', (0, -0.68, 0.015), (0.022, 0.022, 0.34), METAL, (math.pi / 2, 0, 0))
    add('cube', (0, -0.18, -0.12), (0.055, 0.09, 0.17), DARK, (0.25, 0, 0))
    add('cube', (0, 0.12, -0.03), (0.06, 0.24, 0.12), lin and DARK)
    add('cube', (0, -0.3, 0.09), (0.05, 0.16, 0.05), DARK)
    add('cube', (0, -0.44, -0.02), (0.075, 0.18, 0.07), GEAR)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
    g = bpy.context.object; g.name = name
    g.matrix_world = Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4()
    for p in g.data.polygons: p.use_smooth = False
    return g
gun = build_gun('BR_Gun', Vector((-0.06, -0.30, 1.22)), (0, 0, 0.12))
gunb = build_gun('BR_GunBack', Vector((0.0, 0.36, 1.33)), (0, math.radians(35), math.radians(90)))
def parent_to_bone(o, bone):
    mw = o.matrix_world.copy()
    o.parent = rig; o.parent_type = 'BONE'; o.parent_bone = bone
    o.matrix_world = mw
parent_to_bone(gun, 'chest'); parent_to_bone(gunb, 'chest')

# купол парашута (на chest; гра показує його лише під час десанту)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1, location=(0, 0, 0))
ch = bpy.context.object; bm = bmesh.new(); bm.from_mesh(ch.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.05], context='VERTS'); bm.to_mesh(ch.data); bm.free()
ch.scale = (1.5, 1.5, 0.85); ch.location = (0, 0, 3.6); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for f in ch.data.polygons:
    c = f.center; a = math.atan2(c.y, c.x); f.material_index = 0 if int((a + math.pi) / (math.tau / 16)) % 2 == 0 else 1
ch.data.materials.append(MT[TINT]); bpy.data.materials.new('BR_ChuteW')
mw = mat('BR_ChuteW', '#f4f1ea', 0.8); ch.data.materials.append(mw)
for k in range(8):   # стропи
    a = k / 8 * math.tau; x, y = math.cos(a) * 1.35, math.sin(a) * 1.35
    top, bot = Vector((x, y, 3.62)), Vector((0.24 * math.copysign(1, x) if abs(x) > 0.3 else 0, 0.05, 1.55))
    d = top - bot; mid = (top + bot) / 2
    bpy.ops.mesh.primitive_cylinder_add(vertices=4, radius=0.008, depth=d.length, location=mid)
    s = bpy.context.object; s.rotation_euler = d.to_track_quat('Z', 'Y').to_euler(); bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    s.data.materials.append(mw)
    bpy.ops.object.select_all(action='DESELECT'); s.select_set(True); ch.select_set(True); bpy.context.view_layer.objects.active = ch; bpy.ops.object.join()
ch = bpy.context.object; ch.name = 'BR_Chute'
for p in ch.data.polygons: p.use_smooth = True
parent_to_bone(ch, 'chest')

# ── анімації ──
D = math.radians
def pose(keys, frame):
    """keys: {bone: (rx, ry, rz) у градусах; 'loc': (x,y,z) для hips}"""
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
        r = keys.get(pb.name, (0, 0, 0))
        pb.rotation_euler = (D(r[0]), D(r[1]), D(r[2]))
        pb.keyframe_insert('rotation_euler', frame=frame)
    hp = rig.pose.bones['hips']; hp.location = keys.get('loc', (0, 0, 0)); hp.keyframe_insert('location', frame=frame)
# «готовність» з гвинтівкою: права рука тримає руків'я, ліва — цівку
HOLD = {'upperarm.R': (-38, 0, -6), 'forearm.R': (-70, 0, 12), 'hand.R': (0, 0, 0),
        'upperarm.L': (-55, 0, 32), 'forearm.L': (-60, 0, -10), 'chest': (0, 0, 0)}
AIM = {'upperarm.R': (-62, 0, -8), 'forearm.R': (-62, 0, 18), 'upperarm.L': (-72, 0, 38), 'forearm.L': (-48, 0, -12), 'chest': (-4, 8, 0), 'head': (4, -8, 0)}
def merge(*ds):
    out = {}
    for d in ds: out.update(d)
    return out
def action(name, frames, loop=True):
    rig.animation_data_create()
    act = bpy.data.actions.new(name); rig.animation_data.action = act
    for f, k in frames: pose(k, f)
    if loop:
        for fc in getattr(act, 'fcurves', []):
            for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'
    tr = rig.animation_data.nla_tracks.new(); tr.name = name
    st = tr.strips.new(name, int(frames[0][0]), act); st.name = name
    rig.animation_data.action = None
    return act
# Idle (40 кадрів)
action('Idle', [(1, merge(HOLD, {'spine': (2, 0, 0), 'loc': (0, 0, 0)})), (21, merge(HOLD, {'spine': (4, 0, 0), 'chest': (2, 0, 0), 'head': (0, 0, 6), 'loc': (0, 0, -0.01)})),
                (41, merge(HOLD, {'spine': (2, 0, 0), 'loc': (0, 0, 0)}))])
# Run (20 кадрів, цикл)
def run_k(s):
    return merge(HOLD, {
        'thigh.L': (-42 * s, 0, 0), 'shin.L': (25 + 35 * max(0, s), 0, 0), 'foot.L': (-10 * s, 0, 0),
        'thigh.R': (42 * s, 0, 0), 'shin.R': (25 + 35 * max(0, -s), 0, 0), 'foot.R': (10 * s, 0, 0),
        'spine': (10, 0, 6 * s), 'chest': (4, 0, -8 * s), 'head': (-8, 0, 5 * s), 'loc': (0, 0, -0.02 + 0.05 * abs(s))})
action('Run', [(1, run_k(1)), (6, run_k(0)), (11, run_k(-1)), (16, run_k(0)), (21, run_k(1))])
# Aim (стрільба: віддача, 8 кадрів)
action('Aim', [(1, merge(AIM, {'thigh.L': (-12, 0, 6), 'shin.L': (14, 0, 0), 'thigh.R': (10, 0, -4)})),
               (3, merge(AIM, {'chest': (-9, 8, 0), 'upperarm.R': (-56, 0, -8), 'thigh.L': (-12, 0, 6), 'shin.L': (14, 0, 0), 'thigh.R': (10, 0, -4)})),
               (9, merge(AIM, {'thigh.L': (-12, 0, 6), 'shin.L': (14, 0, 0), 'thigh.R': (10, 0, -4)}))])
# Crouch (присід за укриттям)
CR = merge(AIM, {'thigh.L': (-75, 0, 8), 'shin.L': (95, 0, 0), 'foot.L': (-20, 0, 0), 'thigh.R': (-10, 0, -6), 'shin.R': (110, 0, 0), 'foot.R': (-55, 0, 0),
                 'spine': (12, 0, 0), 'loc': (0, 0, -0.38)})
action('Crouch', [(1, CR), (21, merge(CR, {'spine': (15, 0, 2)})), (41, CR)])
# Throw (кидок гранати)
action('Throw', [(1, merge(HOLD, {})), (6, merge(HOLD, {'upperarm.L': (-150, 0, 20), 'forearm.L': (-60, 0, 0), 'chest': (0, -25, 0), 'spine': (-8, 0, 0)})),
                 (11, merge(HOLD, {'upperarm.L': (-70, 0, 10), 'forearm.L': (-10, 0, 0), 'chest': (10, 25, 0), 'spine': (12, 0, 0)})), (18, merge(HOLD, {}))], loop=False)
# Death (падіння навзнак)
action('Death', [(1, merge(HOLD, {})), (5, merge(HOLD, {'spine': (-20, 0, 0), 'head': (-25, 0, 0), 'upperarm.L': (-20, 0, 60), 'upperarm.R': (-20, 0, -60), 'loc': (0, 0.05, -0.05)})),
                 (14, {'hips': (-80, 0, 0), 'spine': (-10, 0, 0), 'head': (-15, 0, 10), 'upperarm.L': (0, 0, 80), 'upperarm.R': (0, 0, -80), 'forearm.L': (-20, 0, 0), 'forearm.R': (-20, 0, 0),
                       'thigh.L': (70, 0, 10), 'thigh.R': (60, 0, -10), 'shin.L': (20, 0, 0), 'shin.R': (35, 0, 0), 'loc': (0, 0.25, -0.62)}),
                 (22, {'hips': (-88, 0, 0), 'spine': (-4, 0, 0), 'head': (-10, 0, 14), 'upperarm.L': (5, 0, 88), 'upperarm.R': (5, 0, -85), 'forearm.L': (-10, 0, 0), 'forearm.R': (-25, 0, 0),
                       'thigh.L': (80, 0, 12), 'thigh.R': (78, 0, -12), 'shin.L': (8, 0, 0), 'shin.R': (20, 0, 0), 'loc': (0, 0.3, -0.75)})], loop=False)
# Victory (руки вгору, підстрибує)
V1 = {'upperarm.L': (0, 0, 160), 'upperarm.R': (0, 0, -160), 'forearm.L': (0, 0, 15), 'forearm.R': (0, 0, -15), 'head': (-10, 0, 0), 'chest': (-6, 0, 0), 'loc': (0, 0, 0)}
V2 = {'upperarm.L': (0, 0, 145), 'upperarm.R': (0, 0, -145), 'forearm.L': (0, 0, 35), 'forearm.R': (0, 0, -35), 'head': (-14, 0, 0), 'chest': (-10, 0, 0),
      'thigh.L': (-30, 0, 0), 'shin.L': (55, 0, 0), 'thigh.R': (-30, 0, 0), 'shin.R': (55, 0, 0), 'loc': (0, 0, 0.32)}
action('Victory', [(1, V1), (9, V2), (17, V1), (25, V2), (33, V1)])
# Chute (тримається за стропи, ноги бовтаються)
C1 = {'upperarm.L': (0, 0, 150), 'upperarm.R': (0, 0, -150), 'forearm.L': (0, 0, 20), 'forearm.R': (0, 0, -20), 'thigh.L': (-15, 0, 4), 'thigh.R': (10, 0, -4), 'shin.L': (25, 0, 0), 'shin.R': (15, 0, 0)}
C2 = merge(C1, {'thigh.L': (8, 0, 4), 'thigh.R': (-14, 0, -4), 'shin.L': (12, 0, 0), 'shin.R': (28, 0, 0)})
action('Chute', [(1, C1), (21, C2), (41, C1)])
for pb in rig.pose.bones: pb.rotation_euler = (0, 0, 0); pb.location = (0, 0, 0)

bpy.ops.object.select_all(action='DESELECT')
for o in (rig, hero, gun, gunb, ch): o.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'hero.glb'), export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                          export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True, export_materials='EXPORT',
                          export_force_sampling=True, export_frame_range=False)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'br_hero.blend'))
print('HERO OK', os.path.getsize(os.path.join(OUT, 'hero.glb')), len(hero.data.polygons), [t.name for t in rig.animation_data.nla_tracks])
