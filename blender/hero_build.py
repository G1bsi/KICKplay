# Персонаж-пасхалка для Cash Hunt: чергується з пінгвіном на прилавку.
# Запуск: blender -b blender/cashhunt_hero.blend --python blender/hero_build.py   (або з порожнього файлу — сам збереже)
# Обличчя — фото (blender/hero_face.png) на фронтальній «масці» голови з плавною прозорістю по краях.
# Окремі обʼєкти = окремі шматки для вибуху. Перед персонажа — до −Y (у грі дивиться в камеру).
import bpy, bmesh, math, os
from mathutils import Vector, Matrix, Euler
HERE = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else r'D:\KICKplay-main\blender'
FACE = os.path.join(HERE, 'hero_face.png')
OUT = r'D:\KICKplay-main\public\models\cashhunt\hero.glb'

col = bpy.data.collections.get('HERO') or bpy.data.collections.new('HERO')
if col.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(col)
for o in list(col.objects): bpy.data.objects.remove(o, do_unlink=True)

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c) + (1,)
def mat(name, hexc, rough=0.5, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = lin(hexc); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m
M = dict(skin=mat('HR_Skin', '#d99a7c', 0.55), over=mat('HR_Overalls', '#e5512a', 0.6), overD=mat('HR_OverallsDark', '#b63f1e', 0.65),
         cream=mat('HR_Letter', '#f3e1ba', 0.5), shoe=mat('HR_Shoe', '#1fae3f', 0.22), hat=mat('HR_Hat', '#8c1f61', 0.28),
         btn=mat('HR_Button', '#c78a2c', 0.35, 0.55), hair=mat('HR_Hair', '#2a2320', 0.7), patchA=mat('HR_PatchA', '#8e7cc6', 0.7), patchB=mat('HR_PatchB', '#c8b6a2', 0.75))
# обличчя: фото з альфою
fm = bpy.data.materials.get('HR_Face') or bpy.data.materials.new('HR_Face'); fm.use_nodes = True
nt = fm.node_tree; b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
for n in [n for n in nt.nodes if n.type == 'TEX_IMAGE']: nt.nodes.remove(n)
img = bpy.data.images.load(FACE, check_existing=True); img.pack()
tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = img; tx.extension = 'CLIP'
nt.links.new(tx.outputs['Color'], b.inputs['Base Color']); nt.links.new(tx.outputs['Alpha'], b.inputs['Alpha'])
b.inputs['Roughness'].default_value = 0.6
try: fm.blend_method = 'BLEND'
except Exception: pass
try: fm.surface_render_method = 'BLENDED'
except Exception: pass
M['face'] = fm

def put(name, bm, m, smooth=True):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); me.materials.append(m)
    for p in me.polygons: p.use_smooth = smooth
    o = bpy.data.objects.new(name, me); col.objects.link(o); return o
def ell(name, c, r, m, rot=(0, 0, 0), seg=28, ring=18):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=1.0)
    bm.transform(Matrix.Translation(Vector(c)) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal(Vector((r[0], r[1], r[2], 1))))
    return put(name, bm, m)
def cyl(name, c, r, h, m, rot=(0, 0, 0), seg=24):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=h)
    bm.transform(Matrix.Translation(Vector(c)) @ Euler(rot).to_matrix().to_4x4())
    return put(name, bm, m)
def box(name, c, half, m, rot=(0, 0, 0)):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
    bm.transform(Matrix.Translation(Vector(c)) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal(Vector((half[0], half[1], half[2], 1))))
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=min(half) * 0.35, segments=3, affect='EDGES')
    return put(name, bm, m)
def bar(name, a, b2, r, m):
    a, b2 = Vector(a), Vector(b2); d = b2 - a
    q = d.normalized().to_track_quat('Z', 'Y')
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=r, radius2=r, depth=d.length)
    bm.transform(Matrix.Translation((a + b2) / 2) @ q.to_matrix().to_4x4() @ Matrix.Diagonal(Vector((1, 0.45, 1, 1))))
    return put(name, bm, m)

# ── ноги й черевики ──
for sx, nm in ((-1, 'L'), (1, 'R')):
    ell('HR_Shoe' + nm, (sx * 0.21, -0.11, 0.085), (0.16, 0.27, 0.1), M['shoe'], rot=(0, 0, sx * -0.12))
    cyl('HR_Leg' + nm, (sx * 0.19, 0.0, 0.3), 0.115, 0.36, M['over'])
    cyl('HR_Cuff' + nm, (sx * 0.19, 0.0, 0.135), 0.125, 0.05, M['overD'])
