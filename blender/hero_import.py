# Згенерована 3D-модель (OBJ + PBR-текстури або .glb) → public/models/cashhunt/<назва>.glb для Cash Hunt.
# Запуск: blender -b --factory-startup --python blender/hero_import.py -- <джерело> [назва=hero]
#   джерело — папка з base.obj і texture_*.png, або файл .glb (матеріал і текстури всередині)
# Кроки: імпорт → спрощення (500k → ~45k трикутників) → текстури 1024 →
# ноги на z=0, центр по XY → поділ на шматки (капелюх, голова, тулуб, руки, ноги) для вибуху → GLB.
# Модель має дивитись у −Y (як віддає генератор); інакше — змінна оточення HERO_YAW (радіани).
import bpy, sys, os
from mathutils import Vector
ARGS = sys.argv[sys.argv.index('--') + 1:]
SRC = ARGS[0]; NAME = ARGS[1] if len(ARGS) > 1 else 'hero'
ROOT = r'D:\KICKplay-main'
OUT = os.path.join(ROOT, 'public', 'models', 'cashhunt', NAME + '.glb')
TEX = os.path.join(ROOT, 'blender', NAME + '_tex')
GLB = SRC.lower().endswith('.glb')
FACE_ROT = float(os.environ.get('HERO_YAW', '0'))

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
if GLB: bpy.ops.import_scene.gltf(filepath=SRC)
else: bpy.ops.wm.obj_import(filepath=os.path.join(SRC, 'base.obj'))
ob = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
mw = ob.matrix_world.copy(); ob.parent = None; ob.matrix_world = mw
for o in [o for o in bpy.context.scene.objects if o.type != 'MESH']: bpy.data.objects.remove(o, do_unlink=True)
ob.name = 'HR_Model'
for s in bpy.context.selected_objects: s.select_set(False)
bpy.context.view_layer.objects.active = ob; ob.select_set(True)
print('faces in', len(ob.data.polygons))
# спрощення
m = ob.modifiers.new('dec', 'DECIMATE'); m.ratio = 45000 / max(1, len(ob.data.polygons))
bpy.ops.object.modifier_apply(modifier='dec')
ob.rotation_euler.z += FACE_ROT
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# ноги на z=0, центр по XY
vs = [v.co for v in ob.data.vertices]
mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs))); mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
for v in ob.data.vertices: v.co -= off
H = mx.z - mn.z; W = mx.x - mn.x
print('size', round(W, 3), round(mx.y - mn.y, 3), round(H, 3), 'faces', len(ob.data.polygons))
# матеріал
if GLB:
    # з glb матеріал уже звʼязаний (PBR) — лише зменшуємо його картинки до 1024
    mat = ob.data.materials[0]
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and max(n.image.size) > 1024: n.image.scale(1024, 1024)
else:
    os.makedirs(TEX, exist_ok=True)
    def shrink(name, out, fmt):
        img = bpy.data.images.load(os.path.join(SRC, name)); img.scale(1024, 1024)
        img.filepath_raw = os.path.join(TEX, out); img.file_format = fmt; img.save()
        return bpy.data.images.load(os.path.join(TEX, out))
    dif = shrink('texture_diffuse.png', NAME + '_diffuse.jpg', 'JPEG')
    nor = shrink('texture_normal.png', NAME + '_normal.png', 'PNG')
    rou = shrink('texture_roughness.png', NAME + '_rough.png', 'PNG')
    for im in (nor, rou): im.colorspace_settings.name = 'Non-Color'
    mat = bpy.data.materials.new('HR_Body'); mat.use_nodes = True; nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    t1 = nt.nodes.new('ShaderNodeTexImage'); t1.image = dif; nt.links.new(t1.outputs['Color'], b.inputs['Base Color'])
    t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = rou; nt.links.new(t2.outputs['Color'], b.inputs['Roughness'])
    t3 = nt.nodes.new('ShaderNodeTexImage'); t3.image = nor; nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(t3.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Metallic'].default_value = 0.0
mat.name = NAME + '_Body'
ob.data.materials.clear()
for k in range(8):
    tm = bpy.data.materials.new('PART_%d' % k); ob.data.materials.append(tm)
# шматки для вибуху — частини тіла; межі для кожного персонажа свої (частки висоти z, півширини x, глибини y від переду)
# hat/head — від якої висоти; hx — голова/капелюх лише в межах |x| < hx (плечі й руки поруч не чіпляємо);
# arm — руки збоку, лише між leg і armTop; paper — газета пінгвіна (перед глибини, діапазон висоти)
RULES = {
    'hero':     dict(hat=0.86,  head=0.52, hx=0.50, leg=0.16, arm=0.55, armTop=0.62),   # стилізована версія (велика голова, широкі плечі)
    'egg':      dict(hat=0.77,  head=0.45, hx=0.9,  leg=0.12, arm=0.42, armTop=0.5),
    'penguin2': dict(hat=9.0,   head=0.70, hx=0.9,  leg=0.07, arm=0.55, armTop=0.75, paper=(0.22, 0.15, 0.68)),
}
R = RULES.get(NAME, RULES['hero'])
D = mx.y - mn.y
names = ['Hat', 'Head', 'Body', 'ArmL', 'ArmR', 'LegL', 'LegR', 'Paper']
def region(z, x, y=0.5):
    if z > R['hat'] and abs(x) < R['hx']: return 0
    if 'paper' in R and y < R['paper'][0] and R['paper'][1] < z < R['paper'][2]: return 7
    if z > R['head'] and abs(x) < R['hx']: return 1
    if z < R['leg']: return 5 if x < 0 else 6
    if abs(x) > R['arm'] and z < R['armTop']: return 3 if x < 0 else 4
    return 2
for p in ob.data.polygons:
    c = p.center; p.material_index = region(c.z / H, c.x / (W / 2), (c.y + D / 2) / D); p.use_smooth = True
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='MATERIAL'); bpy.ops.object.mode_set(mode='OBJECT')
parts = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for o in parts:
    used = [m2 for m2 in o.data.materials if m2 and m2.name.startswith('PART_')]
    o.name = NAME + '_' + names[int(used[0].name.split('_')[1].split('.')[0])] if used else NAME + '_Part'
    o.data.materials.clear(); o.data.materials.append(mat)
    for p in o.data.polygons: p.material_index = 0
    for s in bpy.context.selected_objects: s.select_set(False)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')   # шматок крутиться навколо себе
print('parts', sorted(o.name for o in parts))
for o in parts: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True,
                          export_image_format='JPEG' if GLB else 'AUTO')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'blender', 'cashhunt_%s_gen.blend' % NAME))
print('HERO GEN OK', NAME, os.path.getsize(OUT))
