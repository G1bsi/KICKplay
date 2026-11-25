# Іконка плитки режиму «Кейсы»: blender -b blender/dnd_studio.blend --python blender/dnd_icon.py -- public/img/modes/dnd
# (Blender сам допише .webp). Рендерить кейс із dnd_studio.blend ручкою догори, з табличкою «?».
import bpy, math, sys
from mathutils import Vector
sc = bpy.context.scene
keep = {'DND_CaseRig', 'DND_CaseBase', 'DND_CaseLid'}
for o in bpy.data.objects:
    if o.name not in keep: o.hide_render = True
rig = bpy.data.objects['DND_CaseRig']; lid = bpy.data.objects['DND_CaseLid']
rig.rotation_euler = (math.radians(-90), 0, math.radians(180 - 28))   # стоїть ручкою догори, у три чверті
lid.rotation_euler = (-0.22, 0, 0)
# золоте світіння зсередини
m = bpy.data.materials.new('glowin'); m.use_nodes = True
b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
b.inputs['Base Color'].default_value = (1, 0.7, 0.2, 1)
k = 'Emission Color' if 'Emission Color' in b.inputs else 'Emission'
b.inputs[k].default_value = (1, 0.62, 0.15, 1); b.inputs['Emission Strength'].default_value = 9
bpy.ops.mesh.primitive_plane_add(size=1)
pl = bpy.context.active_object; pl.scale = (0.94, 0.66, 1); pl.location = (0, 0, 0.03); pl.parent = rig; pl.data.materials.append(m)
L = bpy.data.objects.new('gl', bpy.data.lights.new('gl', 'POINT')); L.data.energy = 40; L.data.color = (1, 0.75, 0.3); L.parent = rig; L.location = (0, -0.1, 0.07); sc.collection.objects.link(L)
# золота табличка «?» на кришці
gm = bpy.data.materials['DND_Trim']
bpy.ops.object.text_add(); tx = bpy.context.active_object; tx.data.body = '?'; tx.data.align_x = 'CENTER'; tx.data.align_y = 'CENTER'
tx.data.extrude = 0.012; tx.data.size = 0.36; tx.data.materials.append(gm); tx.parent = lid; tx.location = (0, -0.38, 0.122); tx.rotation_euler = (0, 0, math.pi)
dm = bpy.data.materials.new('plate'); dm.use_nodes = True
bd = next(n for n in dm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'); bd.inputs['Base Color'].default_value = (0.03, 0.02, 0.05, 1); bd.inputs['Roughness'].default_value = 0.3
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.2, depth=0.01); pc = bpy.context.active_object; pc.parent = lid; pc.location = (0, -0.38, 0.115); pc.data.materials.append(dm)
bpy.ops.mesh.primitive_torus_add(major_radius=0.205, minor_radius=0.014); tr = bpy.context.active_object; tr.parent = lid; tr.location = (0, -0.38, 0.118); tr.data.materials.append(gm)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 1.42
cam.location = (0.0, -6, 1.4); cam.rotation_euler = (Vector((0, 0, 0.06)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (0.25, 0.22, 0.3, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 0.55
for loc, e, c in (((-3, -4, 4), 420, (1, 0.95, 0.9)), ((4, -2, 2), 140, (0.75, 0.65, 1)), ((0, 3, 4), 160, (1, 1, 1))):
    Lx = bpy.data.objects.new('L', bpy.data.lights.new('L', 'AREA')); Lx.data.energy = e; Lx.data.size = 3; Lx.data.color = c; Lx.location = loc
    Lx.rotation_euler = (Vector((0, 0, 0.3)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); sc.collection.objects.link(Lx)
try: sc.render.engine = 'BLENDER_EEVEE_NEXT'
except TypeError: sc.render.engine = 'BLENDER_EEVEE'
try: sc.eevee.use_bloom = True
except Exception: pass
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 320
sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in bpy.types.ColorManagedViewSettings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
fmts = [i.identifier for i in bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items]
sc.render.image_settings.file_format = 'WEBP' if 'WEBP' in fmts else 'PNG'
sc.render.image_settings.color_mode = 'RGBA'
try: sc.render.image_settings.quality = 90
except Exception: pass
sc.render.filepath = sys.argv[-1]
bpy.ops.render.render(write_still=True)
print('FMT', sc.render.image_settings.file_format)
