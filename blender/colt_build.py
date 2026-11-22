# Кольт Нейві 1851 (Sketchfab, .glb) → public/models/revolver/revolver_colt.glb для режиму «Револьвер».
# Запуск: blender -b --factory-startup --python blender/colt_build.py -- <шлях до .glb>
# Модель приводиться до схеми гри (revolver3d.js): ствол уздовж +X, вісь барабана — через початок координат,
# одна камора вгорі навпроти ствола, радіус кола камор = 1.36. Вузли: REV_FRAME (усе нерухоме),
# REV_CYL (барабан, крутиться навколо X), REV_HAMMER (курок, обертається навколо свого гвинта),
# REV_BULLET / REV_CASE — патрон і гільза зі старої моделі (blender/revolver.blend).
# Капсулі й брандтрубки на задній стінці барабана прибираються — туди в'їжджають патрони.
import bpy, sys, os, math, json
from mathutils import Vector, Matrix
SRC = sys.argv[sys.argv.index('--') + 1]
ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'models', 'revolver', 'revolver_colt.glb')
RC = 1.36

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)
base = lambda o: o.name.split('_Mat_')[0]
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
# у файлі дві копії: зібраний револьвер (назви без «.001») і розкладені деталі — лишаємо зібраний
keep = [o for o in meshes if '.' not in base(o)]
for o in keep: mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
for o in list(bpy.context.scene.objects):
    if o not in keep: bpy.data.objects.remove(o, do_unlink=True)
# ствол у моделі дивиться в −X — розвертаємо на 180° навколо Z
Rz = Matrix.Rotation(math.pi, 4, 'Z')
for o in keep: o.matrix_world = Rz @ o.matrix_world
for s in bpy.context.selected_objects: s.select_set(False)
for o in keep: o.select_set(True)
bpy.context.view_layer.objects.active = keep[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
def bbox(objs):
    ps = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    return Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps))), Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
def center(objs): a, b = bbox(objs); return (a + b) / 2
by = lambda pre: [o for o in keep if base(o).startswith(pre)]
cyl = by('Cylinder_LP'); nip = by('Nipple'); caps = by('Cap')
cmn, cmx = bbox(cyl); ax = (cmn + cmx) / 2          # центр барабана (вісь уздовж X)
nc = [center([o]) for o in nip]
rc = sum(math.hypot(c.y - ax.y, c.z - ax.z) for c in nc) / len(nc)
# поворот барабана навколо X, щоб одна камора стала вгорі (+Z)
phis = [math.atan2(c.y - ax.y, c.z - ax.z) for c in nc]
phi = min(phis, key=abs)
rot = Matrix.Translation(ax) @ Matrix.Rotation(phi, 4, 'X') @ Matrix.Translation(-ax)
chk = rot @ nc[phis.index(phi)]
if abs(chk.y - ax.y) > 1e-3 * rc:                  # знак кута — перевіряємо й за потреби навпаки
    rot = Matrix.Translation(ax) @ Matrix.Rotation(-phi, 4, 'X') @ Matrix.Translation(-ax)
for o in cyl: o.matrix_world = rot @ o.matrix_world
gone = set(id(o) for o in nip + caps)
keep = [o for o in keep if id(o) not in gone]
for o in nip + caps: bpy.data.objects.remove(o, do_unlink=True)
# центр барабана → початок координат; масштаб: радіус кола камор = RC
s = RC / rc
T = Matrix.Diagonal(Vector((s, s, s, 1))) @ Matrix.Translation(-ax)
for o in keep: o.matrix_world = T @ o.matrix_world
for s_ in bpy.context.selected_objects: s_.select_set(False)
for o in keep: o.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# курок: опорна точка — центр гвинта курка
hammer = by('Hammer_LP')[0]; hpiv = center(by('HammerScrew_LP'))
bpy.context.scene.cursor.location = hpiv
for s_ in bpy.context.selected_objects: s_.select_set(False)
hammer.select_set(True); bpy.context.view_layer.objects.active = hammer
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
hammer.name = 'REV_HAMMER'
# барабан: один вузол з опорою в центрі осі; вісь барабана (Arbor) — разом із ним, щоб при відкиданні він не протикався нею
cylo = by('Cylinder_LP')[0]
RIM = bbox([cylo])[0].x            # задня стінка самого барабана (до приєднання осі, яка стирчить далі)
arb = by('Arbor_LP')
import bmesh
for o in arb:   # частину осі позаду барабана відрізаємо — інакше при відкиданні вона проходить крізь щит рамки
    bm = bmesh.new(); bm.from_mesh(o.data)
    loc = o.matrix_world.inverted() @ Vector((RIM + 0.02, 0, 0))
    r = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=loc, plane_no=(1, 0, 0), clear_inner=True)
    edges = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    if edges: bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bm.to_mesh(o.data); bm.free()
if arb:
    for s_ in bpy.context.selected_objects: s_.select_set(False)
    for o in arb: o.select_set(True)
    cylo.select_set(True); bpy.context.view_layer.objects.active = cylo
    bpy.ops.object.join()
    keep = [o for o in keep if o not in arb]
bpy.context.scene.cursor.location = (0, 0, 0)
for s_ in bpy.context.selected_objects: s_.select_set(False)
cylo.select_set(True); bpy.context.view_layer.objects.active = cylo
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
cylo.name = 'REV_CYL'
# решта — нерухома рама
frame = [o for o in keep if o not in (hammer, cylo)]
for s_ in bpy.context.selected_objects: s_.select_set(False)
for o in frame: o.select_set(True)
bpy.context.view_layer.objects.active = frame[0]
bpy.ops.object.join(); fr = bpy.context.view_layer.objects.active; fr.name = 'REV_FRAME'
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
# мітки для гри
cmn, cmx = bbox([cylo]); fmn, fmx = bbox([fr, cylo, hammer])
barrel_tip = fmx.x
meta = dict(RC=RC, RIM_X=round(RIM, 3), MUZZLE=[round(barrel_tip, 3), RC, 0], FLOOR_Y=round(fmn.z - 0.7, 3),
            cylR=round(max(cmx.y, cmx.z), 3), size=[round(fmx.x - fmn.x, 2), round(fmx.z - fmn.z, 2)], hammer=[round(v, 3) for v in hammer.location], scale=s)
# текстури → 2048 (зброя — близький план)
for im in bpy.data.images:
    if im.size[0] > 2048: im.scale(2048, 2048)
# патрон і гільза зі старої моделі
with bpy.data.libraries.load(os.path.join(ROOT, 'blender', 'revolver.blend')) as (src, dst):
    dst.objects = [n for n in src.objects if n in ('REV_BULLET', 'REV_CASE')]
for o in dst.objects:
    if o: bpy.context.scene.collection.objects.link(o)
for s_ in bpy.context.selected_objects: s_.select_set(False)
for o in bpy.context.scene.objects:
    if o.type == 'MESH': o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True, export_image_format='JPEG')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'revolver_colt.blend'))
print('COLT META', json.dumps(meta))
print('COLT OK', os.path.getsize(OUT), sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH'))