# ── тулуб: комбінезон знизу, голі плечі й груди зверху ──
ell('HR_Belly', (0, 0, 0.74), (0.43, 0.38, 0.4), M['over'])
ell('HR_Chest', (0, 0.03, 1.11), (0.5, 0.32, 0.25), M['skin'])
ell('HR_Bib', (0, -0.2, 1.0), (0.27, 0.16, 0.21), M['over'])
for sx, nm in ((-1, 'L'), (1, 'R')):
    bar('HR_StrapF' + nm, (sx * 0.17, -0.33, 1.17), (sx * 0.2, -0.16, 1.33), 0.045, M['overD'])
    bar('HR_StrapB' + nm, (sx * 0.2, -0.16, 1.33), (sx * 0.2, 0.3, 1.18), 0.045, M['overD'])
    cyl('HR_Button' + nm, (sx * 0.17, -0.355, 1.16), 0.038, 0.03, M['btn'], rot=(math.pi / 2, 0, 0))
    # великі округлі плечі й довгі руки до колін
    ell('HR_Shoulder' + nm, (sx * 0.46, 0.03, 1.13), (0.22, 0.24, 0.22), M['skin'])
    ell('HR_Arm' + nm, (sx * 0.6, 0.0, 0.82), (0.15, 0.16, 0.36), M['skin'], rot=(0, sx * 0.14, 0))
    ell('HR_Hand' + nm, (sx * 0.66, -0.03, 0.43), (0.14, 0.13, 0.17), M['skin'])
# кишеня з літерою H і латки
box('HR_Pocket', (0, -0.385, 0.8), (0.14, 0.02, 0.12), M['overD'], rot=(0.18, 0, 0))
cu = bpy.data.curves.new('HR_H', 'FONT'); cu.body = 'H'; cu.align_x = 'CENTER'; cu.align_y = 'CENTER'; cu.size = 0.2; cu.extrude = 0.012
to = bpy.data.objects.new('HR_Htmp', cu); bpy.context.scene.collection.objects.link(to)
to.location = (0, -0.41, 0.8); to.rotation_euler = (math.pi / 2 + 0.18, 0, 0); bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get(); hm = bpy.data.meshes.new_from_object(to.evaluated_get(dg))
ho = bpy.data.objects.new('HR_Letter', hm); ho.matrix_world = to.matrix_world.copy(); hm.materials.clear(); hm.materials.append(M['cream']); col.objects.link(ho)
bpy.data.objects.remove(to); bpy.data.curves.remove(cu)
box('HR_PatchA', (0.2, -0.345, 0.62), (0.06, 0.012, 0.05), M['patchA'], rot=(0.35, 0.45, 0.25))
box('HR_PatchB', (0.25, -0.315, 0.555), (0.05, 0.012, 0.045), M['patchB'], rot=(0.4, 0.5, -0.2))
# ── шия, голова, вуха, волосся, обличчя-фото ──
cyl('HR_Neck', (0, 0.0, 1.32), 0.14, 0.16, M['skin'])
HC, HR_ = Vector((0, 0, 1.66)), Vector((0.3, 0.29, 0.37))   # голова велика, як на референсі
ell('HR_Head', HC, HR_, M['skin'], seg=36, ring=24)
for sx, nm in ((-1, 'L'), (1, 'R')): ell('HR_Ear' + nm, (sx * 0.295, 0.02, 1.64), (0.045, 0.07, 0.09), M['skin'])
bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=36, v_segments=24, radius=1.0)
bm.transform(Matrix.Translation(HC) @ Matrix.Diagonal(Vector((HR_.x * 1.03, HR_.y * 1.03, HR_.z * 1.03, 1))))
bmesh.ops.delete(bm, geom=[v for v in bm.verts if (v.co.y < 0.04 and (v.co.z - HC.z) < 0.2) or (v.co.z - HC.z) < -0.12], context='VERTS')   # лишається тім'я і потилиця
put('HR_Hair', bm, M['hair'])
bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=32, radius=1.0)
bm.transform(Matrix.Translation(HC) @ Matrix.Diagonal(Vector((HR_.x * 1.045, HR_.y * 1.045, HR_.z * 1.045, 1))))
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y > -0.02], context='VERTS')
uv = bm.loops.layers.uv.new('UVMap')
FW, FH = HR_.x * 1.02, HR_.z * 1.02
for f in bm.faces:
    for l in f.loops:
        p = l.vert.co; l[uv].uv = (0.5 + p.x / (2 * FW), 0.5 + (p.z - HC.z) / (2 * FH))
put('HR_Face', bm, M['face'])
# ── капелюх-циліндр, нахилений ──
hat = Matrix.Translation(Vector((-0.04, 0.01, 2.02))) @ Euler((-0.12, 0.28, 0)).to_matrix().to_4x4()
for nm, c, r, h in (('HR_HatBrim', (0, 0, 0), 0.16, 0.03), ('HR_HatCrown', (0, 0, 0.1), 0.095, 0.18), ('HR_HatTop', (0, 0, 0.19), 0.1, 0.02)):
    bm2 = bmesh.new(); bmesh.ops.create_cone(bm2, cap_ends=True, segments=28, radius1=r, radius2=r, depth=h)
    bm2.transform(hat @ Matrix.Translation(Vector(c))); put(nm, bm2, M['hat'])
bpy.context.view_layer.update()
# експорт
for o in bpy.context.selected_objects: o.select_set(False)
for o in col.objects: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True)
if bpy.data.filepath: bpy.ops.wm.save_mainfile()
else: bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'cashhunt_hero.blend'))
print('HERO OK', os.path.getsize(OUT), len(col.objects))
