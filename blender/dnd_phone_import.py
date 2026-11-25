# «Кейсы» (DnD): телефон банкіра з моделі, яку дав власник.
# Western Electric 500 Vintage Rotary Telephone — автор Skyice (sketchfab.com/vicky12218), ліцензія CC BY 4.0:
# https://sketchfab.com/3d-models/western-electric-500-vintage-rotary-telephone-4425a0d9629c420788cf6b0d072f4564
# Запуск: blender -b --factory-startup --python blender/dnd_phone_import.py -- <шлях до .glb>
# Пише public/models/dnd/phone.glb:
#   DND_Phone2         — корпус (усе, крім трубки), початок координат — центр дна, циферблат дивиться на −Y (до камери);
#   DND_Phone2Handset  — трубка (окремо: трясеться, коли банкір дзвонить), початок — її центр.
# Сітку спрощено (Decimate), текстури — JPEG, щоб файл був легким для сайту.
import bpy, sys, os, math
from mathutils import Vector, Matrix
SRC = sys.argv[sys.argv.index('--') + 1]
OUT = os.path.join(r'D:\KICKplay-main', 'public', 'models', 'dnd', 'phone.glb')
WIDTH = 0.46                      # довжина корпусу (без шнура) на сцені, м — під столик банкіра
TARGET_TRIS = 60000

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
# застосувати всі трансформації (у Sketchfab-ієрархії — поворот і масштаб на батьках)
for o in meshes:
    mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
for o in list(bpy.context.scene.objects):
    if o.type != 'MESH': bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action='SELECT'); bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
hs = next(o for o in meshes if o.name.startswith('Handset_Western'))
dial = next(o for o in meshes if o.name.startswith('Rotary_Dial_Card'))
main = next(o for o in meshes if o.name.startswith('Main_Body'))
def bb(objs):
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    return Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
lo, hi = bb([main]); flo, _ = bb(meshes)
print('BOUNDS body', lo, hi)
# «вгору» — вісь з найменшим розміром серед тих, де ніжки внизу; у Blender після імпорту glTF це Z
c = (lo + hi) / 2
# напрям «вперед» — від трубки до циферблата (горизонтально)
d0 = sum((dial.matrix_world @ Vector(v) for v in dial.bound_box), Vector()) / 8
h0 = sum((hs.matrix_world @ Vector(v) for v in hs.bound_box), Vector()) / 8
fwd = Vector((d0.x - h0.x, d0.y - h0.y, 0)).normalized()
ang = math.atan2(fwd.x, -fwd.y)           # повернути так, щоб fwd → (0, −1)
R = Matrix.Rotation(ang, 4, 'Z')
for o in meshes:
    o.data.transform(Matrix.Translation(-Vector((c.x, c.y, flo.z)))); o.data.transform(R)
lo, hi = bb([main]); s = WIDTH / max(hi.x - lo.x, hi.y - lo.y)
for o in meshes: o.data.transform(Matrix.Scale(s, 4))
lo, hi = bb([main]); flo, fhi = bb(meshes); print('SIZE body', hi - lo, 'all', fhi - flo, 'min z', flo.z)
# спростити сітку
tot = sum(len(o.data.polygons) for o in meshes)
ratio = min(1.0, TARGET_TRIS / max(1, tot)); print('TRIS', tot, 'ratio', round(ratio, 3))
for o in meshes:
    if len(o.data.polygons) > 400 and ratio < 1:
        m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = ratio
        bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier='dec')
# корпус — одним обʼєктом; трубка — окремо, з початком координат у центрі
body = [o for o in meshes if o is not hs]
bpy.ops.object.select_all(action='DESELECT')
for o in body: o.select_set(True)
bpy.context.view_layer.objects.active = body[0]; bpy.ops.object.join()
bodyo = bpy.context.view_layer.objects.active; bodyo.name = 'DND_Phone2'
bpy.context.view_layer.update()
hc = sum((hs.matrix_world @ Vector(v) for v in hs.bound_box), Vector()) / 8
hs.data.transform(Matrix.Translation(-hc)); hs.location = hc; hs.name = 'DND_Phone2Handset'; hs.parent = bodyo
print('HANDSET at', hc, 'tris', sum(len(o.data.polygons) for o in (bodyo, hs)))
bpy.ops.object.select_all(action='SELECT')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
kw = dict(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False, export_yup=True, export_apply=True)
try: bpy.ops.export_scene.gltf(export_image_format='JPEG', export_jpeg_quality=85, **kw)
except TypeError: bpy.ops.export_scene.gltf(export_image_format='JPEG', **kw)
print('PHONE OK', os.path.getsize(OUT))
