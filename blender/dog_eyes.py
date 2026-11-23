# Перемальовує очі пса (Cash Hunt) у diffuse-текстурі згенерованої моделі: кожен тексель зони очей → точка
# на моделі через UV-трикутники → око малюється у фронтальних координатах (x, z): обидва однакові й дивляться вперед.
# blender -b --factory-startup --python blender/dog_eyes.py -- <папка з base.obj> <нова папка> 0.138 1.462 0.062 0.05
# потім: blender -b --factory-startup --python blender/hero_import.py -- <нова папка> dog
import bpy, sys, os, shutil
import numpy as np
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
src, dst = a[0], a[1]
EX, EZ, RX, RZ = (float(v) for v in a[2:6])
LOOK = float(a[6]) if len(a) > 6 else 0.12          # зіниці трохи до носа — погляд «на глядача»
os.makedirs(dst, exist_ok=True)
for f in os.listdir(src):
    if f != 'texture_diffuse.png': shutil.copy(os.path.join(src, f), os.path.join(dst, f))

for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.wm.obj_import(filepath=os.path.join(src, 'base.obj'))
ob = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
me = ob.data; me.calc_loop_triangles()
mw = ob.matrix_world
nv = len(me.vertices); co = np.empty(nv * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
M = np.array(mw, dtype=np.float32); co = co @ M[:3, :3].T + M[:3, 3]
nt = len(me.loop_triangles)
tv = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('vertices', tv); tv = tv.reshape(-1, 3)
tl = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('loops', tl); tl = tl.reshape(-1, 3)
uvl = me.uv_layers.active.data; uv = np.empty(len(uvl) * 2, np.float32); uvl.foreach_get('uv', uv); uv = uv.reshape(-1, 2)

img = bpy.data.images.load(os.path.join(src, 'texture_diffuse.png'))
W, H = img.size
px = np.empty(W * H * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(H, W, 4)

P = co[tv]                       # (nt, 3, 3) — 3D вершини трикутників
C = P.mean(1); N = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
front = N[:, 1] < 0              # дивиться в −Y (уперед)
def srgb2lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
painted = 0
for side in (-1, 1):
    ex = EX * side
    sel = np.where(front & (np.abs(C[:, 0] - ex) < RX * 1.6) & (np.abs(C[:, 2] - EZ) < RZ * 1.6))[0]
    # у тексельній сітці: тексель → (x, z) на моделі
    X = np.full((H, W), np.nan, np.float32); Z = np.full((H, W), np.nan, np.float32)
    for t in sel:
        U = uv[tl[t]] * [W, H]; p3 = P[t]
        x0, y0 = np.floor(U.min(0)).astype(int); x1, y1 = np.ceil(U.max(0)).astype(int)
        x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, W - 1); y1 = min(y1, H - 1)
        if x1 < x0 or y1 < y0: continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = U
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9: continue
        l1 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / d
        l2 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / d
        l3 = 1 - l1 - l2
        m = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        if not m.any(): continue
        xs = l1 * p3[0, 0] + l2 * p3[1, 0] + l3 * p3[2, 0]
        zs = l1 * p3[0, 2] + l2 * p3[1, 2] + l3 * p3[2, 2]
        sub = (slice(y0, y1 + 1), slice(x0, x1 + 1))
        X[sub] = np.where(m, xs, X[sub]); Z[sub] = np.where(m, zs, Z[sub])
    ok = ~np.isnan(X)
    u = (X - ex) / RX; v = (Z - EZ) / RZ
    e = np.sqrt(u * u + v * v)
    ss = lambda a0, a1, x: np.clip((x - a0) / (a1 - a0), 0, 1) ** 2 * (3 - 2 * np.clip((x - a0) / (a1 - a0), 0, 1))
    # склера: біла, зверху — тінь від повіки
    scl = np.stack([0.97, 0.955, 0.93], 0)[None, None, :] * (1 - 0.28 * ss(0.1, 1.0, v))[..., None]
    col = scl.copy()
    # райдужка + зрачок (центр трохи нижче середини і трохи до носа)
    ix, iz = -side * LOOK, -0.08
    r = np.sqrt(((u - ix) * RX / RZ) ** 2 + (v - iz) ** 2)          # у одиницях RZ — коло на моделі
    IR, PR = 0.62, 0.33
    iris = np.stack([0.40, 0.22, 0.09], 0)[None, None, :] * (0.65 + 0.55 * (r / IR))[..., None]
    iris = np.minimum(iris, 1)
    col = np.where((r < IR)[..., None], iris, col)
    col = np.where((r < IR)[..., None] & (r > IR - 0.07)[..., None], col * 0.45, col)     # темний обідок райдужки
    col = np.where((r < PR)[..., None], np.array([0.03, 0.025, 0.02])[None, None, :], col)
    # відблиски
    hl = np.sqrt(((u - ix + 0.20 * RZ / RX) * RX / RZ) ** 2 + (v - iz - 0.22) ** 2)
    col = np.where((hl < 0.14)[..., None], np.array([1.0, 1.0, 1.0])[None, None, :], col)
    hl2 = np.sqrt(((u - ix - 0.18 * RZ / RX) * RX / RZ) ** 2 + (v - iz + 0.2) ** 2)
    col = np.where((hl2 < 0.06)[..., None], np.array([0.95, 0.95, 0.95])[None, None, :], col)
    # контур ока (темна лінія повік) і м'який край
    rim = ss(0.86, 0.97, e)
    col = col * (1 - rim[..., None]) + np.array([0.10, 0.06, 0.045])[None, None, :] * rim[..., None]
    alpha = 1 - ss(1.0, 1.08, e)
    m3 = (ok & (alpha > 0))[..., None]
    lin = srgb2lin(np.clip(col, 0, 1))            # pixels у Blender для PNG — sRGB-значення як є; лишаємо col (вже sRGB)
    new = px[..., :3] * (1 - alpha[..., None]) + col * alpha[..., None]
    px[..., :3] = np.where(m3, new, px[..., :3])
    painted += int(m3.sum())
    print('eye', side, 'tris', len(sel), 'texels', int(m3.sum()))
out = bpy.data.images.new('dif', W, H, alpha=True)
out.pixels.foreach_set(px.ravel()); out.filepath_raw = os.path.join(dst, 'texture_diffuse.png'); out.file_format = 'PNG'; out.save()
print('EYES OK', painted)
