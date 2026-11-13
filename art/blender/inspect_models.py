"""
Renders four views (front -Y, right +X, back +Y, left -X) of selected models and lists their meshes.
Run in Blender with NAMES = [...] defined first (e.g. ["furniture/office_chair"]). Output: .tmp/thumbs/views_<name>.png + mesh list in result.
"""

import math
import os

import bpy
from mathutils import Vector

PROJECT = r"C:\Users\Strikeout\Projects\Claw-Empire-Claude"
SRC = os.path.join(PROJECT, "Downloaded-Models")
THUMBS = os.path.join(PROJECT, ".tmp", "thumbs")
scene = bpy.data.scenes["ATLAS_Staging"]
bpy.context.window.scene = scene
cam = scene.objects["ThumbCam"]
for obj in list(scene.objects):
    if obj.name not in ("ThumbCam", "ThumbSun"):
        bpy.data.objects.remove(obj, do_unlink=True)

info = {}
for name in NAMES:  # noqa: F821  (defined by the caller)
    before = set(bpy.data.objects)
    # NAMES are "<category>/<file name without .glb>", e.g. "furniture/office_chair".
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, name + ".glb"))
    objs = [o for o in bpy.data.objects if o not in before]
    meshes = []
    pts = []
    for o in objs:
        if o.type != "MESH":
            continue
        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
        lo = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
        hi = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
        size = hi - lo
        meshes.append([o.name, [round(v, 3) for v in size], len(o.data.polygons)])
        pts += corners
    # Frame on the median-sized meshes so a giant ground plane does not shrink the view.
    sizes = sorted(m[1][0] * m[1][1] for m in meshes)
    limit = sizes[len(sizes) // 2] * 50 if sizes else 0
    framing = []
    for o in objs:
        if o.type == "MESH":
            c = [o.matrix_world @ Vector(v) for v in o.bound_box]
            sx = max(p.x for p in c) - min(p.x for p in c)
            sy = max(p.y for p in c) - min(p.y for p in c)
            if sx * sy <= limit or len(meshes) == 1:
                framing += c
            else:
                o.hide_render = True
    lo = Vector((min(p.x for p in framing), min(p.y for p in framing), min(p.z for p in framing)))
    hi = Vector((max(p.x for p in framing), max(p.y for p in framing), max(p.z for p in framing)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.05)
    dist = radius / math.tan(cam.data.angle / 2) * 1.1
    cam.data.clip_end = dist * 4
    frames = []
    for i, (label, direction) in enumerate((("front", (0, -1)), ("right", (1, 0)), ("back", (0, 1)), ("left", (-1, 0)))):
        cam.location = center + Vector((direction[0] * dist * 0.94, direction[1] * dist * 0.94, dist * 0.34))
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(THUMBS, f"_view_{name}_{i}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        frames.append(path)
    info[name] = meshes[:12]
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)

result = info
